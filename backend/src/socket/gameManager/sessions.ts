import { availabilityChanged, releaseRoomReservations, validatePhysicalClaim } from './reservations.js';
import type { PhysicalColor } from '../../shared/types.js';
import { randomUUID as uuidv4 } from 'crypto';
import type { GameState, Player } from '../../types.js';
import { LIMITS } from '../../shared/limits.js';
import { sessions, lastActivityAt, resetBuzzerFields } from './state.js';

// ── Session CRUD ─────────────────────────────────────────────────────────────

function generateRoomCode(): string {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

export function createSession(boardId: string): GameState {
  let roomCode = generateRoomCode();
  while (sessions.has(roomCode)) roomCode = generateRoomCode();

  const state: GameState = {
    boardId,
    roomCode,
    players: [],
    answeredQuestions: [],
    activeQuestionId: null,
    buzzerState: 'idle',
    buzzedPlayerId: null,
    buzzedPlayerName: null,
    buzzTimestamp: null,
    phase: 'lobby',
    dailyDoubleRevealed: false,
    responseVisible: false,
    finalJeopardy: null,
    dailyDouble: null,
    lastCorrectPlayerId: null,
    buzzLockouts: {},
    buzzQueue: [],
    settings: { lockoutMs: 250, autoLockEnabled: true, autoLockTimeoutS: 7 },
    currentRoundIndex: 0,
  };
  sessions.set(roomCode, state);
  lastActivityAt.set(roomCode, Date.now());
  return state;
}

export function getSession(roomCode: string): GameState | undefined {
  const session = sessions.get(roomCode);
  if (session) lastActivityAt.set(roomCode, Date.now());
  return session;
}

export function deleteSession(roomCode: string) {
  releaseRoomReservations(roomCode);
  sessions.delete(roomCode);
  lastActivityAt.delete(roomCode);
}

// Returns the room codes of every session whose last observed activity is
// older than `maxIdleMs`. Used by the idle-session reaper in
// socketHandler.ts to find abandoned games (e.g. a host who closed their tab
// without clicking "End Game") so they can be torn down and stop leaking
// memory for the lifetime of the server process.
export function getIdleSessions(maxIdleMs: number): string[] {
  const now = Date.now();
  const idle: string[] = [];
  for (const roomCode of sessions.keys()) {
    const last = lastActivityAt.get(roomCode) ?? 0;
    if (now - last > maxIdleMs) idle.push(roomCode);
  }
  return idle;
}

// Case-insensitive, trimmed name-uniqueness check within a session. Excludes
// `excludePlayerId` so a rename can keep a player's own current name.
export function isNameTaken(session: GameState, name: string, excludePlayerId?: string): boolean {
  const normalized = name.trim().toLowerCase();
  return session.players.some(p => p.id !== excludePlayerId && p.name.trim().toLowerCase() === normalized);
}

export function addPlayer(roomCode: string, name: string, color: string, physicalColor?: PhysicalColor): Player | null {
  const session = sessions.get(roomCode);
  if (!session) return null;
  if (session.phase === 'finished' || isNameTaken(session, name) || validatePhysicalClaim(roomCode, physicalColor)) return null;
  const player: Player = {
    id: uuidv4(), name, score: 0,
    color: physicalColor ?? color,
    physicalColor,
  };
  session.players.push(player);
  availabilityChanged();
  return player;
}

export function removePlayer(roomCode: string, playerId: string) {
  const session = sessions.get(roomCode);
  if (!session) return;
  session.players = session.players.filter(p => p.id !== playerId);
  availabilityChanged();
}

export function renamePlayer(roomCode: string, playerId: string, newName: string): { ok: boolean; error?: string } {
  const session = sessions.get(roomCode);
  if (!session) return { ok: false, error: 'Room not found' };
  const player = session.players.find(p => p.id === playerId);
  if (!player) return { ok: false, error: 'Player not found' };
  if (isNameTaken(session, newName, playerId)) return { ok: false, error: 'That name is already taken' };
  player.name = newName.trim().slice(0, LIMITS.PLAYER_NAME_MAX);
  return { ok: true };
}

export function startGame(roomCode: string): boolean {
  const session = sessions.get(roomCode);
  if (!session) return false;
  session.phase = 'playing';
  return true;
}

export function endGame(roomCode: string): boolean {
  const session = sessions.get(roomCode);
  if (!session) return false;
  session.phase = 'finished';
  releaseRoomReservations(roomCode);
  session.activeQuestionId = null;
  resetBuzzerFields(session, { buzzerState: 'idle', clearLockouts: true });
  session.dailyDouble = null;
  return true;
}

export function resumeGame(roomCode: string): boolean {
  const session = sessions.get(roomCode);
  if (!session) return false;
  session.phase = 'playing';
  return true;
}
