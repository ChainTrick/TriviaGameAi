// Ad-hoc verification: full default game (4 rounds x 4 questions + final).
// Confirms PER-ROUND chip options and reuse end to end: each chip value may be
// used once per round, the pool resets every round, wrong answers cost nothing.
import { io } from 'socket.io-client';

const URL = 'http://127.0.0.1:8090';
let failures = 0;
setTimeout(() => { console.error('GLOBAL TIMEOUT'); process.exit(1); }, 60000).unref();
function check(name, cond) { if (cond) console.log('PASS ', name); else { console.error('FAIL ', name); failures++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let st = null;
const host = io(URL, { query: { role: 'host' } });
host.on('state', (s) => { st = s; });
await new Promise((r) => host.on('connect', r));

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

const blue = await makePlayer('Verify Blue');
const red = await makePlayer('Verify Red');
check('players joined', !!(blue && red));

host.emit('startGame', { rounds: 4, perRound: 4, shuffleOn: false, keepScores: false });
await new Promise((resolve) => {
  const iv = setInterval(() => { if (st && st.phase === 'question' && st.question) { clearInterval(iv); resolve(); } }, 50);
});

const expectedOpts = [[1,2,3,4],[2,4,6,8],[1,2,3,4],[2,4,6,8]];
let blueScore = 0;
let redScore = 0;
// Chips each player spends per question (null = skip). The KEY regression:
// chips spent in an earlier round are available again — e.g. Blue uses 2 and
// 4 in round 1 AND again in round 2, where they are offered by the pool.
const bluePlan = [2, 4, null, 1,   // R1 (odd pool): 2/4/-/1
                  2, 4, 6, null,   // R2 (even pool): 2 and 4 REUSED from R1! + fresh 6
                  2, null, 3, null,// R3 (odd pool): 2 reused again; 3 fresh
                  8, 4, null, null]; // R4 (even pool): 8 fresh; 4 reused from R1/R2
const redPlan  = [1, null, 3, null, // R1: 1/-(chip 1 retried on Q2 -> rejected)/3/-
                  2, null, 4, 8,    // R2: 2 fresh (new round), 4 and 8 fresh
                  1, null, null, null, // R3: only chip 1; rest skipped
                  null, null, null, null]; // R4: all skipped

for (let rnd = 1; rnd <= 4; rnd++) {
  for (let qi = 1; qi <= 4; qi++) {
    const n = (rnd - 1) * 4 + (qi - 1); // global question number, 0-based
    check(`R${rnd}Q${qi}: options ${expectedOpts[rnd-1].join('/')}`, JSON.stringify(st.wagerOptions) === JSON.stringify(expectedOpts[rnd-1]));

    const blueP = st.players.find((p) => p.name === 'Verify Blue');
    const redP  = st.players.find((p) => p.name === 'Verify Red');
    const blueUsed = new Set(blueP.wagersUsed); // chips spent THIS round only
    const redUsed  = new Set(redP.wagersUsed);

    // Blue: wager the planned chip, or skip. A chip used in an EARLIER round
    // must be accepted here (per-round reset) — that's the whole point of the fix.
    const blueWager = bluePlan[n];
    if (blueWager != null) {
      check(`R${rnd}Q${qi}: Blue chip ${blueWager} not spent this round`, !blueUsed.has(blueWager));
      blue.socket.emit('setWager', { points: blueWager });
      await sleep(120);
      check(`R${rnd}Q${qi}: Blue accepted chip ${blueWager}`, st.players.find((p) => p.name === 'Verify Blue').wager === blueWager);
    }

    // Red: same plan. On R1Q2 the plan is null but we explicitly retry chip 1,
    // which was spent earlier in THIS round -> must be rejected (no reset mid-round).
    const redWager = redPlan[n];
    if (redWager != null) {
      check(`R${rnd}Q${qi}: Red chip ${redWager} not spent this round`, !redUsed.has(redWager));
      red.socket.emit('setWager', { points: redWager });
      await sleep(120);
      check(`R${rnd}Q${qi}: Red accepted chip ${redWager}`, st.players.find((p) => p.name === 'Verify Red').wager === redWager);
    } else if (n === 1 && rnd === 1 && qi === 2) {
      // R1Q2: retry chip 1 spent on R1Q1 -> rejected within the same round.
      check('R1Q2: Red has chip 1 spent this round', redUsed.has(1));
      red.socket.emit('setWager', { points: 1 });
      await sleep(120);
      check('R1Q2: Red retry of chip 1 (same round) rejected', st.players.find((p) => p.name === 'Verify Red').wager == null);
    }

    // Both answer correctly.
    const q = st.question;
    blue.socket.emit('answer', { value: q.isMultipleChoice ? q.correctIndex : q.answerRaw });
    red.socket.emit('answer', { value: q.isMultipleChoice ? q.correctIndex : q.answerRaw });
    host.emit('reveal');
    await new Promise((resolve) => {
      const iv = setInterval(() => { if (st && st.phase === 'reveal') { clearInterval(iv); resolve(); } }, 50);
    });

    // Correct -> +wager. No wager -> score unchanged.
    if (blueWager != null) blueScore += blueWager;
    check(`R${rnd}Q${qi}: Blue score now ${blueScore}`, st.players.find((p) => p.name === 'Verify Blue').score === blueScore);
    if (redWager != null) redScore += redWager;
    check(`R${rnd}Q${qi}: Red score now ${redScore}`, st.players.find((p) => p.name === 'Verify Red').score === redScore);

    // The spent chip must show up in the used list right after reveal.
    if (blueWager != null) {
      const blueAfter = new Set(st.players.find((p) => p.name === 'Verify Blue').wagersUsed);
      check(`R${rnd}Q${qi}: Blue's spent chip ${blueWager} now in used list`, blueAfter.has(blueWager));
    }

    host.emit('nextQuestion');
    await new Promise((resolve) => {
      const iv = setInterval(() => { if (st && ((st.phase === 'question' && st.questionInRound !== qi) || st.phase === 'roundEnd')) { clearInterval(iv); resolve(); } }, 50);
    });

    // The used list must reset at the start of each new round.
    if (qi === 4 && rnd < 4) {
      const nextRnd = rnd + 1;
      await new Promise((resolve) => {
        const iv = setInterval(() => { if (st && st.phase === 'question' && st.currentRound === nextRnd) { clearInterval(iv); resolve(); } }, 50);
      });
    }
  }
  // After rounds 2 and 3 there is a host pause; after round 1 it auto-advances,
  // and after round 4 the game pauses at "round complete" — the host then
  // presses "Play final question 🏆".
  if (rnd < 4 && rnd > 1) {
    check(`after R${rnd}: paused at roundEnd`, st.phase === 'roundEnd');
    host.emit('startNextRound');
    await new Promise((resolve) => {
      const iv = setInterval(() => { if (st && st.phase === 'question' && st.currentRound === rnd + 1) { clearInterval(iv); resolve(); } }, 50);
    });
  } else if (rnd === 4) {
    check('after R4: paused at roundEnd awaiting final question', st.phase === 'roundEnd');
    host.emit('startNextRound'); // "Play final question 🏆"
    await new Promise((resolve) => {
      const iv = setInterval(() => { if (st && st.isFinal === true && st.phase === 'question') { clearInterval(iv); resolve(); } }, 50);
    });
    check('final question started after host press', st.isFinal === true && st.phase === 'question');
  } else {
    check('after R1: auto-advanced to round 2', st.phase === 'question' && st.currentRound === 2);
  }

  // Fresh pool at the start of every new round (checked right after advancing).
  if (rnd < 4) {
    const bUsed = st.players.find((p) => p.name === 'Verify Blue').wagersUsed;
    const rUsed = st.players.find((p) => p.name === 'Verify Red').wagersUsed;
    check(`after R${rnd}: used lists reset for round ${rnd + 1}`, bUsed.length === 0 && rUsed.length === 0);
  }
}

// Final question: wager up to full score.
check('final: no fixed chips', st.wagerOptions == null);
const bScore = st.players.find((p) => p.name === 'Verify Blue').score; // 2+4+1 + 2+4+6 + 2+3 + 8+4 = 36
check('final: Blue score is 36', bScore === 36);

// While Red has not wagered yet, the question text must be hidden from players.
const blueSockState = await new Promise((resolve) => {
  const iv = setInterval(() => { if (st && st.isFinal && st.phase === 'question') { clearInterval(iv); resolve(st); } }, 50);
});
check('final: category visible to host', !!blueSockState.question.category);

// Player-side view: text hidden until everyone has wagered.
const playerView = await new Promise((resolve) => {
  const p = io(URL, { query: { role: 'player' } });
  let seen = null;
  p.on('state', (s) => { if (!seen && s.isFinal && s.phase === 'question') seen = s; });
  p.emit('join', { name: 'Verify Blue' }); // re-adopt identity
  const iv = setInterval(() => { if (seen) { clearInterval(iv); resolve(seen); } }, 50);
  setTimeout(() => { clearInterval(iv); resolve(null); }, 4000);
});
check('final: player sees category while text hidden', !!playerView && !!playerView.question.category);
check('final: player question text hidden before all wagered', !!playerView && playerView.question.text === '');

// Over-score wager rejected, full score accepted.
blue.socket.emit('setWager', { points: bScore + 1 }); // over score -> rejected
await sleep(120);
check('final: wager above score rejected', st.players.find((p) => p.name === 'Verify Blue').wager == null);
blue.socket.emit('setWager', { points: bScore }); // full score ok
await sleep(120);
check(`final: Blue wagers full score ${bScore}`, st.players.find((p) => p.name === 'Verify Blue').wager === bScore);

// Red must also wager for the text to unlock — give them a small stake.
const rScore = st.players.find((p) => p.name === 'Verify Red').score; // 1+3 + 2+4+8 + 1 = 19
red.socket.emit('setWager', { points: Math.min(5, rScore) });
await sleep(120);

// Now every player has wagered -> the question text is visible to players.
const unlockedView = await new Promise((resolve) => {
  const iv = setInterval(() => { if (st && st.isFinal && st.phase === 'question' && st.question.text) { clearInterval(iv); resolve(st); } }, 50);
});
check('final: question text visible after all players wagered', !!unlockedView && unlockedView.question.text.length > 0);

const q = st.question;
blue.socket.emit('answer', { value: q.isMultipleChoice ? q.correctIndex : q.answerRaw });
red.socket.emit('answer', { value: q.isMultipleChoice ? q.correctIndex : q.answerRaw });
host.emit('reveal');
await new Promise((resolve) => {
  const iv = setInterval(() => { if (st && st.phase === 'reveal') { clearInterval(iv); resolve(); } }, 50);
});
check(`final: Blue correct doubles score (${bScore} -> ${2 * bScore})`, st.players.find((p) => p.name === 'Verify Blue').score === 2 * bScore);

host.emit('nextQuestion');
await new Promise((resolve) => {
  const iv = setInterval(() => { if (st && st.phase === 'ended') { clearInterval(iv); resolve(); } }, 50);
});
check('game ended', st.phase === 'ended');

blue.socket.disconnect(); red.socket.disconnect(); host.close();
if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log('\nALL FULL-GAME CHECKS PASSED');
process.exit(0);
