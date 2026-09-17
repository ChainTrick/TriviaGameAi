# TriviaGameAi — live trivia over the internet

A self-contained Node.js + Socket.IO app for live trivia nights. One device acts as
the **host** (controls questions, reveals answers, awards points); players join from
their phones by scanning a **QR code** or opening the link — no shared network needed
if you expose the server with a public URL. Everything updates in real time.

🌐 Website: [TriviaGameAi.com](https://triviagameai.com)

## Installation & running (3 steps)

You only need **[Node.js](https://nodejs.org)** installed — that's the one prerequisite.
Check it with `node -v` in a terminal (any recent version works).

### Step 1 — Get the code

Either download this repo as a ZIP from GitHub, or clone it:

```bash
git clone https://github.com/ChainTrick/TriviaGameAi.git
cd TriviaGameAi
```

(If you downloaded a ZIP instead, just open that folder in your terminal.)

### Step 2 — Install the dependencies

Run this once inside the project folder:

```bash
npm install
```

### Step 3 — Start the game server

```bash
node server.js
```

That's it! The server listens on port **8090** and prints:

- Host page : `http://<LAN-IP>:8090/host` (or your `PUBLIC_URL`/host path if set) ← open this on your host device (laptop/phone)
- Players   : the join URL, e.g. `https://your-public-url.example.com/` — shown as a link on the host page

Open the host page, press **Start game**, and players tap the join link or "Show QR code"
(which opens a new window with the QR) to join from anywhere.

## Running it as a background service (Linux)

You can run the server as a systemd **user** service so it auto-starts on login.
Create `~/.config/systemd/user/triviagame.service` with your own paths and URL:

```ini
[Unit]
Description=TriviaGameAi — trivia game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/this/folder
Environment=PORT=8090
# Optional: set your public URL here so the QR code points at it.
# Environment=PUBLIC_URL=https://your-public-url.example.com
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Then install and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now triviagame     # start now + auto-start on login
```

Manage it with:

```bash
systemctl --user status triviagame          # is it running?
journalctl --user -u triviagame -f          # live logs (Ctrl-C to stop watching)
systemctl --user restart triviagame         # apply changes / bounce the server
systemctl --user stop triviagame            # stop it
```

> Note: a user service only runs while your account is logged in. If you want it to
> survive logout, either keep a session open or move the unit to
> `/etc/systemd/system/` (root) and adjust `WorkingDirectory` accordingly.

## Public URL / QR code

The host page's QR encodes whatever `PUBLIC_URL` is set to:

- **LAN only** (default): no env var → QR uses your LAN IP, e.g. `http://192.168.x.x:8090/`.
- **Public**: set `PUBLIC_URL=https://your-public-url.example.com` so players on other
  networks can join through whatever tunnel or reverse proxy you use (Cloudflare
  Tunnel, Tailscale serve/funnel, etc.).

To change it, edit the `Environment=PUBLIC_URL=...` line in your installed unit and run
`systemctl --user daemon-reload && systemctl --user restart triviagame`.

## Screenshots

**Host view** — control questions, reveal answers, share the join QR code, and manage scores:

![Host dashboard](Screenshot_host.png)

**Player view** (on a phone) — pick your wager, answer before time runs out, and watch the live scoreboard:

![Player screen](Screenshot_player.png)

## How a game works

A game is **rounds of questions** — by default **4 rounds × 4 questions = 16 total**.
The host can change both numbers in the setup panel before starting.

1. Host picks options (rounds, questions/round, shuffle) → **Start game**.
2. Players see "waiting" until the first question is sent; they pick their **wager**
   (required — no stake means the question is forfeited), type/pick an answer, then
   lock it in before time runs out.
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
- **A stake is required**: players must pick a chip before they can answer — no
  stake means the question is forfeited (nothing gained or lost either way).
- **Correct → +wager**, **wrong → no penalty** in rounds 1–4.
- After all rounds there is one **final question**: each player may wager any whole number of points from **0 up to their current score**. It's double-or-nothing — correct adds the stake, wrong subtracts it (you can't go below 0).

So a confident player can swing big (+8 on an even round) while a cautious one plays
it safe (+1). The host panel shows every player's live stake and ✓/✗ result per question.

## Question file

Questions load from `trivia_sorted_categories.json` in this folder (257 multiple-choice
questions, consolidated into 13 standardized categories). To use a different file, set the `QUESTIONS_FILE` env var or edit
the `QUESTIONS_FILE` constant at the top of `server.js`.

## Endpoints

| Path | What it is |
|------|-----------|
| `/`      | Player page (what phones load from the QR) |
| `/host`  | Host control panel + join link / "Show QR code" button |
| `/qr`    | Standalone QR popup page (opened in a new window by the host) |
| `/qr.png`| The join QR as a PNG (800px, for printing) |
| `/join-info` | JSON with the current join URL (used by `/qr`) |

## Tests

```bash
node test-e2e.mjs        # needs the server running; simulates host + 2 players end-to-end
node test-full-game.mjs  # full default game (4 rounds x 4 questions + final question)
```

`test-e2e.mjs` covers: joining (+ join-ack), lobby, full game flow (3×2 with automatic advance
into round 2 and a host pause after later rounds), per-round wager options
(1–4 on odd rounds, 2/4/6/8 on even rounds), chip pick / reuse rejection within
a round / per-round pool reset, the **required-stake rule** (no stake = forfeited question,
nothing gained or lost; answers without a stake earn nothing), scoring (correct adds the
stake, wrong never subtracts in rounds), manual point adjustments by the host (any positive
or negative amount), the final question (wager any amount up to your score — correct adds it,
wrong subtracts it; over-score wagers rejected), and disconnect/rejoin with score persistence.

`test-full-game.mjs` plays a complete default game end-to-end: required stakes on every
question, per-round chip reuse, forfeits, round-boundary pauses, the final question, and
final standings. Both suites pass fully.

## Notes

- Players keep their identity and score if they drop off and re-scan (rejoin by name).
- The host page shows live "answered" dots per player during a question.
- No accounts, no build step — just `node server.js`.
