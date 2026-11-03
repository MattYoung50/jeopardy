# Hardware buzzers — Phase 1

For XIAO firmware, the five-second startup hold, and the shared **Jeopardy Buzzer
Setup** Wi-Fi page, see [Shared buzzer Wi-Fi setup](firmware-setup.md).

Four authenticated devices (`blue`, `green`, `red`, `yellow`) can connect and send
presses independently of the existing browser game. This phase records connection
status and acknowledges validated presses. A receipt does not mean the device won
a question. Hardware does not register players, join rooms, change scores, or
participate in the gameplay buzzer queue yet. Browser registration and buzzes work
as before.

## Install and test

Use Node.js 20.6+ for the commands below. From the repository root:

```powershell
npm ci --prefix backend
npm test --prefix backend
npm run build --prefix backend
```

Tests use real loopback WebSocket and Socket.IO clients, ephemeral ports, and
temporary test credentials. They need no hardware, running server, or real secrets.
They type-check the source and tests, then verify all four identities, authentication
failures, duplicate connections, reconnects, connection status, message validation,
replay rejection, payload/rate limits, heartbeat disconnects, and normal browser
registration and buzz arbitration with hardware connected. The test confirms a
hardware press leaves the entire game-state response unchanged.

## Configure and run

The hardware endpoint shares the backend port (normally **3001**, rather than the
Vite frontend port 5173). There is no additional listening port.

Set these environment variables to four different random secrets, each 32–256
printable non-space ASCII characters:

- `HARDWARE_BUZZER_BLUE_TOKEN`
- `HARDWARE_BUZZER_GREEN_TOKEN`
- `HARDWARE_BUZZER_RED_TOKEN`
- `HARDWARE_BUZZER_YELLOW_TOKEN`

If all four are absent, the hardware endpoint returns HTTP 503 and normal gameplay
still starts. Partial, empty, short, or duplicated credentials fail startup with a
configuration error. Tokens are checked before the WebSocket upgrade and are never
included in device status, receipts, or hardware logs.

For a local test, generate a git-ignored environment file once. From `backend/`:

```powershell
node -e "const fs=require('node:fs'),c=require('node:crypto');fs.writeFileSync('.env.hardware.local',['BLUE','GREEN','RED','YELLOW'].map(id=>'HARDWARE_BUZZER_'+id+'_TOKEN='+c.randomBytes(32).toString('hex')).join('\n')+'\n',{flag:'wx'})"
node --env-file=.env.hardware.local --import tsx src/index.ts
```

The generator refuses to overwrite an existing file. The ordinary `npm run dev`
command also works if the four variables are already exported into its environment;
it does not automatically load environment files.

In a second terminal, also in `backend/`, run:

```powershell
node --env-file=.env.hardware.local scripts/simulate-buzzers.mjs
```

Or point the simulator at a backend on your LAN:

```powershell
node --env-file=.env.hardware.local scripts/simulate-buzzers.mjs ws://192.168.68.63:3001/hardware/buzzers
```

If variables are already exported, use `npm run simulate:buzzers` (an optional URL
can follow `--`). The simulator connects all four identities, sends two rounds of
presses, checks each receipt, and disconnects. It prints a PASS line and exits zero
on success; connection, authentication, timeout, or receipt errors exit nonzero.
Do not run it using identities currently connected from physical boards.

For a compiled backend, build then start it with:

```powershell
node --env-file=.env.hardware.local dist/index.js
```

## Wire protocol

Use a standard RFC 6455 WebSocket client, not a Socket.IO client. Connect to
`ws://<backend-host>:3001/hardware/buzzers` with HTTP headers:

```text
X-Buzzer-Id: blue
Authorization: Bearer <blue-device-secret>
```

IDs are lowercase and fixed. The authenticated connection establishes identity;
press payloads cannot specify another device. Secrets in URL query parameters are
not accepted. Use `wss://` behind TLS for untrusted networks: plain `ws://` does not
encrypt credentials. Phase 1 supplies the server and simulator; the separate
shared-setup firmware is documented above. Press transport follows in issue #17.

The server first sends:

```json
{"type":"ready","deviceId":"blue"}
```

Send a text JSON object containing exactly these two fields:

```json
{"type":"press","sequence":1}
```

`sequence` must be a positive safe integer, increasing on each accepted press within
the connection. Start over at 1 after reconnecting. Sequences prevent duplicate and
out-of-order presses on that connection; they are not persistent replay protection
across connections. Server receive time is authoritative; device clocks are not used.

Receipt:

```json
{"type":"press:accepted","deviceId":"blue","sequence":1,"receivedAt":1700000000000}
```

`receivedAt` is Unix time in milliseconds. Malformed JSON, unexpected fields/types,
binary messages, and invalid sequences receive
`{"type":"error","code":"invalid_message"}`. Repeated or decreasing sequences
receive `{"type":"error","code":"stale_sequence"}`. Neither counts as an accepted
press. Errors leave the connection open unless a transport limit is exceeded.

Upgrade failures: 401 for invalid identity/credentials, 409 when that color is already
connected, 503 when hardware is disabled, 404 for unknown upgrade paths. A duplicate
connection never replaces an active device; retry after its disconnect is observed.

Messages are limited to 512 bytes. Oversized messages close with WebSocket code 1009;
more than 10 messages in a server-side one-second window close with 1008. Invalid
messages also count toward the limit. This limit is separate from gameplay lockouts.
The server sends ping frames every 15 seconds and terminates devices missing the
next pong (normally within about 15–30 seconds of a lost link). The firmware client
must respond to standard WebSocket ping frames and reconnect with backoff.

## Observability and lifecycle

The backend prints `[hardware]` events for authenticated connection, disconnect,
and accepted press, including the device ID and server time. The transport's
`getDevices()` interface returns snapshots for all four devices with connected
status, connection/disconnection times, last accepted press, and total accepted
press count. These records are separate from game state, are not publicly broadcast,
and reset when the backend restarts. No status UI or device-to-player mapping is
introduced in this phase. The transport's `close()` terminates its sockets and clears
the heartbeat for shutdown and tests.

## Later phase: player color selection

Keep the web buzzer. When joining with a name, a player will choose a color from a
dropdown. Colors already reserved by other players will be disabled. The server
must reserve a color atomically so simultaneous joins cannot claim the same color;
the UI alone is insufficient. Decide room scope, browser-only players, reconnect
ownership, reservation release, and how host-added players participate before
implementing registration changes. Then map hardware presses to the selected player
and route hardware and browser buzzes through the existing gameplay rules.

## References

- [ws authentication, shared HTTP servers, and heartbeat examples](https://github.com/websockets/ws/blob/master/README.md)
- [Socket.IO server options](https://socket.io/docs/v4/server-options/)
