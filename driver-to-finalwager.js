// Drives the game to the finalWagering phase and holds it there, so a real
// browser tab can be pointed at the player page to visually verify the UI.
import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:8091';
const HOLD_MS = Number(process.env.HOLD_MS || 30000);

function connect(role, name) {
  const s = io(URL, { query: { role }, transports: ['websocket'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    s.on('connect', () => { clearTimeout(t); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

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
const nodeP = await connect('player', 'NodePlayer');
nodeP.emit('join', { name: 'NodePlayer' });
const hostSt = makeTracker(host);
const pSt = makeTracker(nodeP);

// Wait for the browser player to join (it joins on page load).
await waitForState(hostSt, (s) => s.phase === 'lobby' && s.players.length >= 2, 'lobby w/ browser + node players');
console.log('players in lobby:', hostSt().players.map((p) => p.name).join(', '));

host.emit('startGame', { rounds: 1, perRound: 2, shuffleOn: false });
await waitForState(hostSt, (s) => s.phase === 'roundIntro', 'roundIntro');
host.emit('startNextRound');
await waitForState(pSt, (s) => s.phase === 'question' && !s.isFinal, 'Q1');

// Q1: both wager chip 1; node player answers correctly. Browser player may not answer — that's fine for this test.
nodeP.emit('setWager', { points: 1 });
const q1 = hostSt().question;
const q1Correct = q1.isMultipleChoice ? q1.correctIndex : q1.answerRaw;
nodeP.emit('answer', { value: q1Correct });
await waitForState(hostSt, (s) => s.players.find((p) => p.name === 'NodePlayer').answered, 'node answered Q1');
host.emit('reveal');
await waitForState(hostSt, (s) => s.phase === 'reveal', 'Q1 reveal');
host.emit('nextQuestion');
await waitForState(pSt, (s) => s.phase === 'question' && !s.isFinal, 'Q2');

// Q2: node wagers chip 2 and answers correctly.
nodeP.emit('setWager', { points: 2 });
const q2 = hostSt().question;
const q2Correct = q2.isMultipleChoice ? q2.correctIndex : q2.answerRaw;
nodeP.emit('answer', { value: q2Correct });
await waitForState(hostSt, (s) => s.players.find((p) => p.name === 'NodePlayer').answered, 'node answered Q2');
host.emit('reveal');
await waitForState(hostSt, (s) => s.phase === 'reveal', 'Q2 reveal');

// Next -> finalWagering. Hold here so the browser can inspect the player screen.
host.emit('nextQuestion');
const fw = await waitForState(hostSt, (s) => s.phase === 'finalWagering', 'finalWagering');
console.log('REACHED finalWagering — holding for', HOLD_MS, 'ms');
console.log('node player score:', hostSt().players.find((p) => p.name === 'NodePlayer').score);

await new Promise((r) => setTimeout(r, HOLD_MS));
host.close(); nodeP.close();
process.exit(0);
