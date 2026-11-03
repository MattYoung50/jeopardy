import { newId } from '../utils/id';
import { create } from 'zustand';
import type { GameState, Player } from '@shared/types';

export interface LogEntry {
  id: string;
  ts: string;
  type: 'open' | 'dd' | 'buzz' | 'correct' | 'wrong' | 'close' | 'score' | 'fj' | 'wager' | 'answer';
  msg: string;
  player?: string;
}

interface GameStore {
  gameState: GameState | null;
  myPlayer: Player | null;
  roomCode: string | null;
  connected: boolean;
  gameLog: LogEntry[];
  setGameState: (state: GameState) => void;
  setMyPlayer: (player: Player) => void;
  setRoomCode: (code: string) => void;
  setConnected: (v: boolean) => void;
  addLog: (entry: Omit<LogEntry, 'id' | 'ts'>) => void;
  clearLog: () => void;
}

function now(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export const useGameStore = create<GameStore>((set) => ({
  gameState: null,
  myPlayer: null,
  roomCode: null,
  connected: false,
  gameLog: [],
  setGameState: (gameState) => set({ gameState }),
  setMyPlayer: (myPlayer) => set({ myPlayer }),
  setRoomCode: (roomCode) => set({ roomCode }),
  setConnected: (connected) => set({ connected }),
  addLog: (entry) => set(s => ({
    gameLog: [{ ...entry, id: newId(), ts: now() }, ...s.gameLog].slice(0, 200),
  })),
  clearLog: () => set({ gameLog: [] }),
}));
