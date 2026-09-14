// TriviaGameAi — host-controlled trivia over a local network.
// Host device runs this server + opens /host; players scan a QR code to join /.
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { Server as SocketIOServer } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'trivia_latest.json');
const PORT = Number(process.env.PORT || 8090);

// ---------------------------------------------------------------------------
// Question loading & normalization
// ---------------------------------------------------------------------------
function stripPrefix(s) {
  return String(s).replace(/^\s*[a-d]\s*[\)\.\-:]\s*/i, '').trim();
}
function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/^[a-d]\s*[\)\.\-:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse choices embedded in the question text when no explicit options exist,
// e.g. "Was it a) Toyota b) Chrysler c) Ford or d) General Motors"
function parseEmbeddedOptions(text) {
  const re = /(^|[\s:.])([a-d])\)\s*/gi;
  const matches = [...text.matchAll(re)];
  if (matches.length < 2) return null;
  const options = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).replace(/^or\s+/i, '').trim();
    if (body) options.push(body);
  }
  if (options.length < 2) return null;
  const stem = text.slice(0, matches[0].index).replace(/[\s:.]+$/, '').trim() || text;
  return { stem, options };
}

function optionMatchesAnswer(optNorm, ansNorm, idx, correctIndex) {
  if (!optNorm || !ansNorm) return false;
  if (optNorm === ansNorm) return true;
  if (optNorm.length >= 3 && ansNorm.length >= 3 &&
      (ansNorm.startsWith(optNorm) || optNorm.startsWith(ansNorm))) return true;
  return idx === correctIndex;
}

function normalizeQuestion(raw, id) {
  let text = String(raw.question ?? '').trim();
  let options = (raw.options || []).map((o) => ({ raw: o, norm: normalizeText(o), label: stripPrefix(o) }));
  if (!options.length) {
    const parsed = parseEmbeddedOptions(text);
    if (parsed) {
      text = parsed.stem;
      options = parsed.options.map((o) => ({ raw: o, norm: normalizeText(o), label: o }));
    }
  }
  const answerRaw = String(raw.answer ?? '').trim();
  const ansNorm = normalizeText(answerRaw);

  // Precompute which option (if any) is the correct one.
  let correctIndex = -1;
  if (options.length >= 2 && ansNorm) {
    correctIndex = options.findIndex((o, i) => optionMatchesAnswer(o.norm, ansNorm, i, -1));
    if (correctIndex === -1) {
      // Fallback: match by leading letter ("b) Birds" -> option b)
      const m = answerRaw.match(/^\s*([a-d])\s*\)/i);
      if (m) {
        correctIndex = options.findIndex((o) => {
          const lm = o.raw.match(/^\s*([a-d])\s*\)/i);
          return lm && lm[1].toLowerCase() === m[1];
        });
      }
    }
  }

  return {
    id,
    category: Array.isArray(raw.category) ? raw.category.join(', ') : String(raw.category ?? ''),
    text,
    options,
    answerRaw,
    correctIndex,
    isMultipleChoice: options.length >= 2 && correctIndex >= 0,
  };
}

let QUESTIONS = [];
try {
  const data = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  QUESTIONS = (data.questions || []).map((q, i) => normalizeQuestion(q, i));
  console.log(`Loaded ${QUESTIONS.length} questions from ${QUESTIONS_FILE}`);
} catch (err) {
  console.error('Failed to load questions:', err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  phase: 'lobby', // lobby | question | reveal | roundEnd | ended
  totalRounds: 4,
  questionsPerRound: 4,
  gameQuestions: [],
  qIndex: -1,
  players: new Map(), // id -> {id, name, normName, score, socketId|null, answered, answer, correct, wager}
};

function totalQuestionCount() { return state.totalRounds * state.questionsPerRound; }
// Which round (1-based) a global question index falls in.
function roundOf(qi) { return Math.floor(qi / state.questionsPerRound) + 1; }

// Wager chips available for a given round: odd rounds use 1–4, even rounds
// (2, 4, …) use 2/4/6/8. The final question is special — see buildState.
function wagerOptionsForRound(rnd) {
  return rnd % 2 === 0 ? [2, 4, 6, 8] : [1, 2, 3, 4];
}

// Per-ROUND chip pool: each player may use every offered chip value at most
// ONCE PER ROUND — whether they answer correctly or not. The pool resets at
// the start of every new round, so a chip spent in round 1 is available again
// in round 2 (and vice versa). It also resets when a new game starts.
let wagersUsed = {}; // { [playerId]: { round: number|null, used: Set } }

function currentRoundForChips() {
  if (finalQuestion) return null; // no chips on the final question
  if (state.qIndex < 0) return null;
  return roundOf(state.qIndex);
}

// The set of chip values a player has already spent in the CURRENT round.
function usedChipsFor(p, rnd) {
  const rec = wagersUsed[p.id];
  if (!rec || rec.round !== rnd) return new Set(); // fresh pool for this round
  return rec.used;
}

// Record that a player spent chip `w` in round `rnd`.
function markChipSpent(p, w, rnd) {
  let rec = wagersUsed[p.id];
  if (!rec || rec.round !== rnd) { rec = { round: rnd, used: new Set() }; wagersUsed[p.id] = rec; }
  rec.used.add(w);
}

function currentWagerOptions() {
  if (finalQuestion) return null;
  if (state.qIndex < 0) return null;
  return wagerOptionsForRound(roundOf(state.qIndex));
}

// The final question, played after all rounds: each player may wager any whole
// number of points from 0 up to their current score (double-or-nothing style).
let finalQuestion = null; // normalized question object or null

function activeQuestion() {
  if (finalQuestion) return finalQuestion;
  return state.qIndex >= 0 ? state.gameQuestions[state.qIndex] : null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function checkCorrectness(q, p) {
  if (typeof p.answer === 'number') {
    // Player picked an option button.
    const idx = p.answer;
    if (idx < 0 || idx >= q.options.length) return false;
    return optionMatchesAnswer(q.options[idx].norm, normalizeText(q.answerRaw), idx, q.correctIndex);
  }
  // Free-text answer.
  const ans = normalizeText(q.answerRaw);
  const given = normalizeText(p.answer);
  if (!ans || !given) return false;
  if (ans === given) return true;
  if (ans.length >= 8 && given.length >= 8 && (ans.includes(given) || given.includes(ans))) return true;
  return false;
}

function resetQuestionFlags() {
  for (const p of state.players.values()) {
    p.answered = false;
    p.answer = null;
    p.correct = null;
    p.wager = null; // points wagered on the current question
  }
}

// The chip list to expose for a player: chips spent in the CURRENT round, or
// an empty list on the final question / outside a game.
function wagerStateFor(p) {
  const rnd = currentRoundForChips();
  if (!rnd) return [];
  return [...usedChipsFor(p, rnd)];
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

const lanIp = getLanIp();
const joinUrl = `http://${lanIp}:${PORT}/`;
let qrDataUrl = '';
try {
  qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 560, margin: 2 });
} catch (err) {
  console.error('QR generation failed:', err.message);
}

app.get('/qr.png', async (req, res) => {
  try {
    const buf = await QRCode.toBuffer(joinUrl, { width: 800, margin: 2 });
    res.type('png').send(buf);
  } catch (err) {
    res.status(500).send('QR error');
  }
});

const server = http.createServer(app);
const io = new SocketIOServer(server);
const liveSockets = new Set(); // sockets currently connected (any role)

io.use((socket, next) => {
  socket.data.role = socket.handshake.query.role === 'host' ? 'host' : 'player';
  next();
});

function buildState(role) {
  const q = activeQuestion();
  const isHost = role === 'host';
  const showAnswer = isHost || state.phase === 'reveal' || state.phase === 'ended';
  // Final question: PLAYERS see the category + wager input first; the actual
  // question text/options are hidden from them until EVERY player has set a
  // wager. The host always sees the full question so they can run the game.
  const allWagered = finalQuestion && state.players.size > 0 &&
    [...state.players.values()].every((p) => p.wager != null);
  const hideFinalText = !isHost && !!finalQuestion && state.phase === 'question' && !allWagered;
  return {
    phase: state.phase,
    totalRounds: state.totalRounds,
    questionsPerRound: state.questionsPerRound,
    currentRound: finalQuestion ? state.totalRounds : (state.qIndex >= 0 ? roundOf(state.qIndex) : 0),
    questionInRound: finalQuestion ? state.questionsPerRound + 1 : (state.qIndex >= 0 ? (state.qIndex % state.questionsPerRound) + 1 : 0),
    isFinal: !!finalQuestion,
    questionNumber: finalQuestion ? totalQuestionCount() + 1 : state.qIndex + 1,
    totalQuestions: totalQuestionCount(),
    wagerOptions: currentWagerOptions(),
    finalWagerOpen: !!finalQuestion && state.phase === 'question', // players may set their stake now
    joinUrl,
    qrDataUrl,
    question: q ? {
      id: q.id,
      category: q.category,
      text: hideFinalText ? '' : q.text,
      options: hideFinalText ? [] : q.options.map((o) => o.label),
      correctIndex: showAnswer ? q.correctIndex : -1,
      answerRaw: showAnswer ? q.answerRaw : undefined,
      isMultipleChoice: hideFinalText ? false : q.isMultipleChoice,
    } : null,
    players: [...state.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        online: !!p.socketId,
        answered: state.phase === 'question' ? p.answered : undefined,
        wager: (state.phase === 'question' || state.phase === 'reveal') ? p.wager : undefined,
        wagersUsed: wagerStateFor(p), // chips already spent in the current round
        correct: (isHost || state.phase === 'reveal') && p.correct !== null ? p.correct : undefined,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}

function broadcastState() {
  for (const socket of liveSockets) {
    const role = socket.data.role;
    if (role === 'player' && !socket.data.joined) continue; // not joined yet
    socket.emit('state', buildState(role));
  }
}

io.on('connection', (socket) => {
  liveSockets.add(socket);
  console.log(`[${socket.data.role}] connected: ${socket.id}`);

  if (socket.data.role === 'host') {
    socket.emit('state', buildState('host'));
  } else {
    // Player: wait for join event.
    socket.on('join', ({ name }) => {
      const clean = String(name ?? '').trim().slice(0, 24);
      if (!clean) return;
      const normName = normalizeText(clean);

      // Re-adopt an existing identity (same team name, no live socket).
      let adopted = null;
      for (const p of state.players.values()) {
        if (p.normName === normName && !p.socketId) { adopted = p; break; }
      }
      if (adopted) {
        adopted.socketId = socket.id;
        // Fresh per-question state on (re)join.
        adopted.answered = false;
        adopted.answer = null;
        adopted.correct = null;
        adopted.wager = null;
        socket.data.playerId = adopted.id;
      } else {
        const id = socket.id;
        state.players.set(id, {
          id, name: clean, normName, score: 0, socketId: socket.id,
          answered: false, answer: null, correct: null, wager: null,
        });
        socket.data.playerId = id;
      }
      socket.data.joined = true;
      const pid = state.players.get(socket.data.playerId).id;
      console.log(`Player joined: ${clean} (score ${state.players.get(pid).score})`);
      socket.emit('joined', { playerId: pid });
      broadcastState();
    });

    socket.on('answer', ({ value }) => {
      const p = state.players.get(socket.data.playerId);
      if (!p || state.phase !== 'question' || p.answered) return;
      const q = activeQuestion();
      if (!q) return;
      if (typeof value === 'number') {
        if (value < 0 || value >= q.options.length) return;
        p.answer = Math.floor(value);
      } else {
        const text = String(value ?? '').trim().slice(0, 300);
        if (!text) return;
        p.answer = text;
      }
      p.answered = true;
      broadcastState();
    });

    socket.on('setWager', ({ points }) => {
      const p = state.players.get(socket.data.playerId);
      if (!p || state.phase !== 'question') return;
      const w = Math.floor(Number(points));
      // Final question: any whole number from 0 up to the player's score.
      if (finalQuestion) {
        if (w < 0 || w > p.score) return;
        p.wager = w;
        broadcastState();
        return;
      }
      const rnd = currentRoundForChips();
      if (!rnd) return;
      const opts = wagerOptionsForRound(rnd);
      if (!opts.includes(w)) return;
      // Each chip value can only be used ONCE PER ROUND — whether the answer was
      // right or wrong, a spent chip stays spent for that round. (You may still
      // change your pick freely within the current question.)
      if (usedChipsFor(p, rnd).has(w) && p.wager !== w) return;
      p.wager = w;
      broadcastState();
    });
  }

  // Host controls.
  socket.on('startGame', ({ rounds = 4, perRound = 4, shuffleOn = true, keepScores = false }) => {
    const r = Math.max(1, Math.min(Number(rounds) || 4, 20));
    const qpr = Math.max(1, Math.min(Number(perRound) || 4, QUESTIONS.length));
    state.totalRounds = r;
    state.questionsPerRound = qpr;
    if (!keepScores) for (const p of state.players.values()) p.score = 0;
    wagersUsed = {}; // fresh chip pools — every round of the new game starts clean
    const need = Math.min(r * qpr, QUESTIONS.length);
    const pool = shuffleOn ? shuffle(QUESTIONS) : [...QUESTIONS];
    state.gameQuestions = pool.slice(0, need);
    finalQuestion = null; // picked again after the last round
    state.qIndex = 0;
    resetQuestionFlags();
    state.phase = 'question';
    console.log(`Game started: ${r} rounds x ${qpr} questions (${need} total)`);
    broadcastState();
  });

  socket.on('reveal', () => {
    if (state.phase !== 'question') return;
    const q = activeQuestion();
    for (const p of state.players.values()) {
      // A wager is REQUIRED to play a question: no stake set -> the question
      // is forfeited, nothing at risk either way.
      if (p.wager == null) continue;
      if (!p.answered) { p.correct = false; continue; }
      const w = p.wager;
      p.correct = checkCorrectness(q, p);
      if (finalQuestion) {
        // Final question: correct -> +wager, wrong -> -wager.
        // No answer submitted = no points at stake either way.
        if (w != null && w > 0) p.score += p.correct ? w : -w;
      } else if (w != null) {
        // Rounds: correct -> +wager, wrong -> no penalty. The wagered chip is
        // spent either way — right or wrong answer locks it in for this round.
        const rnd = currentRoundForChips();
        if (rnd) markChipSpent(p, w, rnd);
        if (p.correct) p.score += w;
      }
    }
    state.phase = 'reveal';
    broadcastState();
  });

  socket.on('nextQuestion', () => advance());

  // After all regular rounds, one final question: each player may wager any
  // whole number of points from 0 up to their current score. Correct doubles
  // the stake into their total; wrong loses it (double-or-nothing).
  function startFinalQuestion() {
    const usedIds = new Set(state.gameQuestions.map((q) => q.id));
    const candidates = QUESTIONS.filter((q) => !usedIds.has(q.id));
    finalQuestion = (candidates.length ? shuffle(candidates) : shuffle(QUESTIONS))[0];
    state.qIndex = totalQuestionCount() - 1; // last regular index; advance() ends the game from here
    resetQuestionFlags();
    state.phase = 'question';
    console.log('Final question — players may wager up to their score!');
    broadcastState();
  }

  // Advance to the next question, or pause at a round boundary / start the final question.
  function advance() {
    if (state.phase !== 'question' && state.phase !== 'reveal') return;
    const total = totalQuestionCount();
    // The final question is always last — after it the game ends.
    if (finalQuestion) { endGame(); return; }
    const nextIdx = state.qIndex + 1;
    if (nextIdx >= total) {
      startFinalQuestion();
      return;
    }
    // Crossing into a new round?
    if (nextIdx % state.questionsPerRound === 0) {
      const finishedRound = Math.floor(state.qIndex / state.questionsPerRound) + 1;
      // Round 2 starts automatically — no host pause needed.
      if (finishedRound === 1) {
        state.qIndex = nextIdx;
        resetQuestionFlags();
        state.phase = 'question';
        console.log(`Auto-advancing to round ${roundOf(state.qIndex)}`);
        broadcastState();
        return;
      }
      // Any other boundary: pause so the host can start it.
      state.phase = 'roundEnd';
      console.log(`Round ${roundOf(state.qIndex)} complete — awaiting next round`);
      broadcastState();
      return;
    }
    state.qIndex = nextIdx;
    resetQuestionFlags();
    state.phase = 'question';
    broadcastState();
  }

  socket.on('startNextRound', () => {
    if (state.phase !== 'roundEnd') return;
    const total = totalQuestionCount();
    // After the last regular round, this button starts the final question.
    if (state.qIndex + 1 >= total) { startFinalQuestion(); return; }
    state.qIndex += 1; // first question of the new round
    resetQuestionFlags();
    state.phase = 'question';
    console.log(`Round ${roundOf(state.qIndex)} started`);
    broadcastState();
  });

  socket.on('skipQuestion', () => {
    if (state.phase !== 'question' && state.phase !== 'reveal') return;
    // Advance without revealing/awarding — same round-boundary rules.
    advance();
  });

  socket.on('awardPoints', ({ playerId, points }) => {
    const p = state.players.get(playerId);
    if (!p) return;
    const pts = Math.max(-1000, Math.min(1000, Number(points) || 0));
    if (pts === 0) return;
    p.score += pts;
    console.log(`Manual ${pts > 0 ? '+' : ''}${pts} to ${p.name}`);
    broadcastState();
  });

  socket.on('endGame', () => endGame());

  function endGame() {
    state.phase = 'ended';
    broadcastState();
  }

  socket.on('disconnect', () => {
    liveSockets.delete(socket);
    const p = state.players.get(socket.data.playerId);
    if (p) p.socketId = null; // identity + score preserved for rejoin
    console.log(`[${socket.data.role}] disconnected: ${socket.id}`);
    broadcastState();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('────────────────────────────────────────────');
  console.log(`TriviaGameAi running`);
  console.log(`  Host page : http://${lanIp}:${PORT}/host`);
  console.log(`  Players   : ${joinUrl}  (QR at /qr.png)`);
  console.log('────────────────────────────────────────────');
});
