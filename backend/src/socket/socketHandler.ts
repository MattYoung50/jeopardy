import { getBuzzerAvailability, onAvailabilityChange, validatePhysicalClaim } from './gameManager/reservations.js';
import type { PhysicalColor } from '../shared/types.js';
import type { Server, Socket } from 'socket.io';
import * as gm from './gameManager.js';
import * as boardStorage from '../storage/boardStorage.js';
import { registerFinalHandlers, cleanup as cleanupFinal } from './finalJeopardy.js';
import { onHost } from './hostAuth.js';
import { SOCKET_EVENTS } from '../shared/socketEvents.js';
import { LIMITS } from '../shared/limits.js';

// Track which socket owns which player in which room
const socketPlayers = new Map<string, { roomCode: string; playerId: string; playerName: string }>();

// Per-socket buzz rate limiting: drop anything beyond ~10 presses/sec.
const BUZZ_RATE_LIMIT = 10;
const BUZZ_RATE_WINDOW_MS = 1000;
const buzzTimestamps = new Map<string, number[]>();

const buzzOpenedAt = new Map<string, number>(); // roomCode -> timestamp
const autoLockTimers = new Map<string, NodeJS.Timeout>(); // roomCode -> timer

function isRateLimited(socketId: string): boolean {
  const now = Date.now();
  const timestamps = (buzzTimestamps.get(socketId) ?? []).filter(t => now - t < BUZZ_RATE_WINDOW_MS);
  timestamps.push(now);
  buzzTimestamps.set(socketId, timestamps);
  return timestamps.length > BUZZ_RATE_LIMIT;
}

function cancelAutoLockTimer(roomCode: string) {
  const t = autoLockTimers.get(roomCode);
  if (t) { clearTimeout(t); autoLockTimers.delete(roomCode); }
}

function startAutoLockTimer(io: Server, roomCode: string) {
  cancelAutoLockTimer(roomCode);
  const session = gm.getSession(roomCode);
  if (!session?.settings.autoLockEnabled) return;
  const ms = (session.settings.autoLockTimeoutS ?? 7) * 1000;
  const t = setTimeout(() => {
    autoLockTimers.delete(roomCode);
    gm.lockBuzzer(roomCode);
    const s = gm.getSession(roomCode);
    io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, s);
    io.to(`hostpanel:${roomCode}`).emit(SOCKET_EVENTS.BUZZ_QUEUE_LOCKED, { auto: true });
  }, ms);
  autoLockTimers.set(roomCode, t);
}

// Full teardown for a room: cancels its auto-lock timer, drops its
// buzzOpenedAt entry, cleans up any Final Jeopardy secret state, deletes the
// session itself, and notifies any client still connected. Used by both the
// explicit "host:end" handler and the idle-session reaper below so the two
// paths can never drift out of sync.
function endRoom(io: Server, roomCode: string) {
  cancelAutoLockTimer(roomCode);
  buzzOpenedAt.delete(roomCode);
  io.to(roomCode).emit(SOCKET_EVENTS.GAME_ENDED);
  cleanupFinal(roomCode);
  gm.deleteSession(roomCode);
}

// Idle-session reaper: a host who simply closes their browser tab without
// clicking "End Game" would otherwise leak that room's session (plus its
// autoLockTimers entry and finalJeopardy secrets) for the lifetime of the
// server process. Sweeping every 15 minutes against a 6-hour idle threshold
// bounds that growth to "rooms idle for over 6 hours" while being generous
// enough to never interrupt a real game, even one paused for a long break —
// 15 minutes keeps the worst-case lag between a room going idle and being
// reaped small relative to the 6-hour threshold, without running the sweep
// often enough to matter for CPU/log noise.
const IDLE_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const IDLE_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

function startIdleSessionReaper(io: Server) {
  const timer = setInterval(() => {
    const idleRooms = gm.getIdleSessions(IDLE_SESSION_MAX_AGE_MS);
    for (const roomCode of idleRooms) {
      endRoom(io, roomCode);
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function registerSocketHandlers(io: Server) {
  startIdleSessionReaper(io);
  const unsubscribe = onAvailabilityChange(() => {
    for (const client of io.sockets.sockets.values()) if (client.data.buzzerRoom) client.emit(SOCKET_EVENTS.BUZZER_AVAILABILITY, getBuzzerAvailability(client.data.buzzerRoom));
  });
  io.engine.on('close', unsubscribe);

  io.on('connection', (socket: Socket) => {
    registerFinalHandlers(io, socket, socketPlayers);
    socket.on(SOCKET_EVENTS.WATCH_BUZZERS, ({ roomCode }: { roomCode: string }) => {
      if (typeof roomCode !== 'string') return;
      socket.data.buzzerRoom = roomCode;
      socket.emit(SOCKET_EVENTS.BUZZER_AVAILABILITY, getBuzzerAvailability(roomCode));
    });

    // ── HOST: create a game session ──────────────────────────────────────
    socket.on(SOCKET_EVENTS.HOST_CREATE, ({ boardId }: { boardId: string }) => {
      const session = gm.createSession(boardId);
      socket.join(session.roomCode);
      socket.join(`host:${session.roomCode}`);
      socket.join(`hostpanel:${session.roomCode}`);
      socket.emit(SOCKET_EVENTS.HOST_CREATED, { roomCode: session.roomCode, state: session });
    });

    // ── HOST: rejoin an existing session ────────────────────────────────
    socket.on(SOCKET_EVENTS.HOST_JOIN, ({ roomCode }: { roomCode: string }) => {
      const session = gm.getSession(roomCode);
      if (!session) return socket.emit('error', { message: 'Room not found' });
      socket.join(roomCode);
      socket.join(`host:${roomCode}`);
      socket.join(`hostpanel:${roomCode}`);
      socket.emit(SOCKET_EVENTS.GAME_STATE, session);
    });

    // ── PLAYER: join a game room ─────────────────────────────────────────
    socket.on(SOCKET_EVENTS.PLAYER_JOIN, ({ roomCode, name, color, physicalColor }: { roomCode: string; name: string; color: string; physicalColor?: PhysicalColor }) => {
      const session = gm.getSession(roomCode);
      if (!session) return socket.emit('error', { message: 'Room not found' });
      if (gm.isNameTaken(session, name)) return socket.emit('error', { message: 'That name is already taken in this game' });
      if (socketPlayers.has(socket.id)) return socket.emit('error', { message: 'Already joined a game' });
      const claimError = validatePhysicalClaim(roomCode, physicalColor);
      if (claimError) {
        socket.emit(SOCKET_EVENTS.BUZZER_AVAILABILITY, getBuzzerAvailability(roomCode));
        return socket.emit('error', { message: claimError });
      }
      const player = gm.addPlayer(roomCode, name, color, physicalColor);
      if (!player) return socket.emit('error', { message: 'Could not join room' });
      socketPlayers.set(socket.id, { roomCode, playerId: player.id, playerName: name });
      socket.join(roomCode);
      socket.emit(SOCKET_EVENTS.PLAYER_JOINED, { player, state: gm.getSession(roomCode) });
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: add a player with no phone of their own ─────────────────────
    // Deliberately does NOT touch socketPlayers — that map means "this
    // socket acts on this player's behalf from their own device," which is
    // never true for a host-added player (their entry would otherwise
    // falsely point at the host's own socket).
    onHost(socket, SOCKET_EVENTS.HOST_ADD_PLAYER, ({ roomCode, name, color }: { roomCode: string; name: string; color: string }) => {
      const session = gm.getSession(roomCode);
      if (!session) return socket.emit('error', { message: 'Room not found' });
      if (gm.isNameTaken(session, name)) return socket.emit('error', { message: 'That name is already taken in this game' });
      const player = gm.addPlayer(roomCode, name, color);
      if (!player) return socket.emit('error', { message: 'Could not add player' });
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── PLAYER: rejoin after reconnect (e.g. phone screen locked) ────────
    socket.on(SOCKET_EVENTS.PLAYER_REJOIN, ({ roomCode, playerId }: { roomCode: string; playerId: string }) => {
      const session = gm.getSession(roomCode);
      if (!session) return socket.emit('error', { message: 'Room not found' });
      const player = session.players.find(p => p.id === playerId);
      if (!player) return socket.emit('error', { message: 'Player no longer in this game' });
      socketPlayers.set(socket.id, { roomCode, playerId: player.id, playerName: player.name });
      socket.join(roomCode);
      socket.emit(SOCKET_EVENTS.PLAYER_JOINED, { player, state: session });
    });

    // ── PLAYER: buzz in ──────────────────────────────────────────────────
    socket.on(SOCKET_EVENTS.BUZZ, () => {
      const info = socketPlayers.get(socket.id);
      if (!info) return;
      if (isRateLimited(socket.id)) return;
      const outcome = gm.recordBuzz(info.roomCode, info.playerId, info.playerName, buzzOpenedAt.get(info.roomCode) ?? null);
      const session = gm.getSession(info.roomCode);
      if (outcome === 'won') {
        cancelAutoLockTimer(info.roomCode);
        io.to(info.roomCode).emit(SOCKET_EVENTS.BUZZ_WINNER, {
          playerId: info.playerId,
          playerName: info.playerName,
          timestamp: Date.now(),
        });
        io.to(info.roomCode).emit(SOCKET_EVENTS.GAME_STATE, session);
      } else if (outcome === 'early' || outcome === 'locked-out') {
        const until = session?.buzzLockouts[info.playerId] ?? Date.now();
        socket.emit(SOCKET_EVENTS.BUZZ_LOCKED_OUT, { until });
        io.to(`hostpanel:${info.roomCode}`).emit(SOCKET_EVENTS.GAME_STATE, session);
      } else if (outcome === 'queued') {
        socket.emit(SOCKET_EVENTS.BUZZ_QUEUED);
        io.to(`hostpanel:${info.roomCode}`).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(info.roomCode));
      } else {
        socket.emit(SOCKET_EVENTS.BUZZ_TOO_LATE);
      }
    });

    // ── HOST: set buzzer lockout duration ──────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_SET_LOCKOUT, ({ roomCode, ms }: { roomCode: string; ms: number }) => {
      gm.setLockoutMs(roomCode, ms);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: open buzzer ────────────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_ENABLE_BUZZER, ({ roomCode }: { roomCode: string }) => {
      gm.enableBuzzer(roomCode);
      buzzOpenedAt.set(roomCode, Date.now());
      startAutoLockTimer(io, roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.BUZZER_OPEN);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: reset buzzer (allow re-buzz) ───────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_RESET_BUZZER, ({ roomCode }: { roomCode: string }) => {
      gm.resetBuzzer(roomCode);
      buzzOpenedAt.set(roomCode, Date.now());
      startAutoLockTimer(io, roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.BUZZER_OPEN);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: lock buzzer ────────────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_LOCK_BUZZER, ({ roomCode }: { roomCode: string }) => {
      cancelAutoLockTimer(roomCode);
      gm.lockBuzzer(roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.BUZZER_LOCKED);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: open a question ────────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_OPEN_QUESTION, ({ roomCode, questionId, isDailyDouble, boardHighValue }: { roomCode: string; questionId: string; isDailyDouble: boolean; boardHighValue?: number }) => {
      gm.openQuestion(roomCode, questionId, isDailyDouble);
      if (isDailyDouble) {
        const session = gm.getSession(roomCode);
        const lastCorrect = session?.lastCorrectPlayerId ?? null;
        const hasDevice = lastCorrect
          ? [...socketPlayers.values()].some(v => v.roomCode === roomCode && v.playerId === lastCorrect)
          : false;
        gm.startDailyDoubleWager(roomCode, lastCorrect, boardHighValue ?? 0, hasDevice);
      }
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: fallback pick of the Daily Double contestant ────────────────
    onHost(socket, SOCKET_EVENTS.HOST_DD_PICK_PLAYER, ({ roomCode, playerId }: { roomCode: string; playerId: string }) => {
      const hasDevice = [...socketPlayers.values()].some(v => v.roomCode === roomCode && v.playerId === playerId);
      gm.pickDDContestant(roomCode, playerId, hasDevice);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: correct/enter a Daily Double wager on behalf of a player ────
    onHost(socket, SOCKET_EVENTS.HOST_DD_OVERRIDE_WAGER, ({ roomCode, amount }: { roomCode: string; amount: number }, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const res = gm.overrideDDWager(roomCode, amount);
      ack?.(res);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── PLAYER: submit a Daily Double wager ────────────────────────────────
    socket.on(SOCKET_EVENTS.DD_WAGER, ({ amount }: { amount: number }, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const info = socketPlayers.get(socket.id);
      if (!info) return ack?.({ ok: false, error: 'Not joined' });
      const res = gm.submitDDWager(info.roomCode, info.playerId, amount);
      ack?.(res);
      io.to(info.roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(info.roomCode));
    });

    // ── HOST: reveal DD clue (after DD splash screen) ────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_REVEAL_DD, ({ roomCode }: { roomCode: string }) => {
      gm.revealDailyDouble(roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: show response on board view ────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_SHOW_RESPONSE, ({ roomCode }: { roomCode: string }) => {
      gm.showResponse(roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: close/dismiss a question ───────────────────────────────────
    // After closing, auto-ends the game only when the just-completed round
    // was the last one AND the board has no Final Jeopardy configured — with
    // FJ, or on an earlier round, the host is prompted client-side instead.
    onHost(socket, SOCKET_EVENTS.HOST_CLOSE_QUESTION, async ({ roomCode }: { roomCode: string }) => {
      cancelAutoLockTimer(roomCode);
      buzzOpenedAt.delete(roomCode);
      gm.closeQuestion(roomCode);
      const session = gm.getSession(roomCode);
      if (session && session.phase !== 'finished') {
        const board = await boardStorage.getBoard(session.boardId);
        if (board) {
          const isLastRound = session.currentRoundIndex >= board.rounds.length - 1;
          const roundComplete = boardStorage.isRoundComplete(board, session.answeredQuestions, session.currentRoundIndex);
          if (isLastRound && roundComplete && !board.finalJeopardy) {
            gm.endGame(roomCode);
          }
        }
      }
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: end the game (shows the leaderboard) ────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_END_GAME, ({ roomCode }: { roomCode: string }) => {
      cleanupFinal(roomCode);
      gm.setFinalState(roomCode, null);
      gm.endGame(roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: resume a game that was ended by mistake ──────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_RESUME_GAME, ({ roomCode }: { roomCode: string }) => {
      gm.resumeGame(roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: award / deduct points ──────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_SCORE, ({ roomCode, playerId, delta, outcome, isDailyDouble }: { roomCode: string; playerId: string; delta: number; outcome?: 'correct' | 'wrong'; isDailyDouble?: boolean }) => {
      // Only judged Correct/Wrong clicks (outcome present) are checked against
      // who's actually eligible right now; manual score adjustments (no
      // outcome) are a free-form host override and must not be blocked here.
      if (outcome && !gm.validateScoreEligibility(roomCode, playerId, !!isDailyDouble)) return;
      gm.updateScore(roomCode, playerId, delta);
      if (outcome) {
        gm.recordOutcome(roomCode, playerId, outcome);
        if (outcome === 'correct' && !isDailyDouble) gm.setLastCorrectPlayer(roomCode, playerId);
        io.to(roomCode).emit(SOCKET_EVENTS.SCORE_RESULT, { playerId, correct: outcome === 'correct' });
      }
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    onHost(socket, SOCKET_EVENTS.HOST_SET_SCORE, ({ roomCode, playerId, score }: { roomCode: string; playerId: string; score: number }) => {
      gm.setScore(roomCode, playerId, score);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── PLAYER: rename themselves (lobby only) ───────────────────────────
    socket.on(SOCKET_EVENTS.PLAYER_RENAME, ({ newName }: { newName: string }, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const info = socketPlayers.get(socket.id);
      if (!info) return ack?.({ ok: false, error: 'Not joined' });
      const session = gm.getSession(info.roomCode);
      if (!session) return ack?.({ ok: false, error: 'Room not found' });
      if (session.phase !== 'lobby') return ack?.({ ok: false, error: 'Name changes only allowed in lobby' });
      const trimmed = newName.trim();
      if (!trimmed) return ack?.({ ok: false, error: 'Name cannot be empty' });
      const res = gm.renamePlayer(info.roomCode, info.playerId, trimmed);
      if (!res.ok) return ack?.(res);
      socketPlayers.set(socket.id, { ...info, playerName: trimmed.slice(0, LIMITS.PLAYER_NAME_MAX) });
      ack?.({ ok: true });
      io.to(info.roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(info.roomCode));
    });

    // ── HOST: rename any player ───────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_RENAME_PLAYER, ({ roomCode, playerId, newName }: { roomCode: string; playerId: string; newName: string }, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const trimmed = newName.trim();
      if (!trimmed) return ack?.({ ok: false, error: 'Name cannot be empty' });
      const res = gm.renamePlayer(roomCode, playerId, trimmed);
      if (!res.ok) return ack?.(res);
      // Update socketPlayers entry for this player if they have a live socket
      for (const [sid, info] of socketPlayers) {
        if (info.roomCode === roomCode && info.playerId === playerId) {
          socketPlayers.set(sid, { ...info, playerName: trimmed.slice(0, LIMITS.PLAYER_NAME_MAX) });
          break;
        }
      }
      ack?.({ ok: true });
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: remove a player ────────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_REMOVE_PLAYER, ({ roomCode, playerId }: { roomCode: string; playerId: string }) => {
      gm.removePlayer(roomCode, playerId);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: start game ─────────────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_START, ({ roomCode }: { roomCode: string }) => {
      gm.startGame(roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: advance to the next round ────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_NEXT_ROUND, async ({ roomCode }: { roomCode: string }, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const session = gm.getSession(roomCode);
      if (!session) return ack?.({ ok: false, error: 'Room not found' });
      const board = await boardStorage.getBoard(session.boardId);
      if (!board) return ack?.({ ok: false, error: 'Board not found' });
      const res = gm.advanceRound(roomCode, board.rounds.length);
      ack?.(res);
      if (res.ok) {
        const updated = gm.getSession(roomCode);
        const round = board.rounds[updated!.currentRoundIndex];
        io.to(roomCode).emit(SOCKET_EVENTS.ROUND_CHANGED, { index: updated!.currentRoundIndex, name: round?.name ?? null });
        io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, updated);
      }
    });

    // ── HOST: end / delete session ───────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_END, ({ roomCode }: { roomCode: string }) => {
      endRoom(io, roomCode);
    });

    // ── HOST: wrong answer — reopen or advance to next in queue ──────────
    onHost(socket, SOCKET_EVENTS.HOST_WRONG_REOPEN, ({ roomCode, playerId, delta }: { roomCode: string; playerId: string; delta: number }) => {
      const ok = gm.markWrongAndReopen(roomCode, playerId, delta);
      if (!ok) return;
      io.to(roomCode).emit(SOCKET_EVENTS.SCORE_RESULT, { playerId, correct: false });

      gm.markBuzzAttempted(roomCode, playerId);

      const session = gm.getSession(roomCode);
      if (!session) return;
      const ineligibleIds = new Set(
        Object.keys(session.buzzLockouts).filter(id => session.buzzLockouts[id] === gm.PERMANENT_LOCKOUT)
      );

      const next = gm.getNextInQueue(roomCode, ineligibleIds);
      if (next) {
        gm.advanceToBuzzEntry(roomCode, next);
        const updated = gm.getSession(roomCode);
        io.to(roomCode).emit(SOCKET_EVENTS.BUZZ_WINNER, {
          playerId: next.playerId,
          playerName: next.playerName,
          timestamp: Date.now(),
        });
        io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, updated);
        io.to(`hostpanel:${roomCode}`).emit(SOCKET_EVENTS.BUZZ_NEXT_IN_QUEUE, {
          playerId: next.playerId,
          playerName: next.playerName,
        });
        startAutoLockTimer(io, roomCode);
      } else {
        gm.resetBuzzer(roomCode);
        buzzOpenedAt.set(roomCode, Date.now());
        io.to(roomCode).emit(SOCKET_EVENTS.BUZZER_OPEN);
        io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
        startAutoLockTimer(io, roomCode);
      }
    });

    // ── HOST: toggle auto-lock ────────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_SET_AUTO_LOCK, ({ roomCode, enabled }: { roomCode: string; enabled: boolean }) => {
      gm.setAutoLock(roomCode, enabled);
      if (!enabled) cancelAutoLockTimer(roomCode);
      io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── HOST: set auto-lock timeout ────────────────────────────────────────
    onHost(socket, SOCKET_EVENTS.HOST_SET_AUTO_LOCK_TIMEOUT, ({ roomCode, seconds }: { roomCode: string; seconds: number }) => {
      const ok = gm.setAutoLockTimeout(roomCode, seconds);
      if (ok) io.to(roomCode).emit(SOCKET_EVENTS.GAME_STATE, gm.getSession(roomCode));
    });

    // ── REQUEST state (any client) ───────────────────────────────────────
    socket.on(SOCKET_EVENTS.GET_STATE, ({ roomCode }: { roomCode: string }) => {
      const session = gm.getSession(roomCode);
      if (session) socket.emit(SOCKET_EVENTS.GAME_STATE, session);
    });

    // ── DISCONNECT ───────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const info = socketPlayers.get(socket.id);
      buzzTimestamps.delete(socket.id);
      if (info) {
        socketPlayers.delete(socket.id);
        // Don't auto-remove player on disconnect so they can reconnect
        const session = gm.getSession(info.roomCode);
        if (session) io.to(info.roomCode).emit(SOCKET_EVENTS.GAME_STATE, session);
      }
    });
  });
}
