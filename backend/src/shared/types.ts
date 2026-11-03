// Canonical shared type definitions for the Jeopardy game, used by both the
// backend (imports directly) and the frontend (imports via the @shared alias,
// see frontend/vite.config.ts and frontend/tsconfig.json).
//
// This file lives inside backend/src so the backend's existing tsc build
// config (rootDir: "src", outDir: "dist") requires no changes. Do not import
// anything backend-specific from here — it must stay safely importable from
// the frontend too.

export interface Question {
  id: string;
  value: number;
  clue: string;
  response: string;
  mediaType?: 'image' | 'video' | 'youtube';
  mediaUrl?: string;
  isDailyDouble?: boolean;
}

export interface Category {
  id: string;
  name: string;
  questions: Question[];
}

export interface FinalJeopardyBoard {
  category: string;
  clue: string;
  response: string;
  mediaType?: 'image' | 'video' | 'youtube';
  mediaUrl?: string;
  timerSeconds?: number;
}

export interface Round {
  id: string;
  name?: string;
  categories: Category[];
  pointValues: number[];
}
export interface Board {
  id: string;
  name: string;
  rounds: Round[];
  createdAt: string;
  updatedAt: string;
  finalJeopardy?: FinalJeopardyBoard;
}

export interface PlayerStats {
  correct: number;
  wrong: number;
  buzzes: number;
  earlyBuzzes: number;
}

export interface Player {
  physicalColor?: PhysicalColor;
  id: string;
  name: string;
  score: number;
  color: string;
  stats?: PlayerStats;
}

export type FinalStage = 'intro' | 'wagering' | 'clue' | 'answering' | 'locked' | 'reveal' | 'response' | 'final';
export type FinalRevealStep = 'name' | 'wager' | 'answer' | 'judged';

export interface FinalContestant {
  playerId: string;
  playerName: string;
  maxWager: number;
  hasWagered: boolean;
  hasAnswered: boolean;
  preScore: number;
}

export interface FinalRevealEntry {
  wager: number;
  answer: string;
  correct: boolean | null;
}

// Public Final Jeopardy state — broadcast to every client via game:state.
// Secrets (wagers/answers before reveal, timers) live server-side only, in finalJeopardy.ts.
export interface FinalPublicState {
  stage: FinalStage;
  category: string | null;
  clue: string | null;
  mediaType?: 'image' | 'video' | 'youtube';
  mediaUrl?: string;
  deadline: number | null;
  serverNow: number;
  contestants: FinalContestant[];
  revealIndex: number;
  revealStep: FinalRevealStep;
  currentReveal: { wager: number; answer: string } | null;
  revealed: Record<string, FinalRevealEntry>;
  response: string | null;
}

export interface DailyDoubleState {
  stage: 'picking' | 'wagering' | 'ready';
  playerId: string | null;
  maxWager: number;
  boardHighValue: number;
  wager: number | null;
  hasDevice: boolean;
  submittedByPlayer: boolean;
}

export interface BuzzEntry {
  playerId: string;
  playerName: string;
  reactionMs: number;
  attemptedAnswer: boolean;
}

// Sentinel value used in GameState.buzzLockouts to mark a player as
// permanently locked out of buzzing for the current question (as opposed to
// a timed lockout, which stores a future timestamp).
export const PERMANENT_LOCKOUT = Number.MAX_SAFE_INTEGER;

export interface GameState {
  boardId: string;
  roomCode: string;
  players: Player[];
  answeredQuestions: string[];
  activeQuestionId: string | null;
  buzzerState: 'idle' | 'open' | 'locked';
  buzzedPlayerId: string | null;
  buzzedPlayerName: string | null;
  buzzTimestamp: number | null;
  phase: 'lobby' | 'playing' | 'finished';
  dailyDoubleRevealed: boolean;  // false until host clicks "Reveal Question"
  responseVisible: boolean;       // true after host clicks "Show Answer"
  finalJeopardy: FinalPublicState | null;
  dailyDouble: DailyDoubleState | null;
  lastCorrectPlayerId: string | null;
  buzzLockouts: Record<string, number>;
  buzzQueue: BuzzEntry[];
  settings: {
    lockoutMs: number;
    autoLockEnabled: boolean;
    autoLockTimeoutS: number;
  };
  currentRoundIndex: number;
}

export const PHYSICAL_COLORS = ['blue', 'green', 'red', 'yellow'] as const;
export type PhysicalColor = typeof PHYSICAL_COLORS[number];
export interface BuzzerAvailability { color: PhysicalColor; online: boolean; reserved: boolean; }
