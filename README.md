# Jeopardy

A self-hosted, fully customizable Jeopardy game platform. Build your own boards, host game nights in person or online, and let players buzz in from their phones — no app install required.

Hardware buzzer Phase 1: see [setup, protocol, simulator, and tests](docs/hardware-buzzers.md)
and the [wireless buzzer gameplan](docs/hardware-buzzer-gameplan.md).

---

## Features

- **Board Editor** — Create unlimited Jeopardy boards with up to 6 categories and 5 clues each per round. Supports text, images, and video clues.
- **Multi-Round Boards** — A board can hold several rounds (Jeopardy!, Double Jeopardy!, and beyond). Players, scores, and stats all carry over when the host advances to the next round — no need to start a new game.
- **Real-time Buzzer System** — Players connect on any device via a browser. First buzz wins, ties are impossible. A configurable lockout (250/500/1000ms, or off) penalizes buzzing before the host opens it, so mashing the button no longer beats reacting to it.
- **Daily Doubles with Wagering** — Mark any clue as a Daily Double. The host reveals it and the game automatically prompts the right player to wager on their phone (with a host override, and a manual picker for the rare case no player has answered correctly yet) — scoring then uses their wager instead of the clue's face value.
- **Final Jeopardy** — A full wager-clue-reveal round with live wagers, a synced countdown timer, ambient music during the countdown, a dramatic per-contestant reveal, and a final scoreboard with a podium and stats.
- **End-Game Lifecycle** — The game ends automatically once the last round is finished (if the board has no Final Jeopardy), or the host can end it manually at any point, including mid-Final-Jeopardy. A shared leaderboard — with tie handling — shows on every screen, and the host can resume or close the room from there.
- **Projection View** — A fullscreen board view designed for a TV or shared screen.
- **Host Control Panel** — Score tracking, manual score adjustments, game history log, per-player stats (including early buzzes), and roll-back support.
- **Sound Effects** — Synthesized audio cues for buzz-ins, Daily Doubles, Final Jeopardy, and more, played on the board/TV so the room hears them. No audio files needed.
- **Persistent Storage** — Boards are saved as JSON files on disk. No database required. Older single-round board files are migrated automatically.
- **Works Everywhere** — Run it on your laptop for an in-person game night, or deploy it to the cloud for a remote game night. Players connect from anywhere with a link.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                        One Server                           │
│                                                             │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│   │  Host Panel  │   │ Board (TV)   │   │Player Buzzer │    │
│   │ /host/:room  │   │/board/:room  │   │/buzzer/:room │    │
│   └──────────────┘   └──────────────┘   └──────────────┘    │
│          │                  │                  │            │
│          └──────────────────┴──────────────────┘            │
│                        Socket.io                            │
└─────────────────────────────────────────────────────────────┘
```

The host runs the game from the Host Panel. The board display goes on the main screen (TV/projector). Players connect to the Buzzer page from their phones — no account, no install, just a URL and a name.

---

## Quick Start (Local)

**Prerequisites:** Node.js 18+

```bash
# 1. Clone and install
git clone https://github.com/Surge-Tech/jeopardy.git
cd jeopardy
npm run install:all

# 2. Start development servers
npm run dev
```

- **Dashboard / Editor:** http://localhost:5173
- **Share with players (LAN):** http://YOUR_LAN_IP:5173

> For a full local + deployment guide, see [SETUP.md](SETUP.md). For the REST API and Socket.io event reference, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Deployment (Fly.io — Free Tier)

```bash
fly launch          # first time setup
fly deploy          # deploy or redeploy
```

Players connect to your `https://your-app.fly.dev` URL from anywhere. Full instructions in [SETUP.md](SETUP.md).

---

## Project Structure

```
jeopardy/
├── backend/
│   ├── src/
│   │   ├── index.ts            # Express server + static file serving
│   │   ├── routes/
│   │   │   ├── boards.ts       # Board CRUD API
│   │   │   └── media.ts        # Image/video upload
│   │   ├── socket/
│   │   │   ├── gameManager.ts    # In-memory game sessions
│   │   │   ├── socketHandler.ts  # Core game + buzzer + Daily Double events
│   │   │   └── finalJeopardy.ts  # Final Jeopardy state machine + events
│   │   └── storage/
│   │       └── boardStorage.ts # JSON file persistence
│   └── package.json
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.tsx   # Board list + create/delete
│       │   ├── Editor.tsx      # Board editor
│       │   ├── Host.tsx        # Host control panel
│       │   ├── BoardView.tsx   # Projection screen
│       │   └── Buzzer.tsx      # Player buzzer / wager (phone)
│       ├── components/
│       │   ├── final/          # Final Jeopardy: board screens, host panel, editor
│       │   ├── dailydouble/    # Daily Double: host panel, player wager screen
│       │   └── shared/         # WagerInput, Leaderboard — reused across FJ and end-game
│       ├── store/
│       │   └── gameStore.ts    # Zustand state (game log, etc.)
│       └── utils/
│           ├── sounds.ts       # Web Audio API sound effects
│           └── rounds.ts       # Round-aware board helpers (getRound, isRoundComplete)
├── Dockerfile
├── docker-compose.yml
├── fly.toml
└── SETUP.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, Socket.io |
| Frontend | React, Vite, Tailwind CSS, Zustand |
| Realtime | Socket.io (WebSockets) |
| Storage | JSON files on disk (no database) |
| Deployment | Docker, Fly.io |

---

## Documentation

| Doc | For |
|---|---|
| [SETUP.md](SETUP.md) | Running a game night — local, LAN, Fly.io, or Docker. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Contributors — data model, REST API, and the full Socket.io event protocol. |

---

## License

MIT — free to use, modify, and distribute. See [LICENSE](LICENSE).
