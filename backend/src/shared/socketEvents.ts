// Canonical socket.io event name constants, shared by backend and frontend
// (see backend/src/shared/types.ts for why this lives inside backend/src).
// Every event name used anywhere in a socket.emit(...)/socket.on(...) call
// (except socket.io's own built-in lifecycle events — 'connect', 'connection',
// 'disconnect', 'error') should have an entry here instead of being a bare
// string literal at the call site.
export const SOCKET_EVENTS = {
  // Buzzer
  BUZZ: 'buzz',
  WATCH_BUZZERS: 'buzzers:watch',
  BUZZER_AVAILABILITY: 'buzzers:availability',
  BUZZ_WINNER: 'buzz:winner',
  BUZZ_TOO_LATE: 'buzz:too-late',
  BUZZ_LOCKED_OUT: 'buzz:locked-out',
  BUZZ_QUEUED: 'buzz:queued',
  BUZZ_QUEUE_LOCKED: 'buzz:queue-locked',
  BUZZ_NEXT_IN_QUEUE: 'buzz:next-in-queue',
  BUZZER_OPEN: 'buzzer:open',
  BUZZER_LOCKED: 'buzzer:locked',

  // Daily Double
  DD_WAGER: 'dd:wager',

  // Final Jeopardy
  FJ_WAGER: 'fj:wager',
  FJ_ANSWER: 'fj:answer',
  FJ_DRAFT: 'fj:draft',
  FJ_HOST_STATE: 'fj:host-state',
  FJ_HOST_LOG: 'fj:host-log',

  // Game / room lifecycle
  GAME_STATE: 'game:state',
  GAME_ENDED: 'game:ended',
  GET_STATE: 'get:state',
  ROUND_CHANGED: 'round:changed',
  SCORE_RESULT: 'score:result',

  // Host actions
  HOST_CREATE: 'host:create',
  HOST_CREATED: 'host:created',
  HOST_JOIN: 'host:join',
  HOST_START: 'host:start',
  HOST_ADD_PLAYER: 'host:add-player',
  HOST_REMOVE_PLAYER: 'host:remove-player',
  HOST_RENAME_PLAYER: 'host:rename-player',
  HOST_OPEN_QUESTION: 'host:open-question',
  HOST_CLOSE_QUESTION: 'host:close-question',
  HOST_SHOW_RESPONSE: 'host:show-response',
  HOST_ENABLE_BUZZER: 'host:enable-buzzer',
  HOST_LOCK_BUZZER: 'host:lock-buzzer',
  HOST_RESET_BUZZER: 'host:reset-buzzer',
  HOST_SCORE: 'host:score',
  HOST_SET_SCORE: 'host:set-score',
  HOST_WRONG_REOPEN: 'host:wrong-reopen',
  HOST_REVEAL_DD: 'host:reveal-dd',
  HOST_DD_PICK_PLAYER: 'host:dd-pick-player',
  HOST_DD_OVERRIDE_WAGER: 'host:dd-override-wager',
  HOST_NEXT_ROUND: 'host:next-round',
  HOST_SET_LOCKOUT: 'host:set-lockout',
  HOST_SET_AUTO_LOCK: 'host:set-auto-lock',
  HOST_SET_AUTO_LOCK_TIMEOUT: 'host:set-auto-lock-timeout',
  HOST_RESUME_GAME: 'host:resume-game',
  HOST_END_GAME: 'host:end-game',
  HOST_END: 'host:end',

  // Host Final Jeopardy controls
  HOST_FJ_START: 'host:fj-start',
  HOST_FJ_REVEAL_CATEGORY: 'host:fj-reveal-category',
  HOST_FJ_START_TIMER: 'host:fj-start-timer',
  HOST_FJ_REVEAL_CLUE: 'host:fj-reveal-clue',
  HOST_FJ_BEGIN_REVEAL: 'host:fj-begin-reveal',
  HOST_FJ_REVEAL_STEP: 'host:fj-reveal-step',
  HOST_FJ_SHOW_RESPONSE: 'host:fj-show-response',
  HOST_FJ_JUDGE: 'host:fj-judge',
  HOST_FJ_SET_FOR_PLAYER: 'host:fj-set-for-player',
  HOST_FJ_NEXT: 'host:fj-next',
  HOST_FJ_UNDO: 'host:fj-undo',
  HOST_FJ_SCOREBOARD: 'host:fj-scoreboard',
  HOST_FJ_EXIT: 'host:fj-exit',

  // Player actions
  PLAYER_JOIN: 'player:join',
  PLAYER_JOINED: 'player:joined',
  PLAYER_REJOIN: 'player:rejoin',
  PLAYER_RENAME: 'player:rename',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
