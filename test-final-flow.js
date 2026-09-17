// End-to-end test of the final-question wagering flow.
// Starts a 1-round x 2-question game, plays it through to the end, and
// asserts every step of: finalWagering -> showFinalQuestion -> question -> reveal -> ended.
import { io } from 'socket.io-client';

const PORT = process.env.PORT || 8091;
const URL = `http://localhost:${PORT}`;
let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failures++;
}

function connect(role, name) {
  const s = io(URL, { query: { role }, transports: ['websocket'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    s.on('connect', () => { clearTimeout(t); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

// Track the latest state each socket has ever received, then poll it.
function makeTracker(socket) {
  let last = null;
  socket.on('state', (s) => { last = s; });
  return () => last;
}

async function waitForState(get, pred, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (get() && pred(get())) return get();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const host = await connect('host');
const pA = await connect('player', 'Alpha');
const pB = await connect('player', 'Bravo');
const hostSt = makeTracker(host);
const aSt = makeTracker(pA);
const bSt = makeTracker(pB);
pA.emit('join', { name: 'Alpha' });
pB.emit('join', { name: 'Bravo' });

// 1. Lobby with two players.
await waitForState(hostSt, (s) => s.phase === 'lobby' && s.players.length === 2, 'lobby w/ 2 players');
check('host sees lobby with both players', true);

// 2. Start a tiny game: 1 round x 2 questions.
host.emit('startGame', { rounds: 1, perRound: 2, shuffleOn: false });
await waitForState(hostSt, (s) => s.phase === 'roundIntro', 'roundIntro');
check('game starts on roundIntro screen', true);

// 3. Start the round -> Q1.
host.emit('startNextRound');
const q1 = await waitForState(aSt, (s) => s.phase === 'question' && !s.isFinal, 'Q1 for player A');
check('player sees Q1 text', !!q1.question.text);

// 4. Play Q1: both wager chip 1 and answer correctly.
pA.emit('setWager', { points: 1 });
pB.emit('setWager', { points: 1 });
await waitForState(hostSt, (s) => s.phase === 'question' && s.players.every((p) => p.wager === 1), 'both wagered Q1');
check('host sees both players with chip-1 wagers on Q1', true);
// Correct answer comes from the HOST state (players never see it pre-reveal).
const q1h = hostSt().question;
const correctVal = q1h.isMultipleChoice ? q1h.correctIndex : q1h.answerRaw;
pA.emit('answer', { value: correctVal });
pB.emit('answer', { value: correctVal });
await waitForState(hostSt, (s) => s.players.every((p) => p.answered), 'both answered Q1');
check('host sees both answers locked in', true);

// 5. Reveal Q1 -> scores +1 each; next -> Q2.
host.emit('reveal');
await waitForState(hostSt, (s) => s.phase === 'reveal' && s.players.every((p) => p.score === 1), 'Q1 reveal scored +1');
check('both players at 1 pt after correct Q1', true);
host.emit('nextQuestion');
const q2 = await waitForState(aSt, (s) => s.phase === 'question' && !s.isFinal && s.question.id !== q1.question.id, 'Q2 for player A');

// 6. Play Q2: A wagers chip 2 and answers correctly (+2 -> 3); B wagers chip 2 and answers wrong (stays 1).
pA.emit('setWager', { points: 2 });
pB.emit('setWager', { points: 2 });
const q2h = hostSt().question;
const q2Correct = q2h.isMultipleChoice ? q2h.correctIndex : q2h.answerRaw;
const q2Wrong = q2h.isMultipleChoice ? (q2h.correctIndex === 0 ? 1 : 0) : 'zzz definitely wrong';
pA.emit('answer', { value: q2Correct });
pB.emit('answer', { value: q2Wrong });
await waitForState(hostSt, (s) => s.players.every((p) => p.answered), 'both answered Q2');
host.emit('reveal');
await waitForState(hostSt, (s) => s.phase === 'reveal' &&
  s.players.find((p) => p.name === 'Alpha').score === 3 &&
  s.players.find((p) => p.name === 'Bravo').score === 1, 'Q2 reveal scored');
check('after Q2: Alpha=3, Bravo=1', true);

// 7. Next -> FINAL WAGERING phase (question hidden from players).
host.emit('nextQuestion');
const fw = await waitForState(hostSt, (s) => s.phase === 'finalWagering', 'finalWagering for host');
check('host enters finalWagering phase', true);
check('host sees the full final question text', !!fw.question && fw.question.text.length > 0);

const pFw = await waitForState(aSt, (s) => s.phase === 'finalWagering', 'finalWagering for player A');
check('player A is in finalWagering phase', true);
check('player A: question text HIDDEN', !!pFw.question && pFw.question.text === '');
check('player A: options hidden (empty)', Array.isArray(pFw.question.options) && pFw.question.options.length === 0);
check('player A: finalWagerOpen flag set', pFw.finalWagerOpen === true);
check('host: allPlayersWagered=false initially', fw.allPlayersWagered === false);

// 8. Player A wagers 2 (of their 3). Host should see it; not everyone in yet.
pA.emit('setWager', { points: 2 });
const afterA = await waitForState(hostSt, (s) => s.phase === 'finalWagering' && s.players.find((p) => p.name === 'Alpha').wager === 2, 'A wagered 2');
check('host sees Alpha locked in at 2', true);
check('allPlayersWagered still false (Bravo pending)', afterA.allPlayersWagered === false);

// Out-of-range wager must be rejected (no broadcast expected — check latest state).
pB.emit('setWager', { points: 99 });
await new Promise((r) => setTimeout(r, 400));
check('out-of-range wager rejected', hostSt().players.find((p) => p.name === 'Bravo').wager == null);

// 9. Player B wagers all of their points (1). Now everyone is in.
pB.emit('setWager', { points: 1 });
const allIn = await waitForState(hostSt, (s) => s.phase === 'finalWagering' && s.allPlayersWagered === true, 'all wagered');
check('host sees allPlayersWagered=true once everyone locks in', true);

// 10. Host shows the final question -> players see it now.
host.emit('showFinalQuestion');
const shownA = await waitForState(aSt, (s) => s.phase === 'question' && s.isFinal && !!s.question.text, 'final Q shown to A');
check('player A sees final question text after host shows it', shownA.question.text.length > 0);
await waitForState(bSt, (s) => s.phase === 'question' && s.isFinal && !!s.question.text, 'final Q shown to B');
check('player B also sees the final question', true);

// 11. Answer: A correct (+2 -> 5), B wrong (-1 -> 0). Wagers stay locked from the wagering phase.
const fq = hostSt().question; // host state carries the real answer data
const fqCorrect = fq.isMultipleChoice ? fq.correctIndex : fq.answerRaw;
const fqWrong = fq.isMultipleChoice ? (fq.correctIndex === 0 ? 1 : 0) : 'zzz definitely wrong';
pA.emit('answer', { value: fqCorrect });
pB.emit('answer', { value: fqWrong });
await waitForState(hostSt, (s) => s.players.every((p) => p.answered), 'both answered final');
host.emit('reveal');
await waitForState(hostSt, (s) => s.phase === 'reveal' &&
  s.players.find((p) => p.name === 'Alpha').score === 5 &&
  s.players.find((p) => p.name === 'Bravo').score === 0, 'final reveal scored');
check('final scoring: Alpha +2 -> 5, Bravo -1 -> 0', true);

// 12. Next -> game ended with final scoreboard.
host.emit('nextQuestion');
await waitForState(hostSt, (s) => s.phase === 'ended', 'game ended');
check('game ends after final reveal + next', true);
const pEnd = await waitForState(aSt, (s) => s.phase === 'ended', 'player sees ended');
check('players see the ended screen with final board', pEnd.players.length === 2 && pEnd.players.find((p) => p.name === 'Alpha').score === 5);

host.close(); pA.close(); pB.close();
console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
