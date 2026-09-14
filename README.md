# Trivia Night — QR-code trivia over your local network

A self-contained Node.js + Socket.IO app for live trivia nights. One device acts as
the **host** (controls questions, reveals answers, awards points); players join from
their phones by scanning a **QR code**. Everything updates in real time.

🌐 Website: [TriviaGameAI.com](https://triviagameai.com)

## Quick start

```bash
cd into the folder where you saved all the files from this repo
npm install        # already done if node_modules exists
node server.js
```

The server listens on port **8090** and prints:

- Host page : `http://<LAN-IP>:8090/host`  ← open this on your host device (laptop/phone)
- Players   : `http://<LAN-IP>:8090/`      ← encoded in the QR code shown on the host page

Open the host page, press **Start game**, and players scan the big QR to join.

## How a game works

A game is **rounds of questions** — by default **4 rounds × 4 questions = 16 total**.
The host can change both numbers in the setup panel before starting.

1. Host picks options (rounds, questions/round, shuffle) → **Start game**.
2. Players see "waiting" until the first question is sent; they pick their **wager**
   and type/pick an answer, then lock it in before time runs out.
3. Host presses **Reveal** — correct answers are highlighted for everyone, points
   update live on every screen (host scoreboard + player boards).
4. **Next** advances to the next question. The game flows straight into round 2 —
   after any later round's last question it pauses at a **"Round complete"** break
   and the host presses **Start next round** when ready (players see the same break
   with live standings).
5. After the final round, one **final question** is played: each player may wager
   any whole number of points from 0 up to their current score (double-or-nothing —
   correct adds it, wrong subtracts it). Then the game ends and final standings show
   to everyone.

The host can also **Skip** a question (no points), award **manual bonus points**, or
end the game early. Keyboard shortcuts on the host page: `R` = reveal, `N`/Enter =
next / start next round.

## Wagering & scoring

Each question is worth whatever a player stakes, not a fixed amount:

- Before answering, each player picks a **wager** (tap a chip). Odd rounds offer
  chips **1–4**; even rounds (2, 4, …) offer **2 / 4 / 6 / 8**.
- Each chip value can only be used **once per round** — whether the answer was
  right or wrong. Once you've staked your "2" on any question in a round it's
  spent and greyed out for the rest of that round; the pool resets at the start
  of every new round (and when a new game starts).
- You may change your pick freely *within* the current question; the chip is only
  locked in when the host reveals.
- **Correct → +wager**, **wrong → no penalty** in rounds 1–4. No wager picked = no points at stake either way.
- After all rounds there is one **final question**: each player may wager any whole number of points from **0 up to their current score**. It's double-or-nothing — correct adds the stake, wrong subtracts it (you can't go below 0).

So a confident player can swing big (+8 on an even round) while a cautious one plays
it safe (+1). The host panel shows every player's live stake and ✓/✗ result per question.

## Question file

Questions load from `trivia_latest.json` in this folder (257 multiple-choice
questions). To use a different file, set the `QUESTIONS_FILE` env var or edit
the `QUESTIONS_FILE` constant at the top of `server.js`.

## Endpoints

| Path | What it is |
|------|-----------|
| `/`      | Player page (what phones load from the QR) |
| `/host`  | Host control panel + QR code |
| `/qr.png`| The join QR as a PNG (800px, for printing) |

## Tests

```bash
node test-e2e.mjs   # needs the server running; simulates host + 2 players end-to-end
```

Covers: joining (+ join-ack), lobby, full game flow (3×2 with automatic advance
into round 2 and a host pause after later rounds), per-round wager options
(1–4 on odd rounds, 2/4/6/8 on even rounds), chip pick / reuse rejection within
a round / per-round pool reset / no-stake rule, scoring (correct adds the stake,
wrong never subtracts in rounds), the final question (wager any amount up to your
score — correct adds it, wrong subtracts it; over-score wagers rejected), and
disconnect/rejoin with score persistence. All 33 checks pass.

## Notes

- Players keep their identity and score if they drop off and re-scan (rejoin by name).
- The host page shows live "answered" dots per player during a question.
- No accounts, no build step — just `node server.js`.
