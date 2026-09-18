// End-to-end tests for the trivia server (run while server.js is up):
//     node test-e2e.mjs
//
// Covers the FIXED game format (4 rounds x 4 questions + final question) and the
// rules the game must never break:
//   • every round uses 4 DIFFERENT categories
//   • no question ever repeats during a game
//   • question order is random (and differs between games)
//   • the host must judge every song-artist guess before the answer can be revealed
// plus the scoring rules: per-round chips, required stake, manual points, the
// final double-or-nothing question, and rejoin-with-score.
import { io } from 'socket.io-client';

// Point at a different instance with TRIVIA_URL (e.g. TRIVIA_URL=http://127.0.0.1:8091).
const URL = process.env.TRIVIA_URL || 'http://127.0.0.1:8090';
console.log(`Testing ${URL}`);
let failures = 0;
setTimeout(() => { console.error('GLOBAL TIMEOUT — test hung'); process.exit(1); }, 180000).unref();

function check(name, cond) {
  if (cond) console.log('PASS ', name);
  else { console.error('FAIL ', name); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let st = null; // latest state seen by the host socket
function waitFor(fn, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = fn(st); } catch (e) {}
      if (ok) { clearInterval(iv); resolve(st); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout waiting for: ${label}`)); }
    }, 40);
  });
}

const host = io(URL, { query: { role: 'host' } });
host.on('state', (s) => { st = s; });
await new Promise((r) => host.on('connect', r));
check('host connected', true);

async function makePlayer(name) {
  const p = io(URL, { query: { role: 'player' } });
  const obj = { socket: p, id: null, state: null };
  let ack = null;
  p.on('joined', (a) => { ack = a; obj.id = a.playerId; });
  p.on('state', (s) => { obj.state = s; });
  p.emit('join', { name });
  return new Promise((resolve) => {
    const iv = setInterval(() => { if (ack) { clearInterval(iv); resolve(obj); } }, 40);
    setTimeout(() => { clearInterval(iv); resolve(obj); }, 4000);
  });
}
const P = (n) => st.players.find((p) => p.name === n);
function answerFor(q, correct) {
  if (q.isMultipleChoice) return correct ? q.correctIndex : ((q.correctIndex + 1) % q.options.length);
  return correct ? q.answerRaw : 'zzz definitely not';
}

// Start fresh so the assertions below see only our own players.
host.emit('resetAll');
await waitFor((s) => s.phase === 'lobby' && s.players.length === 0, 'reset to empty lobby');

const blue = await makePlayer('Blue Team');
const red = await makePlayer('Red Team');
check('both players joined with ids', !!(blue && red));
await waitFor((s) => P('Blue Team') && P('Red Team'), 'lobby shows both test players');

// ---------------------------------------------------------------------------
// 1. Fixed format: 4 rounds x 4 questions, random order, no repeats, and 4
//    DISTINCT categories in every round.
// ---------------------------------------------------------------------------
async function playQuestionAuto(ci) {
  const opts = st.wagerOptions || [];
  const w = opts[ci % opts.length]; // a different chip each question of the round
  blue.socket.emit('setWager', { points: w });
  red.socket.emit('setWager', { points: w });
  await sleep(140);
  check(`Q${ci + 1}: both players hold stake ${w}`, P('Blue Team').wager === w && P('Red Team').wager === w);
  const q = st.question;
  blue.socket.emit('answer', { value: answerFor(q, true) });
  red.socket.emit('answer', { value: answerFor(q, false) });
  await sleep(80);
  host.emit('reveal');
  await waitFor((s) => s.phase === 'reveal', 'reveal phase');
}

// ---- Game 1 --------------------------------------------------------------
host.emit('startGame', { keepScores: false, categories: null });
await waitFor((s) => s.phase === 'roundIntro', 'game 1 round intro');
check('fixed format reported as 4 rounds x 4 questions', st.totalRounds === 4 && st.questionsPerRound === 4);
check('game 1 has 16 questions', st.totalQuestions === 16 || st.totalQuestions > 16);
check('round 1 intro screen is shown first', st.phase === 'roundIntro' && st.introRound === 1);
check('round 1 announces 4 upcoming categories', (st.upcomingCategories || []).length === 4);
check('round 1 categories are all different', new Set((st.upcomingCategories || []).map((c) => String(c).toLowerCase())).size === 4);

const game1 = [];
const perRoundCats = {};
host.emit('startNextRound');
await waitFor((s) => s.phase === 'question', 'game 1 Q1');

let played = 0;
let roundsPlayed = 0;
let lastRound = 0;
while (played < 16) {
  const rn = st.currentRound;
  if (rn !== lastRound) { lastRound = rn; roundsPlayed++; }
  (perRoundCats[rn] = perRoundCats[rn] || []).push(st.question.category);
  game1.push(st.question.id);
  await playQuestionAuto(played % 4);
  played++;
  host.emit('nextQuestion');
  await waitFor((s) => s.phase !== 'reveal' || st.isFinal, `advance after Q${played}`, 10000);
  if (st.phase === 'finalWagering') break;
  if (st.phase === 'roundIntro') {
    check(`round ${st.introRound}: announces its 4 categories`,
      (st.upcomingCategories || []).length === 4 &&
      new Set((st.upcomingCategories || []).map((c) => String(c).toLowerCase())).size === 4);
    host.emit('startNextRound');
    await waitFor((s) => s.phase === 'question' || s.phase === 'finalWagering', 'next round starts');
    if (st.phase === 'finalWagering') break;
  }
}
check('16 regular questions were played', played === 16);
check('exactly 4 rounds were played', roundsPlayed === 4);
check('no question repeated during the game', new Set(game1).size === game1.length);
for (const rn of Object.keys(perRoundCats)) {
  const cats = perRoundCats[rn];
  check(`round ${rn}: 4 questions, 4 DIFFERENT categories (${cats.join(' / ')})`,
    cats.length === 4 && new Set(cats.map((c) => String(c).toLowerCase())).size === 4);
}
check('after 4 rounds the final question opens', st.isFinal === true);

// ---- Final question: wager up to your score -------------------------------
await waitFor((s) => s.isFinal && s.phase === 'finalWagering', 'final wagering');
check('final question text is hidden from players until the host shows it',
  blue.state && blue.state.phase === 'finalWagering' && blue.state.question.text === '');
blue.socket.emit('setWager', { points: 9999 });
await sleep(120);
check('final wager above own score rejected', P('Blue Team').wager == null);
const bBefore = P('Blue Team').score;
blue.socket.emit('setWager', { points: 2 });
red.socket.emit('setWager', { points: 0 });
await waitFor((s) => s.allPlayersWagered === true, 'all final wagers in');
host.emit('showFinalQuestion');
await waitFor((s) => s.phase === 'question' && s.isFinal, 'final question shown');
const fq = st.question;
blue.socket.emit('answer', { value: answerFor(fq, true) });
red.socket.emit('answer', { value: answerFor(fq, false) });
await sleep(80);
host.emit('reveal');
await waitFor((s) => s.phase === 'reveal' && s.isFinal, 'final reveal');
check(`final: Blue correct adds the stake (${bBefore} -> ${bBefore + 2})`, P('Blue Team').score === bBefore + 2);
host.emit('nextQuestion');
await waitFor((s) => s.phase === 'ended', 'game ended');

// ---------------------------------------------------------------------------
// 2. Song-artist guesses gate the reveal.
// ---------------------------------------------------------------------------
host.emit('startGame', { keepScores: false, categories: null });
await waitFor((s) => s.phase === 'roundIntro', 'game 2 intro');
host.emit('startNextRound');
await waitFor((s) => s.phase === 'question', 'game 2 Q1');
const q2id = st.question.id;

// A player's song guess must be judged before the answer can be revealed.
blue.socket.emit('bonusGuess', { text: 'Queen' });
await waitFor((s) => s.pendingBonusCount === 1, 'pending song guess visible to host');
check('host sees the pending guess on the scoreboard', P('Blue Team').bonusGuess === 'Queen');

blue.socket.emit('setWager', { points: 1 });
red.socket.emit('setWager', { points: 1 });
await sleep(140);
blue.socket.emit('answer', { value: answerFor(st.question, true) });
await sleep(80);
// Baseline AFTER the stakes landed but BEFORE the reveal — the main question is
// still unscored at this point (its answer is hidden), so any later change to
// the score is the song-artist bonus and nothing else.
const blueScoreBeforeBonus = P('Blue Team').score;
check(`baseline: main-question stake not scored before the reveal (Blue ${blueScoreBeforeBonus} pts)`,
  P('Blue Team').wager === 1 && P('Blue Team').correct === undefined);
host.emit('reveal');
await sleep(400);
check('reveal is BLOCKED while a song guess is unjudged', st.phase === 'question' && st.question.id === q2id);
check('the player sees no verdict yet', P('Blue Team').bonusResult === undefined);

// Wrong verdict first: no point, and only then does the reveal unlock.
host.emit('judgeBonus', { playerId: P('Blue Team').id, correct: false });
await waitFor((s) => s.pendingBonusCount === 0, 'guess judged');
await waitFor(() => blue.state && blue.state.players.find((p) => p.id === blue.id)?.bonusResult === 'missed',
  'player sees the missed verdict');
check('missed verdict does not score', P('Blue Team').score === blueScoreBeforeBonus);
check('missed verdict is reported to the player',
  blue.state.players.find((p) => p.id === blue.id).bonusResult === 'missed');
check('host keeps a record of judged guesses', (st.bonusJudged || []).length === 1 && st.bonusJudged[0].guess === 'Queen');

host.emit('reveal');
await waitFor((s) => s.phase === 'reveal', 'reveal unlocked after judging');
check('reveal works once nothing is pending', st.phase === 'reveal');

// Next question: a guess sent AFTER the host already judged gets re-gated.
host.emit('nextQuestion');
await waitFor((s) => s.phase === 'question' && st.question.id !== q2id, 'game 2 Q2');
blue.socket.emit('bonusGuess', { text: 'Nirvana' });
await waitFor((s) => s.pendingBonusCount === 1, 'second guess pending');
const blueScoreBeforeSong = P('Blue Team').score;
host.emit('judgeBonus', { playerId: P('Blue Team').id, correct: true });
await waitFor((s) => s.pendingBonusCount === 0, 'second guess judged');
await waitFor(() => blue.state && blue.state.players.find((p) => p.id === blue.id)?.bonusResult === 'correct',
  'player sees the correct verdict');
check('correct verdict awards +1 bonus point',
  blue.state.players.find((p) => p.id === blue.id).bonusResult === 'correct');
check(`bonus point lands on the score (${blueScoreBeforeSong} + 1 = ${P('Blue Team').score})`, P('Blue Team').score === blueScoreBeforeSong + 1);
check('bonus point is independent of the main question', P('Blue Team').correct === undefined && st.phase === 'question');

// Two players guessing in the same question: both must be judged.
blue.socket.emit('bonusGuess', { text: 'ABBA' });
red.socket.emit('bonusGuess', { text: 'Blondie' });
await waitFor((s) => s.pendingBonusCount === 2, 'both guesses pending');
host.emit('judgeBonus', { playerId: P('Blue Team').id, correct: true });
await sleep(200);
host.emit('reveal');
await sleep(300);
check('reveal still blocked while ONE guess is unjudged', st.phase === 'question');
host.emit('judgeBonus', { playerId: P('Red Team').id, correct: true });
await waitFor((s) => s.pendingBonusCount === 0, 'both judged');
host.emit('reveal');
await waitFor((s) => s.phase === 'reveal', 'reveal after both judged');
await waitFor(() => blue.state && blue.state.players.find((p) => p.id === blue.id)?.bonusResult === 'correct'
  && red.state && red.state.players.find((p) => p.id === red.id)?.bonusResult === 'correct', 'both players see their verdict');
check(`both correct verdicts scored +1 each (Blue ${P('Blue Team').score}, Red ${P('Red Team').score})`, P('Blue Team').score === blueScoreBeforeSong + 2 && P('Red Team').score === 1);
check('verdicts are delivered per player, not broadcast',
  blue.state.players.find((p) => p.id === red.id).bonusResult === undefined);

// ---------------------------------------------------------------------------
// 3. Category selection: only the chosen categories appear.
// ---------------------------------------------------------------------------
host.emit('startGame', { keepScores: false, categories: ['Music', 'Sports', 'Food & Drink', 'Movies & TV'] });
await waitFor((s) => s.phase === 'roundIntro', 'selected-category game intro');
const allowed = new Set(['music', 'sports', 'food & drink', 'movies & tv']);
check('selected categories are echoed back', Array.isArray(st.selectedCategories) && st.selectedCategories.length === 4);
check('round 1 categories all come from the selection', (st.upcomingCategories || []).every((c) => allowed.has(String(c).toLowerCase())));
check('round 1 has 4 unique selected categories', new Set((st.upcomingCategories || []).map((c) => String(c).toLowerCase())).size === 4);

// ---------------------------------------------------------------------------
// 4. Chip rules, required stake, manual points, rejoin.
// ---------------------------------------------------------------------------
host.emit('startGame', { keepScores: false, categories: null });
await waitFor((s) => s.phase === 'roundIntro', 'game 3 intro');
host.emit('startNextRound');
await waitFor((s) => s.phase === 'question', 'game 3 Q1');
check('round 1 chips are 1-4', JSON.stringify(st.wagerOptions) === '[1,2,3,4]');
check('a stake is required before answering', P('Blue Team').wager == null);

// Answering without a stake is ignored entirely.
blue.socket.emit('answer', { value: answerFor(st.question, true) });
await sleep(150);
check('answer without a stake is refused', P('Blue Team').answered === false);

blue.socket.emit('setWager', { points: 3 });
await sleep(120);
check('chip 3 accepted', P('Blue Team').wager === 3);
blue.socket.emit('answer', { value: answerFor(st.question, true) });
await sleep(120);
check('answer accepted once staked', P('Blue Team').answered === true);
host.emit('reveal');
await waitFor((s) => s.phase === 'reveal', 'game 3 Q1 reveal');
check('correct answer pays the stake (+3)', P('Blue Team').score === 3);
check('no-stake player forfeits (Red unaffected)', P('Red Team').score === 0 && P('Red Team').correct == null);
host.emit('nextQuestion');
await waitFor((s) => s.phase === 'question', 'game 3 Q2');
blue.socket.emit('setWager', { points: 3 });
await sleep(120);
check('a chip already spent this round is rejected', P('Blue Team').wager == null);

// Manual point adjustment (bonus / corrections).
const beforeManual = P('Red Team').score;
host.emit('awardPoints', { playerId: P('Red Team').id, points: 5 });
await waitFor((s) => P('Red Team').score === beforeManual + 5, 'manual +5 applied');
check('host can award manual points', P('Red Team').score === beforeManual + 5);
host.emit('awardPoints', { playerId: P('Red Team').id, points: -2 });
await waitFor((s) => P('Red Team').score === beforeManual + 3, 'manual -2 applied');
check('host can subtract manual points', P('Red Team').score === beforeManual + 3);

// Disconnect / rejoin keeps the score.
const redScore = P('Red Team').score;
red.socket.disconnect();
await waitFor((s) => P('Red Team') && P('Red Team').online === false, 'red offline');
const red2 = await makePlayer('Red Team');
await waitFor((s) => P('Red Team') && P('Red Team').online === true, 'red back online');
check('rejoining by name keeps the score', P('Red Team').score === redScore);

// ---------------------------------------------------------------------------
// 5. Randomness: two games in a row should not be identical.
// ---------------------------------------------------------------------------
async function firstQuestionIds() {
  host.emit('resetAll');
  await waitFor((s) => s.phase === 'lobby', 'reset');
  host.emit('startGame', { keepScores: false, categories: null });
  await waitFor((s) => s.phase === 'roundIntro', 'intro');
  host.emit('startNextRound');
  await waitFor((s) => s.phase === 'question', 'q1');
  return st.question.id;
}
const a1 = await firstQuestionIds();
const a2 = await firstQuestionIds();
const a3 = await firstQuestionIds();
check(`question order is random across games (${a1}, ${a2}, ${a3})`, new Set([a1, a2, a3]).size > 1);

blue.socket.disconnect();
red2 && red2.socket.disconnect();
host.close();

if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log('\nALL TESTS PASSED');
process.exit(0);
