// Full default game, end to end: 4 rounds x 4 questions + the final
// double-or-nothing question. What this verifies on a FIXED-format game:
//   • per-round chip pools (1-4 on odd rounds, 2/4/6/8 on even rounds)
//   • each chip value spendable ONCE PER ROUND, resetting every round
//   • a stake is REQUIRED — no stake forfeits the question (no result mark,
//     nothing gained or lost) even if the answer was right
//   • correct answers pay the stake, wrong answers cost nothing in the rounds
//   • every round is 4 different categories and no question repeats
//   • round-boundary pauses, then the final question (wager up to your score)
//
// Run while the server is up:  node test-full-game.mjs
import { io } from 'socket.io-client';

const URL = process.env.TRIVIA_URL || 'http://127.0.0.1:8090';
let failures = 0;
setTimeout(() => { console.error('GLOBAL TIMEOUT'); process.exit(1); }, 170000).unref();
function check(name, cond) { if (cond) console.log('PASS ', name); else { console.error('FAIL ', name); failures++; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let st = null;
const host = io(URL, { query: { role: 'host' } });
host.on('state', (s) => { st = s; });
await new Promise((r) => host.on('connect', r));
function waitFor(fn, label, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = fn(st); } catch (e) {}
      if (ok) { clearInterval(iv); resolve(st); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout: ${label}`)); }
    }, 40);
  });
}
const P = (n) => st.players.find((p) => p.name === n);
function answerFor(q, correct) {
  if (q.isMultipleChoice) return correct ? q.correctIndex : ((q.correctIndex + 1) % q.options.length);
  return correct ? q.answerRaw : 'zzz definitely not';
}

async function makePlayer(name) {
  const p = io(URL, { query: { role: 'player' } });
  const obj = { socket: p, id: null };
  let ack = null;
  p.on('joined', (a) => { ack = a; obj.id = a.playerId; });
  p.emit('join', { name });
  return new Promise((resolve) => {
    const iv = setInterval(() => { if (ack) { clearInterval(iv); resolve(obj); } }, 40);
    setTimeout(() => { clearInterval(iv); resolve(obj); }, 4000);
  });
}

host.emit('resetAll'); // start from a clean lobby so only our players are here
await waitFor((s) => s.phase === 'lobby' && s.players.length === 0, 'reset');
const blue = await makePlayer('Verify Blue');
const red = await makePlayer('Verify Red');
check('players joined', !!(blue && red));
await waitFor((s) => P('Verify Blue') && P('Verify Red'), 'both players in lobby');

host.emit('startGame', { keepScores: false });
await waitFor((s) => s.phase === 'roundIntro', 'round 1 intro');
check('fixed format: 4 rounds x 4 questions', st.totalRounds === 4 && st.questionsPerRound === 4);
check('round 1 intro announces 4 unique categories',
  (st.upcomingCategories || []).length === 4 &&
  new Set((st.upcomingCategories || []).map((c) => String(c).toLowerCase())).size === 4);

const expectedOpts = [[1, 2, 3, 4], [2, 4, 6, 8], [1, 2, 3, 4], [2, 4, 6, 8]];
let blueScore = 0;
let redScore = 0;
// Chips each player spends per question (null = NO STAKE -> forfeited question).
// Chips spent in an EARLIER round must be offered again (per-round reset).
const bluePlan = [2, 4, null, 1,    // R1 (odd pool): 2/4/forfeit/1
                  2, 4, 6, null,    // R2 (even pool): 2 and 4 REUSED from R1 + fresh 6 / forfeit
                  2, null, 3, null, // R3 (odd pool): 2 reused again; 3 fresh; forfeits
                  8, 4, null, null]; // R4 (even pool): 8 fresh; 4 reused from R1/R2; forfeits
const redPlan = [1, null, 3, null,  // R1: 1 / (chip-1 retry rejected) / 3 / forfeit
                 2, null, 4, 8,     // R2: fresh 2, forfeit, 4 and 8
                 1, null, null, null, // R3: only chip 1; rest forfeited
                 null, null, null, null]; // R4: all forfeited
const seenQuestionIds = [];
const seenCatsPerRound = {};

for (let rnd = 1; rnd <= 4; rnd++) {
  // The game opens on round 1's intro screen; press Start round to begin.
  if (st.phase === 'roundIntro') {
    host.emit('startNextRound');
    await sleep(50);
  }
  await waitFor((s) => s.phase === 'question' || s.isFinal, 'round start', 20000);
  for (let qi = 1; qi <= 4; qi++) {
    const n = (rnd - 1) * 4 + (qi - 1); // global question number, 0-based
    check(`R${rnd}Q${qi}: options ${expectedOpts[rnd - 1].join('/')}`, JSON.stringify(st.wagerOptions) === JSON.stringify(expectedOpts[rnd - 1]));
    seenQuestionIds.push(st.question.id);
    (seenCatsPerRound[rnd] = seenCatsPerRound[rnd] || []).push(st.question.category);

    const blueUsed = new Set(P('Verify Blue').wagersUsed); // chips spent THIS round only
    const redUsed = new Set(P('Verify Red').wagersUsed);

    // Blue: wager the planned chip, or skip. A chip used in an EARLIER round
    // must be accepted here (per-round reset) — that's the point of the rule.
    const blueWager = bluePlan[n];
    if (blueWager != null) {
      check(`R${rnd}Q${qi}: Blue chip ${blueWager} not spent this round`, !blueUsed.has(blueWager));
      blue.socket.emit('setWager', { points: blueWager });
      await sleep(140);
      check(`R${rnd}Q${qi}: Blue accepted chip ${blueWager}`, P('Verify Blue').wager === blueWager);
    }

    // Red: same plan. On R1Q2 the plan is null but we explicitly retry chip 1,
    // which was spent earlier in THIS round -> must be rejected.
    const redWager = redPlan[n];
    if (redWager != null) {
      check(`R${rnd}Q${qi}: Red chip ${redWager} not spent this round`, !redUsed.has(redWager));
      red.socket.emit('setWager', { points: redWager });
      await sleep(140);
      check(`R${rnd}Q${qi}: Red accepted chip ${redWager}`, P('Verify Red').wager === redWager);
    } else if (n === 1 && rnd === 1 && qi === 2) {
      check('R1Q2: Red has chip 1 spent this round', redUsed.has(1));
      red.socket.emit('setWager', { points: 1 });
      await sleep(140);
      check('R1Q2: Red retry of chip 1 (same round) rejected', P('Verify Red').wager == null);
    }

    // Both answer correctly — even on forfeited questions (no stake), to prove
    // that an answer without a stake earns nothing and shows no result mark.
    const q = st.question;
    blue.socket.emit('answer', { value: q.isMultipleChoice ? q.correctIndex : q.answerRaw });
    red.socket.emit('answer', { value: q.isMultipleChoice ? q.correctIndex : q.answerRaw });
    await sleep(100);
    host.emit('reveal');
    await waitFor((s) => s.phase === 'reveal', 'reveal');

    // Correct -> +wager. No wager -> forfeit: score unchanged, no result mark.
    if (blueWager != null) blueScore += blueWager;
    check(`R${rnd}Q${qi}: Blue score now ${blueScore}`, P('Verify Blue').score === blueScore);
    if (redWager != null) redScore += redWager;
    check(`R${rnd}Q${qi}: Red score now ${redScore}`, P('Verify Red').score === redScore);
    if (blueWager == null) check(`R${rnd}Q${qi}: Blue forfeit shows no result mark`, P('Verify Blue').correct == null);
    if (redWager == null) check(`R${rnd}Q${qi}: Red forfeit shows no result mark`, P('Verify Red').correct == null);

    // The spent chip must show up in the used list right after reveal.
    if (blueWager != null) {
      check(`R${rnd}Q${qi}: Blue's spent chip ${blueWager} now in used list`, new Set(P('Verify Blue').wagersUsed).has(blueWager));
    }

    host.emit('nextQuestion');
    if (qi < 4) {
      await waitFor((s) => s.phase === 'question' && s.questionInRound === qi + 1, `R${rnd}Q${qi + 1} starts`);
    }
  }

  // End of the round: the game pauses on the "Round N" intro screen (every
  // round, including the last one before the final question).
  await waitFor((s) => s.phase === 'roundIntro' || s.isFinal, 'round boundary');
  if (rnd < 4) {
    check(`after R${rnd}: paused on the round intro screen`, st.phase === 'roundIntro' && st.introRound === rnd + 1);
    check(`after R${rnd}: intro announces 4 unique categories for round ${rnd + 1}`,
      (st.upcomingCategories || []).length === 4 &&
      new Set((st.upcomingCategories || []).map((c) => String(c).toLowerCase())).size === 4);
    host.emit('startNextRound');
    await waitFor((s) => s.phase === 'question' && s.currentRound === rnd + 1, `round ${rnd + 1} starts`);
    // Fresh chip pool for the new round (nothing spent yet).
    check(`after R${rnd}: used lists reset for round ${rnd + 1}`, P('Verify Blue').wagersUsed.length === 0 && P('Verify Red').wagersUsed.length === 0);
  }
}

check('all 16 questions were unique', new Set(seenQuestionIds).size === 16);
for (const rn of Object.keys(seenCatsPerRound)) {
  const cats = seenCatsPerRound[rn];
  check(`round ${rn}: 4 DIFFERENT categories (${cats.join(' / ')})`,
    cats.length === 4 && new Set(cats.map((c) => String(c).toLowerCase())).size === 4);
}

// After round 4's last question the game ends its rounds and opens the final
// question's wagering screen (host sees the question, players see the wager box).
await waitFor((s) => s.isFinal === true && s.phase === 'finalWagering', 'final question start', 20000);
check('final question: opened straight after round 4', st.isFinal === true && st.phase === 'finalWagering');

// Final question: wager up to full score.
check('final: no fixed chips', st.wagerOptions == null);
const bScore = P('Verify Blue').score; // 2+4+1 + 2+4+6 + 2+3 + 8+4 = 36
const rScore = P('Verify Red').score;  // 1+3 + 2+4+8 + 1 = 19
check(`final: Blue score is ${bScore}`, bScore === 36);
check(`final: Red score is ${rScore}`, rScore === 19);

// While nobody has wagered, the question text must be hidden from players.
// The host always sees the final question; PLAYERS see only its category until
// every wager is in and the host shows it.
check('final: host can read the question while players cannot', !!st.question.category && st.question.text.length > 0);
let spectator = null;
const playerState = await new Promise((resolve) => {
  const p = io(URL, { query: { role: 'player' } }); // never joins, so it takes no identity
  spectator = p;
  let seen = null;
  // A player socket is only served state once it has joined, so join under a
  // throwaway name to inspect exactly what a player's phone is shown.
  p.on('state', (s) => { if (!seen && s.isFinal) seen = s; });
  p.emit('join', { name: 'Spectator' });
  const iv = setInterval(() => { if (seen) { clearInterval(iv); resolve(seen); } }, 50);
  setTimeout(() => { clearInterval(iv); resolve(null); }, 4000);
});
check('final: a player socket sees only the category, not the text',
  !!playerState && !!playerState.question.category && playerState.question.text === '' && playerState.question.options.length === 0);
// Drop the spectator again — it must not hold up the "everyone has wagered" gate.
spectator && spectator.disconnect();
await sleep(200);

// Over-score wager rejected, full score accepted.
blue.socket.emit('setWager', { points: bScore + 1 });
await sleep(140);
check('final: wager above score rejected', P('Verify Blue').wager == null);
blue.socket.emit('setWager', { points: bScore });
await sleep(140);
check(`final: Blue wagers full score ${bScore}`, P('Verify Blue').wager === bScore);

// The spectator above joined under a throwaway name; a real venue wouldn't hold
// the whole room's final question for a phone that left, so drop it (as it would
// if they closed the tab) before the gate check.
await waitFor((s) => P('Spectator') && P('Spectator').online === false, 'spectator offline');
const spect = st.players.find((p) => p.name === 'Spectator');
host.emit('kickPlayer', { playerId: spect.id }); // server drops them from the game
await waitFor((s) => !s.players.some((p) => p.name === 'Spectator'), 'spectator removed');

// Red must wager too before the host can show the question.
red.socket.emit('setWager', { points: 5 });
await waitFor((s) => P('Verify Red').wager === 5, 'red final wager lands');
await waitFor((s) => s.allPlayersWagered === true, 'all final wagers in');
check('every player has a final stake', st.players.every((p) => p.wager != null));

// The host shows the final question to everyone, then it plays out normally.
host.emit('showFinalQuestion');
await waitFor((s) => s.phase === 'question' && s.isFinal && s.question.text, 'final question shown');
check('final: question text visible once every player has wagered', st.question.text.length > 0);

const q = st.question;
blue.socket.emit('answer', { value: answerFor(q, true) });
red.socket.emit('answer', { value: answerFor(q, false) });
await sleep(100);
host.emit('reveal');
await waitFor((s) => s.phase === 'reveal', 'final reveal');
check(`final: Blue correct doubles their stake (${bScore} -> ${2 * bScore})`, P('Verify Blue').score === 2 * bScore);
const redStake = 5;
check(`final: Red wrong loses their stake (${rScore} -> ${rScore - redStake})`, P('Verify Red').score === rScore - redStake);

host.emit('nextQuestion');
await waitFor((s) => s.phase === 'ended', 'game ended');
check('game ended after the final question', st.phase === 'ended');

blue.socket.disconnect(); red.socket.disconnect(); host.close();
if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log('\nALL FULL-GAME CHECKS PASSED');
process.exit(0);
