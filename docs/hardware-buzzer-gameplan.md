# Wireless buzzer gameplan

## Destination

Deliver Phase 1 on `feature/hardware-buzzers-phase1`: an authenticated, independently
tracked four-device transport, with a Node.js simulator, automated tests, and run
instructions. Explain the diff before committing. Player registration and gameplay
integration are deferred by the user.

## Existing system inspected

- `backend/src/index.ts` creates Express, the HTTP server, and Socket.IO.
- `socket/socketHandler.ts` handles host membership, browser registration/rejoin,
  socket-to-player associations, browser presses, and game-state broadcasts.
- `socket/gameManager/sessions.ts` creates in-memory game rooms and player UUIDs.
- `socket/gameManager/state.ts` owns the shared game state and buzzer resets.
- `socket/gameManager/buzzer.ts` owns early lockouts, the winner, and buzz queues.
- `frontend/src/pages/Buzzer.tsx` currently registers a name with a random display
  color, then sends existing Socket.IO buzz events.

## Confirmed decisions

- Standard WebSocket endpoint `/hardware/buzzers`, sharing the backend HTTP server.
- Fixed identities: Blue, Green, Red, Yellow, with distinct environment secrets.
- One active connection per identity; duplicates are rejected.
- Validate and acknowledge presses without joining rooms or mutating gameplay.
- Preserve the browser buzzer and test it alongside hardware connections.
- Keep color dropdowns and exclusive reservations for a later phase.

## Phase 1 verification

See `hardware-buzzers.md` for protocol, setup, simulator, and test commands.
Acceptance is all four simulated devices receiving valid press acknowledgments,
authentication/connection/validation tests passing, and the existing browser player
still registering and winning a buzz while hardware presses leave game state intact.

## Later decisions

1. Color reservations: per room or per running backend? How do browser-only players
   participate when all four hardware colors are taken?
2. Ownership: preserve a reservation across transient browser disconnects? Release
   only when the host removes a player, or after a timeout?
3. Routing: which room does each physical color serve, and how should a player use
   either their browser or the associated hardware without duplicate attempts?
4. Firmware: provisioning, reconnect/backoff, debounce, LED feedback, power, and
   physical button behavior for the XIAO ESP32-C3 boards.

## Tracker status

Published in the user's fork: [Wireless Jeopardy buzzers: Phase 1 wayfinder map](https://github.com/MattYoung50/jeopardy/issues/1).
The map links three resolved decision/verification sub-issues and records the later-phase
scope. The Phase 1 map is closed because its decisions are resolved; source review
takes place on the `feature/hardware-buzzers-phase1` pull request against this fork.

