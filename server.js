// AiTriviaGame — host-controlled trivia over the internet (Cloudflare Tunnel).
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
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'trivia_sorted_categories.json');
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
// Categories — the host picks which ones a game draws from. The JSON file has
// inconsistent casing ("music" vs "Music"), so we normalize each label and
// group variants under one canonical name (first-seen spelling wins).
// ---------------------------------------------------------------------------
function normCat(s) { return String(s ?? '').trim().toLowerCase(); }

const CATEGORIES = []; // [{ name, count }] — display order: first appearance in file
{
  const seen = new Map(); // normalized -> index into CATEGORIES
  for (const q of QUESTIONS) {
    const key = normCat(q.category);
    if (!key) continue;
    let idx = seen.get(key);
    if (idx === undefined) {
      idx = CATEGORIES.length;
      seen.set(key, idx);
      CATEGORIES.push({ name: q.category.trim(), count: 0 });
    }
    CATEGORIES[idx].count += 1;
  }
}

// True when a question's category is among the host's selected categories.
function inSelectedCategories(q) {
  if (!state.selectedCategories.length) return true; // nothing selected = all
  const key = normCat(q.category);
  return state.selectedCategories.some((c) => normCat(c) === key);
}

// The questions a game may draw from, given the host's category selection.
function poolForSelected() {
  if (!state.selectedCategories.length) return QUESTIONS;
  return QUESTIONS.filter(inSelectedCategories);
}

// ---------------------------------------------------------------------------
// Game format — FIXED, not host-configurable: 4 rounds of 4 questions, then a
// final double-or-nothing question. The host only chooses which CATEGORIES the
// game draws from; the structure never changes.
// ---------------------------------------------------------------------------
const ROUNDS = 4;
const QUESTIONS_PER_ROUND = 4;
const TOTAL_QUESTIONS = ROUNDS * QUESTIONS_PER_ROUND; // 16 regular questions

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  phase: 'lobby', // lobby | question | finalWagering | reveal | roundIntro | roundEnd | ended
  totalRounds: ROUNDS,
  questionsPerRound: QUESTIONS_PER_ROUND,
  title: '', // host-set venue/game name — shown at the top of every player page
  selectedCategories: [], // host's category picks; empty = all categories
  gameQuestions: [],
  qIndex: -1,
  introRound: null, // which round the current "roundIntro" screen is announcing
  players: new Map(), // id -> {id, name, normName, score, socketId|null, answered, answer, correct, wager}
};

function totalQuestionCount() { return TOTAL_QUESTIONS; }
// Which round (1-based) a global question index falls in.
function roundOf(qi) { return Math.floor(qi / state.questionsPerRound) + 1; }

// The categories of the questions coming up in round `rnd` (1-based), in play
// order — shown on the "upcoming round" screen so everyone knows what's next.
function upcomingCategories(rnd) {
  return questionsInRound(rnd).map((q) => q.category);
}

// The questions belonging to round `rnd` (1-based) — the round rnd is however
// many questions the builder actually managed to place (4 unless the pool ran dry).
function questionsInRound(rnd) {
  if (rnd < 1) return [];
  const start = (rnd - 1) * state.questionsPerRound;
  return state.gameQuestions.slice(start, start + state.questionsPerRound);
}

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

// Song-artist bonus guesses: players may submit a guess (max 30 chars) on any
// question — it's their shot at naming the artist of the song playing in the
// venue between questions. The host sees it next to their name and MUST judge
// every pending guess ("correct" / "missed") before the answer can be revealed;
// correct adds +1 point, missed does not (independent of the main question).
let bonusGuesses = {}; // { [playerId]: string } for the CURRENT question only
// The host's verdict on each pending guess — shown to that player as a
// confirmation ("You got the song artist right!" / "Sorry, you missed it").
// Stored as { result: 'correct'|'missed', guess } so the host can see what was
// judged after the fact too.
let bonusResults = {}; // { [playerId]: { result, guess } } for the CURRENT question

// Every still-unjudged song-artist guess, with the player it belongs to. The
// host must clear this list before the current answer can be revealed.
function bonusPending() {
  const out = [];
  for (const [pid, guess] of Object.entries(bonusGuesses)) {
    const p = state.players.get(pid);
    if (p) out.push({ id: pid, name: p.name, guess });
  }
  return out;
}

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

// Unused questions left over from the build — the refill pool for skips. A
// skipped question is replaced by one of these so the game keeps its full
// length (4 rounds x 4 questions) no matter how many are skipped.
let spareQuestions = [];
// Questions dropped by skips this game — excluded when drawing the final
// question, so a bad/duplicate question never comes back as the finale.
let skippedIds = new Set();

// ---------------------------------------------------------------------------
// Round helpers — the game is built up front as 4 rounds x 4 questions, but a
// thin category selection can leave a round short (or empty). These keep the
// "where in the game am I" math honest in that case.
// ---------------------------------------------------------------------------
// How many questions the game actually has — normally 16, fewer only when the
// selected category pool runs dry mid-build.
function gameLength() { return state.gameQuestions.length; }

// The next question index after the current one, skipping past any round that
// ended up empty (can happen in a short game).
function nextIdx() {
  let i = state.qIndex + 1;
  while (i < state.gameQuestions.length && questionsInRound(roundOf(i)).length === 0) i++;
  return i;
}

// The last question index an announced round occupies — 0 when the round is
// empty (short game), so a stale intro screen can't rewind the game.
function firstIdxOfRound(rnd) {
  const start = (rnd - 1) * state.questionsPerRound;
  return Math.min(Math.max(start, 0), Math.max(state.gameQuestions.length - 1, 0));
}

function assertRoundFits() {
  if (gameLength() < totalQuestionCount()) {
    console.warn(`Short game: ${gameLength()} of ${totalQuestionCount()} questions placed — selected categories ran out of questions`);
  }
}

// Show the "Round N" message screen (announces the chips the round offers).
function startRoundIntro(round, finishedRound) {
  state.introRound = round;
  state.phase = 'roundIntro';
  console.log(finishedRound
    ? `Round ${finishedRound} complete — showing intro for round ${round}`
    : `Showing intro for round ${round}`);
  broadcastState();
}

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
  bonusGuesses = {}; // song-artist guesses are per-question only
  bonusResults = {}; // and so are the host's verdicts on them
}

// Host skips the current question WITHOUT revealing its answer (e.g. it's a
// duplicate or just bad). The skipped question is spliced out of
// state.gameQuestions and REPLACED by one drawn from spareQuestions (the pool
// of unused questions left over from the build), so we stay at the SAME qIndex
// with a fresh question in this slot. Because every displayed counter is
// derived from qIndex, none of them move — the round/question number stays put
// until an answer is actually revealed. If no spare remains (the pool ran dry)
// the game simply gets shorter by one, exactly like a short build. Per-question
// flags are reset first so no stale answers/wagers/song-guesses carry over onto
// the fresh question that now occupies this slot. No chip is spent (chips are
// only marked in the reveal handler), so nothing is scored.
function skipCurrentQuestion() {
  if (state.qIndex < 0 || state.qIndex >= state.gameQuestions.length) return;
  resetQuestionFlags(); // wipe answers/wagers/song-guesses for this slot
  const skipped = state.gameQuestions[state.qIndex];
  state.gameQuestions.splice(state.qIndex, 1); // drop it
  skippedIds.add(skipped.id); // never re-draw this one as the final question
  if (spareQuestions.length) {
    // Refill the slot so the game keeps its full length.
    state.gameQuestions.splice(state.qIndex, 0, spareQuestions.pop());
    console.log(`Skipped a question (not counted) — replaced with a fresh one; qIndex stays at ${state.qIndex}`);
  } else {
    // No spares left: the game shrinks by one and later questions slide up.
    console.log(`Skipped a question (no spare left to replace it) — game is now ${gameLength()} questions`);
  }
}

// The chip list to expose for a player: chips spent in the CURRENT round, or
// an empty list outside a round (lobby, final question, game over) — otherwise
// stale chips would read back as "already staked" on the final question.
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
app.get('/qr', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr.html')));

// Full reset — wipes the game AND every player, exactly like restarting the
// service. Called by the host's "Restart game" buttons.
function fullReset() {
  state.players.clear();
  wagersUsed = {}; // fresh chip pools
  bonusGuesses = {}; // no pending song-artist guesses
  spareQuestions = []; // no refill pool until the next build
  skippedIds = new Set(); // no skipped questions to exclude from the finale
  state.gameQuestions = [];
  finalQuestion = null;
  state.qIndex = -1;
  state.introRound = null;
  state.selectedCategories = []; // back to "all categories" like a fresh boot
  state.totalRounds = 4; // back to the defaults a fresh boot starts with
  state.questionsPerRound = 4;
  resetQuestionFlags();
  state.phase = 'lobby';
  // Kick every live player back to the join screen, then detach them: they
  // no longer exist, so stop sending them states. (A refresh auto-rejoins.)
  for (const s of liveSockets) {
    if (s.data.role === 'player') {
      s.emit('resetAll');
      s.data.joined = false;
      delete s.data.playerId;
    }
  }
  console.log('Full reset — game and all players cleared');
}

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
// When PUBLIC_URL is set (e.g. https://mybox.ts.net), the join URL / QR use it,
// so players on other networks can reach the game through Tailscale serve/funnel.
const publicUrl = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/+$/, '') : null;
const joinUrl = publicUrl ? `${publicUrl}/` : `http://${lanIp}:${PORT}/`;
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

// Small JSON endpoint so the /qr popup page can show the join URL as text.
app.get('/join-info', (req, res) => {
  res.json({ joinUrl });
});

const server = http.createServer(app);
const io = new SocketIOServer(server);
const liveSockets = new Set(); // sockets currently connected (any role)

io.use((socket, next) => {
  socket.data.role = socket.handshake.query.role === 'host' ? 'host' : 'player';
  next();
});

function buildState(role, playerId = null) {
  const q = activeQuestion();
  const isHost = role === 'host';
  const showAnswer = isHost || state.phase === 'reveal' || state.phase === 'ended';
  // Final question flow: during the "finalWagering" phase players see ONLY the
  // wager screen (question text/options hidden from everyone but the host).
  // The host clicks "Show final question" to reveal it to all players.
  const inFinalWagering = !!finalQuestion && state.phase === 'finalWagering';
  const hideFinalText = !isHost && inFinalWagering;
  const allPlayersWagered = !!finalQuestion && state.players.size > 0 &&
    [...state.players.values()].every((p) => p.wager != null);
  return {
    phase: state.phase,
    totalRounds: state.totalRounds,
    questionsPerRound: state.questionsPerRound,
    // All available categories (with counts) for the host's setup screen.
    categories: CATEGORIES.map((c) => ({ name: c.name, count: c.count })),
    selectedCategories: [...state.selectedCategories],
    title: state.title || '', // venue/game name for the top of every player page
    currentRound: finalQuestion ? state.totalRounds : (state.qIndex >= 0 ? roundOf(state.qIndex) : 0),
    questionInRound: finalQuestion ? state.questionsPerRound + 1 : (state.qIndex >= 0 ? (state.qIndex % state.questionsPerRound) + 1 : 0),
    isFinal: !!finalQuestion,
    // The round the current screen belongs to. During a "roundIntro" pause this
    // is the round about to start (so both host and players see its chip pool).
    introRound: state.introRound,
    // Categories of the 4 questions coming up in the announced round — shown on
    // the upcoming-round screen so everyone knows what's next. (Never repeats a
    // category: a round is always 4 distinct categories.)
    upcomingCategories: state.introRound != null ? upcomingCategories(state.introRound) : null,
    questionsThisRound: state.introRound != null ? questionsInRound(state.introRound).length : null,
    questionNumber: finalQuestion ? gameLength() + 1 : state.qIndex + 1,
    // The size of the game actually built (16 in a normal game).
    totalQuestions: gameLength() || totalQuestionCount(),
    wagerOptions: currentWagerOptions(),
    // Chips offered by the round shown on screen (intro round while paused).
    roundWagerOptions: state.introRound != null
      ? wagerOptionsForRound(state.introRound)
      : currentWagerOptions(),
    finalWagerOpen: !!finalQuestion && state.phase === 'finalWagering', // players may set their stake now
    allPlayersWagered, // host UI: every player has locked in a final wager
    // The final question's category — shown on the wager screen so players know
    // what they're staking on before the text is revealed.
    finalCategory: !!finalQuestion && state.phase === 'finalWagering' ? finalQuestion.category : undefined,
    // Song-artist guesses still waiting on the host's verdict. Reveal is blocked
    // until this is empty, so the host UI shouts about it during a question.
    pendingBonusCount: bonusPending().length,
    pendingBonusNames: isHost ? bonusPending().map((p) => p.name) : undefined,
    // Host-only: the song guesses already judged on this question, so the panel
    // keeps showing what was called correct/missed during the reveal too.
    bonusJudged: isHost ? Object.entries(bonusResults).map(([pid, r]) => ({
      id: pid,
      name: state.players.get(pid)?.name ?? '?',
      guess: r.guess,
      result: r.result,
    })) : undefined,
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
        wager: (state.phase === 'finalWagering' || state.phase === 'question' || state.phase === 'reveal') ? p.wager : undefined,
        wagersUsed: wagerStateFor(p), // chips already spent in the current round
        correct: (isHost || state.phase === 'reveal') && p.correct !== null ? p.correct : undefined,
        // Song-artist bonus guess for the CURRENT question — host judges it.
        bonusGuess: isHost && state.phase === 'question' && bonusGuesses[p.id] != null
          ? bonusGuesses[p.id]
          : undefined,
        // The host's verdict on THIS player's own song-artist guess — shown only
        // to that player ("You got the song artist right!" / "Sorry, you missed it.").
        // Held back until the answer reveal so both results land together; the
        // host still sees every judged verdict live via bonusJudged above.
        bonusResult: p.id === playerId && bonusResults[p.id] && (state.phase === 'reveal' || state.phase === 'ended')
          ? bonusResults[p.id].result
          : undefined,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}

function broadcastState() {
  for (const socket of liveSockets) {
    const role = socket.data.role;
    if (role === 'player' && !socket.data.joined) {
      // Not joined yet — still send the venue name so the join screen can show it.
      socket.emit('title', { title: state.title || '' });
      continue;
    }
    // Pass the player's own id so their personal bonusResult is included.
    socket.emit('state', buildState(role, role === 'player' ? socket.data.playerId : null));
  }
}

io.on('connection', (socket) => {
  liveSockets.add(socket);
  console.log(`[${socket.data.role}] connected: ${socket.id}`);

  if (socket.data.role === 'host') {
    socket.emit('state', buildState('host'));
  } else {
    // Player: wait for join event. Send the current venue name right away so
    // the join screen can show it before they type their team name.
    socket.emit('title', { title: state.title || '' });
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
      if (!p || state.phase !== 'question') return;
      // A stake is REQUIRED before an answer counts — no wager, no play.
      if (p.wager == null) return;
      const q = activeQuestion();
      if (!q) return;
      // Players may change their answer any time before the host reveals:
      // whatever they have locked in at reveal time is what gets scored.
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
      if (!p) return;
      const w = Math.floor(Number(points));
      if (!Number.isFinite(w)) return; // junk stakes are ignored
      // Final question: any whole number from 0 up to the player's score.
      // Set during the "finalWagering" phase, before the question is shown —
      // once the host reveals it, the stake is locked and can't be changed.
      if (finalQuestion) {
        if (state.phase !== 'finalWagering') return;
        if (w < 0 || w > p.score) return;
        p.wager = w;
        broadcastState();
        return;
      }
      if (state.phase !== 'question') return;
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

    // Song-artist bonus guess: max 30 chars, one per player per question.
    // The host sees it next to their name and judges it with judgeBonus.
    socket.on('bonusGuess', ({ text }) => {
      const p = state.players.get(socket.data.playerId);
      if (!p || state.phase !== 'question') return;
      const guess = String(text ?? '').trim().slice(0, 30);
      if (!guess) return;
      bonusGuesses[p.id] = guess;
      broadcastState();
    });
  }

  // Host judges a player's song-artist bonus guess: "correct" adds +1 point.
  socket.on('judgeBonus', ({ playerId, correct }) => {
    if (socket.data.role !== 'host') return;
    const p = state.players.get(playerId);
    if (!p || !bonusGuesses[playerId]) return;
    const guess = bonusGuesses[playerId];
    delete bonusGuesses[playerId]; // judged — no longer pending
    bonusResults[playerId] = { result: correct === true ? 'correct' : 'missed', guess }; // shown to that player
    if (correct === true) {
      p.score += 1;
      console.log(`Bonus +1 for ${p.name} (song artist: "${guess}")`);
    } else {
      console.log(`Bonus missed for ${p.name} ("${guess}")`);
    }
    broadcastState();
  });

  // Host controls.
  socket.on('resetAll', () => {
    if (socket.data.role !== 'host') return;
    fullReset();
    broadcastState();
  });

  // Host sets the venue/game name — shown at the top of every player page.
  // It's a property of the session, not one game: it survives "Restart game"
  // (the host usually runs several games in the same venue).
  socket.on('setTitle', ({ title }) => {
    if (socket.data.role !== 'host') return;
    const clean = String(title ?? '').trim().slice(0, 60);
    state.title = clean;
    console.log(`Game title set: "${clean}"`);
    broadcastState();
  });

  socket.on('startGame', ({ keepScores = false, categories }) => {
    // Fixed format: always 4 rounds of 4 questions. The host's category picks
    // decide WHICH pool the questions are drawn from (empty = all categories).
    const sel = Array.isArray(categories) ? categories.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
    state.selectedCategories = sel;
    state.totalRounds = ROUNDS;                 // fixed format — never host-tunable
    state.questionsPerRound = QUESTIONS_PER_ROUND;
    if (!keepScores) for (const p of state.players.values()) p.score = 0;
    wagersUsed = {}; // fresh chip pools — every round of the new game starts clean
    skippedIds = new Set(); // no skips yet in this game

    // Build the whole game up front:
    //  • every question used AT MOST ONCE (nothing repeats during a game)
    //  • the order of the questions within a round is random
    //  • no category repeats inside a round — each round is 4 unique categories
    //    (the pool is shuffled first, so which question of a category gets picked
    //    is random; categories are picked most-supplied-first so a tiny category
    //    can't paint the builder into a corner)
    const byCat = new Map(); // normalized category -> [unused questions, shuffled]
    for (const q of shuffle(poolForSelected())) {
      const key = normCat(q.category) || 'uncategorized';
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(q);
    }
    state.gameQuestions = [];
    for (let r = 0; r < state.totalRounds; r++) {
      const usedCats = new Set();
      for (let placed = 0; placed < state.questionsPerRound; placed++) {
        // Pick (at random) among the unused categories that still have the most
        // questions left — keeps every round's 4 categories distinct.
        const avail = [...byCat.entries()]
          .filter(([key, list]) => !usedCats.has(key) && list.length)
          .sort((a, b) => b[1].length - a[1].length);
        if (!avail.length) break; // pool exhausted — game will be shorter than planned
        const best = avail[0][1].length;
        const top = avail.filter(([, list]) => list.length === best);
        const [key] = top[Math.floor(Math.random() * top.length)];
        usedCats.add(key);
        state.gameQuestions.push(byCat.get(key).pop());
      }
    }
    // Everything the build didn't use becomes the refill pool for skips — a
    // skipped question is replaced by one of these so the game keeps its full
    // length no matter how many questions are skipped.
    spareQuestions = shuffle([...byCat.values()].flat());
    if (gameLength() < totalQuestionCount()) {
      console.warn(`Only ${gameLength()} of ${totalQuestionCount()} questions available — the selected categories ran out of questions`);
    }

    finalQuestion = null; // picked again after the last round
    state.qIndex = -1;
    resetQuestionFlags();
    // Show the "Round 1" message screen first — it tells everyone which chips
    // this round offers (1–4) before any question is played.
    state.introRound = 1;
    state.phase = 'roundIntro';
    console.log(`Game started: ${gameLength()} questions in ${state.totalRounds} rounds (categories: ${sel.length ? sel.join(', ') : 'all'})`);
    broadcastState();
  });

  socket.on('reveal', () => {
    if (state.phase !== 'question') return;
    // EVERY song-artist guess must be judged by the host first — the answer can't
    // be revealed (no peeking, no early points from the main question) while any
    // player is still waiting on a verdict.
    const pending = Object.keys(bonusGuesses).length;
    if (pending) {
      console.log(`Reveal blocked — ${pending} song-artist guess${pending === 1 ? '' : 'es'} still waiting to be judged`);
      broadcastState();
      return;
    }
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

  // Host skips the current question WITHOUT revealing its answer (e.g. it's a
  // duplicate or just bad). The skipped question is spliced out of
  // state.gameQuestions and replaced by one drawn from spareQuestions, so we
  // stay at the SAME qIndex with a fresh question in this slot. Because every
  // displayed counter is derived from qIndex, none of them move — the
  // round/question number stays put until an answer is actually revealed.
  // Per-question flags are reset first so no stale answers/wagers/song-guesses
  // carry over onto the fresh question that now occupies this slot. No chip is
  // spent (chips are only marked in the reveal handler), so nothing is scored.
  // This lets a duplicate or bad question be dropped without eating one of the
  // 4 slots in its round, so a full game still plays out as 4 rounds x 4
  // questions plus the final question.
  socket.on('skipQuestion', () => {
    if (socket.data.role !== 'host') return;
    if (state.phase !== 'question') return;
    skipCurrentQuestion();
    broadcastState();
  });

  // After all regular rounds, one final question: each player may wager any
  // whole number of points from 0 up to their current score. Correct doubles
  // the stake into their total; wrong loses it (double-or-nothing).
  function startFinalQuestion() {
    const usedIds = new Set(state.gameQuestions.map((q) => q.id));
    // Draw from the host's selected categories too — a sports-free game stays
    // sports-free. Skipped questions are excluded so a bad/duplicate question
    // never comes back as the finale. Fall back to any unused question if the
    // pool is exhausted.
    let candidates = poolForSelected().filter((q) => !usedIds.has(q.id) && !skippedIds.has(q.id));
    if (!candidates.length) candidates = QUESTIONS.filter((q) => !usedIds.has(q.id) && !skippedIds.has(q.id));
    finalQuestion = (candidates.length ? shuffle(candidates) : shuffle(QUESTIONS))[0];
    state.qIndex = totalQuestionCount() - 1; // last regular index; advance() ends the game from here
    resetQuestionFlags();
    // Players see a "waiting for players to wager" screen — the question text
    // stays hidden (even from them) until the host clicks "Show final question".
    state.phase = 'finalWagering';
    console.log('Final question — waiting for all players to lock in their wager!');
    broadcastState();
  }

  // Host confirms every player has a stake and reveals the final question to
  // all players (they can now answer).
  socket.on('showFinalQuestion', () => {
    if (!finalQuestion || state.phase !== 'finalWagering') return;
    state.phase = 'question';
    console.log('Final question revealed to all players');
    broadcastState();
  });

  // Advance to the next question, or pause at a round boundary / start the final question.
  function advance() {
    if (state.phase !== 'question' && state.phase !== 'reveal') return;
    // The final question is always last — but it must be REVEALED first so its
    // wager is scored. "Next" before reveal does nothing (host should press Reveal).
    if (finalQuestion) {
      if (state.phase === 'reveal') endGame();
      return;
    }
    assertRoundFits();
    // Whole game played = move on to the final question.
    if (state.qIndex + 1 >= state.gameQuestions.length) {
      startFinalQuestion();
      return;
    }
    // Crossing into a new round? Pause on the "Round N" message screen so both
    // host and players see which chips the upcoming round offers before it starts.
    const finishedRound = roundOf(state.qIndex);
    const nextRound = roundOf(state.qIndex + 1);
    if (nextRound !== finishedRound) {
      startRoundIntro(nextRound, finishedRound);
      return;
    }
    state.qIndex = nextIdx();
    resetQuestionFlags();
    state.phase = 'question';
    broadcastState();
  }

  socket.on('startNextRound', () => {
    if (state.phase !== 'roundIntro' && state.phase !== 'roundEnd') return;
    assertRoundFits();
    // The announced round is the next one to play — but if there's nothing left
    // to play (short game), go straight to the final question instead.
    const rnd = state.introRound || (state.qIndex >= 0 ? roundOf(state.qIndex) + 1 : 1);
    const round = questionsInRound(rnd);
    if (!round.length) { startFinalQuestion(); return; }
    // First question of the announced round (or the next slotted question).
    state.qIndex = firstIdxOfRound(rnd);
    resetQuestionFlags();
    state.introRound = null;
    state.phase = 'question';
    console.log(`Round ${rnd} started`);
    broadcastState();
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
  const hostPage = publicUrl ? `${publicUrl}/host` : `http://${lanIp}:${PORT}/host`;
  console.log('────────────────────────────────────────────');
  console.log(`AiTriviaGame running`);
  console.log(`  Host page : ${hostPage}`);
  console.log(`  Players   : ${joinUrl}  (QR at /qr.png)`);
  console.log('────────────────────────────────────────────');
});
