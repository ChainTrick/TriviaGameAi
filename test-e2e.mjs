// End-to-end smoke test for the trivia server (run while server.js is up).
import { io } from 'socket.io-client';

const URL = 'http://127.0.0.1:8090';
let failures = 0;
setTimeout(() => { console.error('GLOBAL TIMEOUT — test hung'); process.exit(1); }, 60000).unref();

function check(name, cond) {
  if (cond) console.log('PASS ', name);
  else { console.error('FAIL ', name); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until a predicate on the latest state is true.
function waitFor(fn, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = fn(st); } catch (e) {}
      if (ok) { clearInterval(iv); resolve(st); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for: ${label}`));
      }
    }, 50);
  });
}

let st = null; // latest state seen by the host socket

const host = io(URL, { query: { role: 'host' } });
host.on('state', (s) => { st = s; });

await new Promise((r) => host.on('connect', r));
check('host connected', true);

// --- Players join -------------------------------------------------------
function makePlayer(name) {
  const p = io(URL, { query: { role: 'player' } });
  let ack = null;
  p.on('joined', (a) => { ack = a; });
  p.emit('join', { name });
  return new Promise((resolve) => {
    const iv = setInterval(() => { if (ack) { clearInterval(iv); resolve({ socket: p, id: ack.playerId }); } }, 50);
    setTimeout(() => { clearInterval(iv); resolve(null); }, 4000);
  });
}

const blue = await makePlayer('Blue Team');
const red = await makePlayer('Red Team');
check('both players joined with ids', !!(blue && red));

// Wait until both of OUR players appear in the lobby (other pre-existing
// players may be present from earlier games — that's fine).
await waitFor((s) => s.players.some((p) => p.name === 'Blue Team') && s.players.some((p) => p.name === 'Red Team'), 'lobby shows 2 players');
check('lobby shows both test players', st.players.some((p) => p.name === 'Blue Team') && st.players.some((p) => p.name === 'Red Team'));

// --- Start a 3-round x 2-question game (full flow in fewer steps) -------
host.emit('startGame', { rounds: 3, perRound: 2, shuffleOn: false, keepScores: false });
await waitFor((s) => s.phase === 'question' && s.question, 'game started');
check('game started in question phase', st.phase === 'question');
check('total questions = rounds x per-round (6)', st.totalQuestions === 6);
check('round fields present', st.currentRound === 1 && st.questionInRound === 1 && st.questionsPerRound === 2 && st.totalRounds === 3);
check('round 1 wager options are 1-4', JSON.stringify(st.wagerOptions) === '[1,2,3,4]');

const q1id = st.question.id;

// Q1: Blue wagers 3 and answers correctly (free-text or MC handled below).
function answerFor(q, correct) {
  if (q.isMultipleChoice) return correct ? q.correctIndex : ((q.correctIndex + 1) % q.options.length);
  // free text: use the raw answer for correct, nonsense for wrong
  return correct ? q.answerRaw : 'zzz definitely not';
}

async function playQuestion(wagers, answers) {
  const q = st.question;
  for (const [who, w] of wagers) {
    if (w != null) who.socket.emit('setWager', { points: w });
  }
  await sleep(150); // let wager states land
  for (const [who, correct] of answers) {
    who.socket.emit('answer', { value: answerFor(q, correct) });
  }
  host.emit('reveal');
  await waitFor((s) => s.phase === 'reveal', 'reveal phase');
}

// Q1 (round 1): Blue +3 correct, Red wagers 2 but is wrong -> no penalty.
await playQuestion([[blue, 3], [red, 2]], [[blue, true], [red, false]]);
check('Q1 reveal shows results', ['Blue Team', 'Red Team'].every((n) => st.players.find((p) => p.name === n).correct !== undefined));
const bScoreAfterQ1 = st.players.find((p) => p.name === 'Blue Team').score;
const rScoreAfterQ1 = st.players.find((p) => p.name === 'Red Team').score;
check('Q1 Blue +3', bScoreAfterQ1 === 3);
check('Q1 Red wrong -> no penalty (0)', rScoreAfterQ1 === 0);

host.emit('nextQuestion');
await waitFor((s) => s.phase === 'question' && s.question.id !== q1id, 'advanced to Q2');
check('Q2 is round 1 question 2', st.currentRound === 1 && st.questionInRound === 2);

// Q2 (round 1): Blue +4 correct, Red wagers 1 but is wrong -> no penalty.
await playQuestion([[blue, 4], [red, 1]], [[blue, true], [red, false]]);
host.emit('nextQuestion');

// NEW BEHAVIOR: the game flows straight into round 2 — no host pause.
await waitFor((s) => s.phase === 'question' && s.currentRound === 2, 'auto-advanced to round 2');
check('round 1 -> round 2 is automatic (no roundEnd pause)', st.phase === 'question' && st.currentRound === 2 && st.questionInRound === 1);
check('round 2 wager options are 2/4/6/8', JSON.stringify(st.wagerOptions) === '[2,4,6,8]');

// Q3 (round 2): Blue tries chip 1 -> rejected (not offered this round), then
// wagers 2 and is correct (+2). Red wagers 4 but is wrong -> no penalty.
blue.socket.emit('setWager', { points: 1 });
await sleep(150);
check('chip 1 rejected in even round', st.players.find((p) => p.name === 'Blue Team').wager == null);
await playQuestion([[blue, 2], [red, 4]], [[blue, true], [red, false]]);

host.emit('nextQuestion');
await waitFor((s) => s.phase === 'question' && st.questionInRound === 2, 'Q4 active');

// Q4 (round 2): Blue +6 correct, Red wagers 8 but is wrong -> no penalty.
await playQuestion([[blue, 6], [red, 8]], [[blue, true], [red, false]]);
host.emit('nextQuestion');

// THE REGRESSION: after the last question of round 2 (not round 1) it must
// pause at "round complete" for the host to start round 3.
await waitFor((s) => s.phase === 'roundEnd', 'round boundary after round 2');
check('after Q4-of-game(2/6) phase is roundEnd, not ended', st.phase === 'roundEnd' && st.totalRounds === 3);
check('scores carried into round break (Blue 3+4+2+6=15)', st.players.find((p) => p.name === 'Blue Team').score === 15);

// Host starts round 3.
host.emit('startNextRound');
await waitFor((s) => s.phase === 'question' && s.currentRound === 3, 'round 3 started');
check('round 3 question 1 active', st.currentRound === 3 && st.questionInRound === 1);
check('round 3 wager options back to 1-4', JSON.stringify(st.wagerOptions) === '[1,2,3,4]');

// Q5 (round 3): chips RESET per round — Blue's chip 1 is fresh again here.
await playQuestion([[blue, 1], [red, 3]], [[blue, true], [red, true]]);
host.emit('nextQuestion');
await waitFor((s) => s.phase === 'question' && st.questionInRound === 2, 'Q6 active');

// Q6 (round 3): Blue's chip 1 was spent on Q5 of THIS round -> rejected.
check('used list holds chips spent this round only', JSON.stringify(st.players.find((p) => p.name === 'Blue Team').wagersUsed) === '[1]');
blue.socket.emit('setWager', { points: 1 }); // spent on Q5 of the same round -> rejected
await sleep(150);
check('chip spent earlier in the SAME round is rejected (Blue has no wager)', st.players.find((p) => p.name === 'Blue Team').wager == null);
// Blue's chip 2 was spent in round 1 but is fresh again in round 3.
blue.socket.emit('setWager', { points: 2 }); // per-round reset -> accepted
await sleep(150);
check('chip from an earlier round is available again (Blue wagers 2)', st.players.find((p) => p.name === 'Blue Team').wager === 2);
// Red's chip 3 was spent on Q5 of this round -> rejected; fresh chip 2 works.
red.socket.emit('setWager', { points: 3 }); // same-round reuse -> rejected
await sleep(150);
check('Red same-round chip reuse rejected (no wager)', st.players.find((p) => p.name === 'Red Team').wager == null);
red.socket.emit('setWager', { points: 2 });
await sleep(150);
// Blue answers with stake (set above), Red wrong.
await playQuestion([], [[blue, true], [red, false]]);
host.emit('nextQuestion');

// NEW: after the last regular round comes the FINAL question — players may
// wager any whole number up to their current score.
await waitFor((s) => s.phase === 'question' && st.isFinal === true, 'final question started');
check('final question is flagged (isFinal)', st.isFinal === true);
check('final question has no fixed chips', st.wagerOptions == null);
const bBefore = st.players.find((p) => p.name === 'Blue Team').score; // 3+4+2+6+1+2 = 18
const rBefore = st.players.find((p) => p.name === 'Red Team').score; // +3 (Q5); Q6 no stake -> unchanged
check('pre-final scores (Blue 18, Red 3)', bBefore === 18 && rBefore === 3);

// Blue wagers more than their score -> must be rejected first.
blue.socket.emit('setWager', { points: 99 }); // over score -> rejected
await sleep(150);
check('final wager above own score is rejected', st.players.find((p) => p.name === 'Blue Team').wager == null);
// Blue wagers their entire score (18) and is correct -> +18. Red wagers all 3, wrong -> -3.
await playQuestion([[blue, 18], [red, 3]], [[blue, true], [red, false]]);
const bAfter = st.players.find((p) => p.name === 'Blue Team').score;
const rAfter = st.players.find((p) => p.name === 'Red Team').score;
check('final: Blue correct +18 (18 -> 36)', bAfter === 36);
check('final: Red wrong loses full stake (3 -> 0)', rAfter === 0);

host.emit('nextQuestion');
await waitFor((s) => s.phase === 'ended', 'game ended after final question');
check('game ended after the final question', st.phase === 'ended');

// --- Wager chip reuse is blocked within the same round -------------------
host.emit('startGame', { rounds: 1, perRound: 2, shuffleOn: false, keepScores: true });
await waitFor((s) => s.phase === 'question' && s.question, 'second game started');
const q = st.question;

// Blue spends chip 3 on this question (and answers, so the chip is spent).
blue.socket.emit('setWager', { points: 3 });
await sleep(150);
check('chip 3 accepted first time', st.players.find((p) => p.name === 'Blue Team').wager === 3);
blue.socket.emit('answer', { value: answerFor(q, true) });
host.emit('reveal');
await waitFor((s) => s.phase === 'reveal', 'reveal for chip test');

// Next question: chip 3 must be rejected (already used this game).
host.emit('nextQuestion');
await waitFor((s) => s.phase === 'question' && s.question.id !== q.id, 'advanced to Q2 of second game');
blue.socket.emit('setWager', { points: 3 });
await sleep(150);
check('reusing a spent chip is rejected (Blue still has no wager)', st.players.find((p) => p.name === 'Blue Team').wager == null);

// A fresh chip works.
blue.socket.emit('setWager', { points: 2 });
await sleep(150);
check('fresh chip accepted after spent one rejected', st.players.find((p) => p.name === 'Blue Team').wager === 2);

// --- No-stake forfeit + manual point adjustments -------------------------
const blueBefore = st.players.find((p) => p.name === 'Blue Team').score; // 39: carried in, +3 on Q1 of this game
red.socket.emit('answer', { value: answerFor(st.question, true) }); // Red answers but has NO stake
host.emit('reveal');
await waitFor((s) => s.phase === 'reveal', 'forfeit reveal');
check('no-stake answer is forfeited (Red shows no result)', st.players.find((p) => p.name === 'Red Team').correct == null);
check('forfeit costs nothing (Red score unchanged at 0)', st.players.find((p) => p.name === 'Red Team').score === 0);

// Manual points: host can award any positive or negative amount.
host.emit('awardPoints', { playerId: blue.id, points: -7 });
await sleep(150);
check('manual -7 applied (Blue score now ' + (blueBefore - 7) + ')', st.players.find((p) => p.name === 'Blue Team').score === blueBefore - 7);
host.emit('awardPoints', { playerId: blue.id, points: 25 });
await sleep(150);
check('manual +25 applied (Blue score now ' + (blueBefore + 18) + ')', st.players.find((p) => p.name === 'Blue Team').score === blueBefore + 18);

// --- Disconnect / rejoin keeps score -------------------------------------
red.socket.disconnect();
await waitFor((s) => s.players.find((p) => p.name === 'Red Team').online === false, 'player offline');
check('player marked offline after disconnect', st.players.find((p) => p.name === 'Red Team').online === false);

const redBefore = st.players.find((p) => p.name === 'Red Team').score;
const red2 = await makePlayer('Red Team');
await waitFor((s) => s.players.find((p) => p.name === 'Red Team').online === true, 'player back online');
check('rejoined Red Team kept score', st.players.find((p) => p.name === 'Red Team').score === redBefore);

blue.socket.disconnect();
red2 && red2.socket.disconnect();
host.close();

if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log('\nALL TESTS PASSED');
process.exit(0);
