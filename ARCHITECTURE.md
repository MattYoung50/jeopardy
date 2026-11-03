# Architecture

A developer reference for how the pieces fit together: the data model, the REST API, and the Socket.io event protocol that drives the game in real time. If you're setting up or hosting a game, see [README.md](README.md) and [SETUP.md](SETUP.md) instead — this doc is for anyone changing or extending the code.

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model](#data-model)
3. [Storage Layout](#storage-layout)
4. [REST API](#rest-api)
5. [Real-Time Protocol (Socket.io)](#real-time-protocol-socketio)
6. [State Machines](#state-machines)
   - [Buzzer](#buzzer)
   - [Daily Double](#daily-double)
   - [Final Jeopardy](#final-jeopardy-finalstage)
   - [Rounds](#rounds)
   - [Phase / end-game](#phase--end-game)

---

## Overview

There is one backend process (Express + Socket.io) and one frontend build (React SPA). Boards are edited and games are administered over plain REST; everything that happens *during* a live game — buzzing in, scoring, Daily Double wagers, Final Jeopardy — happens over Socket.io, because every connected client (host, board/TV, each player's phone) needs to see state changes the instant they happen.

```
frontend/src/pages/*        REST calls (boards, media)  ──►  backend/src/routes/*
frontend/src/socket.ts      Socket.io client            ──►  backend/src/socket/*
```

Game sessions are **in-memory only** (`backend/src/socket/gameManager.ts`), keyed by room code — restarting the server ends all live games. Boards, by contrast, are persisted to disk as JSON (`backend/src/storage/boardStorage.ts`), so editor content survives restarts.

---

## Data Model

Canonical types live in `backend/src/types.ts` (frontend has a mirrored copy in `frontend/src/types.ts`).

| Type | Purpose |
|---|---|
| `Board` | A saved board: a list of `rounds`, optional Final Jeopardy config. Persisted to disk. |
| `Round` | One grid: `{ id, name?, categories, pointValues }`. A board plays through `rounds` in order (Jeopardy!, Double Jeopardy!, ...). |
| `Category` / `Question` | A round's grid content. A `Question` may be flagged `isDailyDouble`. Question ids are UUIDs, unique across the whole board (not just within a round) — this is what lets `answeredQuestions` stay a single flat list while still being able to tell whether a *specific round* is complete. |
| `GameState` | The full state of one live session: players, buzzer state (incl. `buzzLockouts` and the configurable `settings.lockoutMs`), active question, `currentRoundIndex`, Daily Double sub-state, Final Jeopardy public sub-state, `phase`. Broadcast wholesale to every client on every change via `game:state`. |
| `Player` | `{ id, name, score, color, stats? }`. `stats` (`correct`/`wrong`/`buzzes`/`earlyBuzzes`) is populated lazily on first use. |
| `DailyDoubleState` | Sub-state while a Daily Double wager is being collected (see [Daily Double](#daily-double)). |
| `FinalPublicState` | The *public* Final Jeopardy state broadcast to all clients. Wagers and answers are hidden here until revealed — see [Final Jeopardy](#final-jeopardy). |

`GameState` is intentionally broadcast in full rather than diffed — sessions are small (a handful of players), so simplicity wins over bandwidth.

### Legacy board migration

Boards saved before multi-round support (a single top-level `categories`/`pointValues` instead of `rounds`) are transparently normalized into a one-round `Board` by `boardStorage.normalizeBoard()` on every read (`getBoard`, `listBoards`, `createBoard`, `updateBoard`), and rewritten in the new shape the next time they're saved. There is no separate migration step or script to run.

### Secrets are kept out of `GameState`

Two things are deliberately **not** in the broadcast `GameState`, to avoid leaking answers or wagers to players before a reveal:

- **Final Jeopardy wagers/answers/drafts** live server-side in a private `Map` inside `backend/src/socket/finalJeopardy.ts` (the `secrets` map), pushed to the host panel only via a separate `fj:host-state` event.
- **The Final Jeopardy countdown timer** (`NodeJS.Timeout`) can't be serialized over Socket.io anyway, so it also lives in that private map.

---

## Storage Layout

```
$DATA_DIR/
├── boards/
│   └── <board-id>.json     # one file per board, see Board type above
└── media/
    └── <uuid>.<ext>        # uploaded images/video, served at /media/<filename>
```

`DATA_DIR` defaults to `./data` and is overridden via the `DATA_DIR` env var (see [SETUP.md](SETUP.md#environment-variables)). There is no database — `boardStorage.ts` reads/writes these JSON files directly, and `listBoards()` parses every file's metadata on each call (fine at the scale of a handful of local boards).

---

## REST API

Base path: `/api`. All bodies are JSON.

### Boards — `backend/src/routes/boards.ts`

| Method | Path | Body | Response | Notes |
|---|---|---|---|---|
| `GET` | `/api/boards` | — | `{ id, name, roundCount, hasFinal, createdAt, updatedAt }[]` | List view for the Dashboard — summary only, not the full round content. |
| `GET` | `/api/boards/:id` | — | `Board` | 404 if not found. Legacy files are normalized to `rounds[]` on the way out (see [Legacy board migration](#legacy-board-migration)). |
| `POST` | `/api/boards` | `Partial<Board>` (accepts either `rounds` or legacy `categories`/`pointValues`) | `201` + `Board` | Missing fields get defaults (one empty round, `[200,400,600,800,1000]` point values). |
| `PUT` | `/api/boards/:id` | `Partial<Board>` | `Board` | Shallow-merges onto the existing (normalized) board; 404 if not found. |
| `DELETE` | `/api/boards/:id` | — | `204` | 404 if not found. |

### Media — `backend/src/routes/media.ts`

| Method | Path | Body | Response | Notes |
|---|---|---|---|---|
| `POST` | `/api/media/upload` | `multipart/form-data`, field `file` | `{ filename, url, mediaType }` | Accepts JPEG/PNG/GIF/WebP and MP4/WebM/Ogg, 200 MB max. `url` is a relative path (`/media/<filename>`) served statically. |
| `DELETE` | `/api/media/:filename` | — | `204` | Filename is sanitized with `path.basename` to prevent path traversal. |

### Health

| Method | Path | Response |
|---|---|---|
| `GET` | `/api/health` | `{ status: 'ok', timestamp }` |

In production, any other route falls through to the built React app (`frontend`'s build output) for client-side routing.

---

## Real-Time Protocol (Socket.io)

### Rooms

Every socket that's part of a game joins the room named by the **room code** (e.g. `ABC123`). Two extra rooms scope host-only broadcasts:

| Room | Who's in it | Used for |
|---|---|---|
| `<roomCode>` | Everyone in the game (host, board, all players) | `game:state` and other game-wide broadcasts |
| `host:<roomCode>` | The host's own socket | Reserved for host-only events (currently unused directly, kept for future host-specific messages) |
| `hostpanel:<roomCode>` | The host's own socket | Final Jeopardy's private `fj:host-state` / `fj:host-log` events — never sent to players' phones |

### Core Game Events — `backend/src/socket/socketHandler.ts`

Convention: `host:*` and `player:*` (and bare verbs like `buzz`) are **client → server**; everything else is **server → client** unless noted. Most host actions simply mutate `gameManager` state and then re-broadcast `game:state` to the whole room — that pattern isn't repeated per row below.

| Event | Direction | Payload | Effect |
|---|---|---|---|
| `host:create` | → server | `{ boardId }` | Creates a session, generates a room code, joins host to `<room>`, `host:<room>`, `hostpanel:<room>`. Replies `host:created` with `{ roomCode, state }`. |
| `host:join` | → server | `{ roomCode }` | Rejoin as host after a refresh. Replies with `game:state`, or `error` if the room's gone. |
| `player:join` | → server | `{ roomCode, name, color }` | Adds a new player. Replies `player:joined` to the caller, then `game:state` to the room. |
| `host:add-player` | → server | `{ roomCode, name, color }` | Host adds a player who has no phone of their own (see [Daily Double](#daily-double) for why this matters). |
| `player:rejoin` | → server | `{ roomCode, playerId }` | Reconnect flow (e.g. phone screen locked) — re-associates the socket with an existing player id without creating a new player. |
| `buzz` | → server | — | Records a buzz for the calling socket's player. Rate-limited server-side to ~10 presses/sec per socket. Outcome depends on state — see [Buzzer](#buzzer) below. `won` broadcasts `buzz:winner` + `game:state`; `early`/`locked-out` reply `buzz:locked-out` to the caller (and push a stats-only `game:state` to the host panel); `ignored` replies `buzz:too-late`. |
| `host:enable-buzzer` | → server | `{ roomCode }` | Opens the buzzer. Broadcasts `buzzer:open`. |
| `host:reset-buzzer` | → server | `{ roomCode }` | Re-opens the buzzer after a wrong answer, clearing the previous winner. Broadcasts `buzzer:open`. |
| `host:lock-buzzer` | → server | `{ roomCode }` | Closes the buzzer without a winner selected. Broadcasts `buzzer:locked`. |
| `host:set-lockout` | → server | `{ roomCode, ms }` | Sets the early-buzz lockout duration (`0`, `250`, `500`, or `1000`); invalid values are ignored. |
| `host:open-question` | → server | `{ roomCode, questionId, isDailyDouble, boardHighValue? }` | Sets the active question and clears any buzz lockouts left over from the previous one. If `isDailyDouble`, also kicks off the Daily Double wager flow (see below). |
| `host:dd-pick-player` | → server | `{ roomCode, playerId }` | Manual contestant pick when no player has a tracked "last correct" (see [Daily Double](#daily-double)). |
| `host:dd-override-wager` | → server (ack) | `{ roomCode, amount }` | Host sets/corrects the Daily Double wager. Ack: `{ ok, error? }`. |
| `dd:wager` | → server (ack) | `{ amount }` | Player submits their own Daily Double wager. Ack: `{ ok, error? }`. |
| `host:reveal-dd` | → server | `{ roomCode }` | Reveals the Daily Double clue after the wager is locked and the splash has played. |
| `host:show-response` | → server | `{ roomCode }` | Reveals the answer on the board view. |
| `host:close-question` | → server | `{ roomCode }` | Marks the active question answered and clears per-question state. If this closed the last clue of the last round and the board has no Final Jeopardy, also ends the game (see [Phase / end-game](#phase--end-game)). |
| `host:score` | → server | `{ roomCode, playerId, delta, outcome?, isDailyDouble? }` | Applies a score delta. If `outcome` is given, also updates that player's stats and, for a non-Daily-Double correct answer, records them as `lastCorrectPlayerId` (who gets offered the next Daily Double). Broadcasts `score:result`. |
| `host:set-score` | → server | `{ roomCode, playerId, score }` | Absolute score override (manual correction). |
| `host:remove-player` | → server | `{ roomCode, playerId }` | Removes a player from the session. |
| `host:start` | → server | `{ roomCode }` | Moves `phase` from `lobby` to `playing`. |
| `host:next-round` | → server (ack) | `{ roomCode }` | Advances `currentRoundIndex`, carrying players/scores/stats/`lastCorrectPlayerId` forward and clearing per-question/buzzer/lockout state. Rejects (ack `{ ok: false, error }`) if a question/Daily-Double/Final-Jeopardy is active, or this is already the last round. Broadcasts `round:changed` then `game:state`. |
| `host:end-game` | → server | `{ roomCode }` | Sets `phase` to `finished` (see [Phase / end-game](#phase--end-game)), tearing down any in-progress Final Jeopardy secrets. Valid at any point, including mid-Final-Jeopardy. |
| `host:resume-game` | → server | `{ roomCode }` | Moves `phase` back to `playing` — undoes an accidental `host:end-game`. |
| `host:end` | → server | `{ roomCode }` | Broadcasts `game:ended`, tears down Final Jeopardy secrets, deletes the session entirely. Irreversible — this is "Close Room" in the host UI, distinct from `host:end-game`. |
| `get:state` | → server | `{ roomCode }` | Any client can request a state resync; replies `game:state` to the caller only. |
| `game:state` | ← server | `GameState` | The full session state. Sent after nearly every mutation — this is the one event every client type listens to. |
| `buzz:winner` | ← server | `{ playerId, playerName, timestamp }` | Broadcast the moment someone wins the buzz. |
| `buzz:too-late` | ← server | — | Sent to a socket whose buzz was `ignored` (no active question, or the game has ended). |
| `buzz:locked-out` | ← server | `{ until }` | Sent to a socket whose buzz was early or still inside its lockout window. `until` is the epoch ms the lockout clears. |
| `round:changed` | ← server | `{ index, name }` | Broadcast after `host:next-round` succeeds; drives the board view's round splash. |
| `buzzer:open` / `buzzer:locked` | ← server | — | Convenience events for sound effects / UI, alongside the `game:state` that carries the same info. |
| `score:result` | ← server | `{ playerId, correct }` | Drives the correct/wrong sound effect. |
| `game:ended` | ← server | — | Tells all clients the host closed the room (`host:end`) — distinct from the game merely being `finished`, which clients read off `game:state.phase` instead. |
| `error` | ← server | `{ message }` | Generic error reply (bad room code, etc.) for events without an ack callback. |
| `disconnect` | (socket.io built-in) | — | Un-tracks the socket from `socketPlayers` but does **not** remove the player from the game, so a phone can reconnect (via `player:rejoin`) without losing its score. |

### Final Jeopardy Events — `backend/src/socket/finalJeopardy.ts`

All host-triggered events below broadcast the updated `FinalPublicState` via the room's regular `game:state` (it's nested at `GameState.finalJeopardy`), plus an `fj:host-log` breadcrumb to the host panel. Player-submitted events use an ack callback instead of a broadcast-only reply.

| Event | Direction | Payload | Effect |
|---|---|---|---|
| `host:fj-start` | → server | `{ roomCode }` | Validates the board has Final Jeopardy configured, snapshots the reveal order (ascending score), auto-locks a $0 wager for any player already at $0, sets stage to `intro`. |
| `host:fj-reveal-category` | → server | `{ roomCode }` | `intro` → `wagering`; reveals the category to all clients. |
| `host:fj-reveal-clue` | → server | `{ roomCode, force? }` | `wagering` → `clue`. Refuses unless every contestant has wagered, unless `force: true` (then missing wagers default to $0). |
| `host:fj-start-timer` | → server | `{ roomCode }` | `clue` → `answering`; sets `deadline` (server timestamp) using the board's `timerSeconds` (default 30s) and schedules an automatic `lockAnswers` ~750ms after it elapses. |
| `host:fj-begin-reveal` | → server | `{ roomCode }` | `locked` → `reveal`, starting at the first (lowest-score) contestant. |
| `host:fj-reveal-step` | → server | `{ roomCode }` | Advances `revealStep`: `name` → `wager` → `answer`. (`answer` → `judged` happens via `host:fj-judge`, not this event.) |
| `host:fj-judge` | → server | `{ roomCode, playerId, correct }` | Applies (or re-applies, idempotently) the score delta for the currently-revealed contestant, records their stats, sets `revealStep: 'judged'`. |
| `host:fj-undo` | → server | `{ roomCode }` | Reverts the last judgment's score delta and stats, moves `revealStep` back to `answer`. Only valid immediately after a judge. |
| `host:fj-next` | → server | `{ roomCode }` | Advances to the next contestant in reveal order (`revealStep` resets to `name`). No-op on the last contestant — the host proceeds via `host:fj-show-response` instead. |
| `host:fj-show-response` | → server | `{ roomCode }` | Reveals the correct response text. |
| `host:fj-scoreboard` | → server | `{ roomCode }` | Final stage: shows the podium/stats scoreboard. |
| `host:fj-exit` | → server | `{ roomCode }` | Clears Final Jeopardy secrets and public state (e.g. after the game ends). |
| `host:fj-set-for-player` | → server | `{ roomCode, playerId, wager?, answer? }` | Host enters a wager and/or answer on behalf of a player with no phone. |
| `fj:wager` | → server (ack) | `{ amount }` | Player submits their wager during `wagering`. Validated against `0 ≤ amount ≤ maxWager` and integer-only. |
| `fj:draft` | → server (ack) | `{ text }` | Live-syncs the player's in-progress answer to the host panel (`fj:host-state`) without locking it in. |
| `fj:answer` | → server (ack) | `{ text }` | Locks in the player's final answer. |
| `fj:host-state` | ← server | `{ wagers, answers, drafts }` (keyed by `playerId`) | **Host panel only** (`hostpanel:<room>`). The one place secret wager/answer/draft data is ever sent over the wire. |
| `fj:host-log` | ← server | `{ msg, ts }` | **Host panel only.** Human-readable breadcrumb trail of Final Jeopardy actions, shown in the host's log. |

---

## State Machines

### Buzzer

```
idle ──host:enable-buzzer──► open ──buzz (first in, not locked out)──► locked ──host:close-question──► idle
                               │                                                          ▲
                               └───────────────────host:reset-buzzer─────────────────────┘
```

`gameManager.recordBuzz` checks and flips state in one synchronous step, so ties are impossible. It returns one of four outcomes, checked in this order:

1. **`ignored`** — no active question, or the game has ended (`phase === 'finished'`). No penalty; this is what makes buzzing between clues harmless.
2. **`early`** — the buzzer is `idle` or `locked` (i.e. not yet open) and a question is active. If `settings.lockoutMs > 0`, sets `buzzLockouts[playerId] = now + lockoutMs` (re-arming any existing lockout) and increments `stats.earlyBuzzes`.
3. **`locked-out`** — the buzzer is `open`, but this player is still inside a lockout window from an earlier early press. Doesn't re-arm further.
4. **`won`** — the buzzer is `open` and this player isn't locked out. Flips `buzzerState` to `locked`, as before.

`buzzLockouts` is keyed by `playerId` (not socket id), so a lockout survives a reconnect. It's cleared only in `openQuestion` and `closeQuestion` — `enableBuzzer`/`resetBuzzer` deliberately leave it alone, since a press in the final `lockoutMs` before the buzzer opens still has to count as early.

The lockout duration lives in `GameState.settings.lockoutMs` (default `250`, one of `0/250/500/1000`), set via `host:set-lockout` and changeable mid-game.

### Daily Double

```
(no lastCorrectPlayerId) ──► picking ──host:dd-pick-player──► wagering ──► ready
        │
(has lastCorrectPlayerId) ──────────────────────────────────► wagering ──► ready
```

- `wagering → ready` happens via `dd:wager` (player, if they have a device) or `host:dd-override-wager` (host).
- The host's override field is normally disabled until the assigned player has submitted their own wager — the one exception is a player added via `host:add-player` (`hasDevice: false`), whose *only* path to a wager is the host override.
- `maxWager` is `max(player's current score, board's highest point value)`, floored at $0, per standard Jeopardy rules.

### Final Jeopardy (`FinalStage`)

```
intro ──reveal-category──► wagering ──reveal-clue──► clue ──start-timer──► answering
                                                                                │
                                                                    (timer expires / all answered)
                                                                                ▼
final ◄──scoreboard── response ◄──show-response── reveal ◄──begin-reveal── locked
```

Within `reveal`, each contestant (lowest score first) steps through `revealStep`: `name → wager → answer → judged`, with `host:fj-undo` allowed to rewind `judged → answer` before `host:fj-next` moves to the following contestant.

### Rounds

```
round 0 ──host:next-round──► round 1 ──host:next-round──► round 2 ──► ...
```

`GameState.currentRoundIndex` tracks which of `board.rounds` is live. `gameManager.advanceRound` rejects the transition (via the `host:next-round` ack) if a question, Daily Double, or Final Jeopardy is currently active, or if the board is already on its last round — otherwise it increments the index and clears per-question/buzzer/lockout state, while leaving players, scores, stats, and `lastCorrectPlayerId` untouched. A round is "complete" (`isRoundComplete`) when every question id in `rounds[currentRoundIndex]` appears in `answeredQuestions` — this is what the host UI uses to highlight "Next Round" and what `host:close-question` uses for the auto-end check below.

> **Keep in sync:** `isRoundComplete`/`countRoundQuestions` are implemented twice — once server-side in `boardStorage.ts` (used for the auto-end check) and once client-side in `frontend/src/utils/rounds.ts` (used to render round-progress UI without waiting on a round trip). There's no shared package between the two workspaces, so a change to the completion rule has to be made in both places.

### Phase / end-game

```
lobby ──host:start──► playing ──host:end-game (or auto-end)──► finished ──host:resume-game──► playing
                          │                                                                      
                          └───────────────────────host:end (Close Room, any phase)──► session deleted
```

`phase` starts at `lobby` and the current UI never calls `host:start` (kept for future use), so in practice a session is `playing` from creation until it's explicitly ended. `host:close-question` checks, after closing, whether the just-completed round was the board's *last* round and is now complete:

- **Not the last round** — nothing happens server-side; the client-side "round complete" state just enables the host's "Next Round" button.
- **Last round, board has Final Jeopardy** — nothing happens server-side either; the host panel prompts "Start Final Jeopardy" or "End Game" instead.
- **Last round, no Final Jeopardy configured** — the server calls `endGame` itself, setting `phase: 'finished'` and broadcasting the update; every client (host, board, each phone) switches to the shared `Leaderboard` the moment they receive it.

`endGame`/`resumeGame` (via `host:end-game`/`host:resume-game`) let the host do the same thing manually at any time, including mid-Final-Jeopardy (which also tears down the FJ secrets). This is distinct from `host:end`, which deletes the session outright ("Close Room" in the UI) and is irreversible.

### Physical color reservations

Player join accepts an optional `physicalColor` (`blue`, `green`, `red`, or
`yellow`), separate from the cosmetic `color`. Omission means browser only.
`buzzers:watch` with `{ roomCode }` subscribes that socket to live
`buzzers:availability` snapshots. Only online colors appear in the join form;
reserved colors are disabled, including all colors when another room owns the
physical set. The server checks availability and adds the player synchronously,
so stale or competing selections cannot reserve the same color or split the set
across games. A failed selection returns an error and a fresh snapshot.

Assignments live on the server-side player, independently of phone sockets and
hardware connectivity. Offline assignments remain displayed on the player's
page and survive rejoin. Removing the player, ending the game, or deleting the
room releases ownership. The last release frees the set for another room.
Browser-only joins remain available while the set is occupied. Hardware press
routing and host assignment editing are tracked separately in issues #15 and
#14.
