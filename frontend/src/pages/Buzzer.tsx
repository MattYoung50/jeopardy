import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { socket } from '../socket';
import { useGameStore } from '../store/gameStore';
import type { BuzzerAvailability, GameState } from '@shared/types';
import { SOCKET_EVENTS } from '@shared/socketEvents';
import { LIMITS } from '@shared/limits';
import PlayerFinal from '../components/final/PlayerFinal';
import DDPlayerWager from '../components/dailydouble/DDPlayerWager';
import Leaderboard from '../components/shared/Leaderboard';
import { randomPlayerColor } from '../utils/colors';
import { formatMoney } from '../utils/format';

type BuzzerPhase = 'join' | 'lobby' | 'waiting' | 'armed' | 'open' | 'winner' | 'too-late' | 'locked-out' | 'finished' | 'closed';

function rejoinKey(roomCode: string | undefined) {
  return `jeopardy:player:${roomCode ?? ''}`;
}

export default function Buzzer() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const { gameState, setGameState, setMyPlayer } = useGameStore();
  const [phase, setPhase] = useState<BuzzerPhase>('join');
  const [name, setName] = useState('');
  const [physicalColor, setPhysicalColor] = useState('');
  const [availability, setAvailability] = useState<BuzzerAvailability[]>([]);
  const [error, setError] = useState('');
  const [winnerName, setWinnerName] = useState('');
  const [myId, setMyId] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [editNameError, setEditNameError] = useState('');

  // Kept in sync with `phase`/`myId` state below so the socket-handler effect
  // can read the current values without needing them in its dependency
  // array — the handlers only use them inside closures, they don't need to
  // be redefined (and the socket listeners re-registered) every time phase
  // or myId changes.
  const phaseRef = useRef(phase);
  const myIdRef = useRef(myId);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { myIdRef.current = myId; }, [myId]);

  // Try to rejoin (e.g. after a phone screen sleeps and drops the socket).
  useEffect(() => {
    if (!roomCode) return;
    function tryRejoin() {
      socket.emit(SOCKET_EVENTS.WATCH_BUZZERS, { roomCode });
      const savedId = localStorage.getItem(rejoinKey(roomCode));
      if (savedId) socket.emit(SOCKET_EVENTS.PLAYER_REJOIN, { roomCode, playerId: savedId });
    }
    tryRejoin();
    socket.on('connect', tryRejoin);
    return () => { socket.off('connect', tryRejoin); };
  }, [roomCode]);

  useEffect(() => {
    const updateAvailability = (items: BuzzerAvailability[]) => setAvailability(items);
    socket.on(SOCKET_EVENTS.BUZZER_AVAILABILITY, updateAvailability);
    socket.emit(SOCKET_EVENTS.WATCH_BUZZERS, { roomCode });
    socket.on(SOCKET_EVENTS.GAME_STATE, (state: GameState) => {
      setGameState(state);
      if (state.phase === 'finished') { setPhase('finished'); return; }
      const currentPhase = phaseRef.current;
      const transient = currentPhase === 'winner' || currentPhase === 'too-late' || currentPhase === 'locked-out';
      if (!state.finalJeopardy && currentPhase !== 'join' && currentPhase !== 'lobby' && currentPhase !== 'finished' && currentPhase !== 'closed' && !transient) {
        if (state.buzzerState === 'open') setPhase('open');
        else if (state.activeQuestionId) setPhase('armed');
        else setPhase('waiting');
      }
    });
    socket.on(SOCKET_EVENTS.PLAYER_JOINED, ({ player, state }: { player: { id: string; name: string }; state: GameState }) => {
      setMyId(player.id);
      setName(player.name);
      setMyPlayer(player as any);
      setGameState(state);
      setPhase('waiting');
      if (roomCode) localStorage.setItem(rejoinKey(roomCode), player.id);
    });
    socket.on(SOCKET_EVENTS.BUZZ_WINNER, ({ playerId, playerName }: { playerId: string; playerName: string }) => {
      if (playerId === myIdRef.current) {
        setWinnerName(playerName);
        setPhase('winner');
      } else {
        setWinnerName(playerName);
        setPhase('too-late');
      }
      setTimeout(() => setPhase(prev => prev === 'winner' || prev === 'too-late' ? 'waiting' : prev), 5000);
    });
    socket.on(SOCKET_EVENTS.BUZZ_LOCKED_OUT, ({ until }: { until: number }) => {
      setPhase('locked-out');
      const delay = Math.max(0, until - Date.now());
      setTimeout(() => setPhase(prev => prev === 'locked-out' ? 'armed' : prev), delay);
    });
    socket.on(SOCKET_EVENTS.BUZZER_OPEN, () => setPhase('open'));
    socket.on(SOCKET_EVENTS.BUZZER_LOCKED, () => setPhase(prev => prev === 'winner' || prev === 'too-late' || prev === 'locked-out' ? prev : 'waiting'));
    socket.on(SOCKET_EVENTS.GAME_ENDED, () => setPhase('closed'));
    socket.on('error', ({ message }: { message: string }) => setError(message));
    return () => {
      socket.off(SOCKET_EVENTS.BUZZER_AVAILABILITY, updateAvailability);
      socket.off(SOCKET_EVENTS.GAME_STATE);
      socket.off(SOCKET_EVENTS.PLAYER_JOINED);
      socket.off(SOCKET_EVENTS.BUZZ_WINNER);
      socket.off(SOCKET_EVENTS.BUZZ_LOCKED_OUT);
      socket.off(SOCKET_EVENTS.BUZZER_OPEN);
      socket.off(SOCKET_EVENTS.BUZZER_LOCKED);
      socket.off(SOCKET_EVENTS.GAME_ENDED);
      socket.off('error');
    };
  }, [roomCode]);

  function joinGame() {
    if (!name.trim()) { setError('Enter your name'); return; }
    setError('');
    socket.emit(SOCKET_EVENTS.PLAYER_JOIN, { roomCode, name: name.trim(), color: randomPlayerColor(), physicalColor: physicalColor || undefined });
  }

  function buzz() {
    if (phase !== 'open' && phase !== 'armed') return;
    socket.emit(SOCKET_EVENTS.BUZZ);
    if (phase === 'open') setPhase('waiting');
  }

  function startEditName() {
    setEditNameValue(name);
    setEditNameError('');
    setEditingName(true);
  }

  function cancelEditName() {
    setEditingName(false);
    setEditNameError('');
  }

  function saveEditName() {
    const trimmed = editNameValue.trim();
    if (!trimmed) { setEditNameError('Name cannot be empty'); return; }
    socket.emit(SOCKET_EVENTS.PLAYER_RENAME, { newName: trimmed }, (res: { ok: boolean; error?: string }) => {
      if (res.ok) {
        setName(trimmed);
        setEditingName(false);
        setEditNameError('');
      } else {
        setEditNameError(res.error ?? 'Could not rename');
      }
    });
  }

  const assignment = gameState?.players.find(p => p.id === myId)?.physicalColor;
  const selectedAvailable = !physicalColor || availability.some(a => a.color === physicalColor && a.online && !a.reserved);
  const myScore = gameState?.players.find(p => p.id === myId)?.score ?? 0;
  const isDDWagering = !!(gameState?.dailyDouble && gameState.dailyDouble.playerId === myId
    && gameState.dailyDouble.stage === 'wagering' && gameState.dailyDouble.hasDevice);

  return (
    <div className="min-h-screen bg-jeopardy-dark flex flex-col items-center justify-center p-4 select-none">

      {/* Room code display */}
      <div className="text-gray-500 text-sm mb-6 text-center">
        Room: <span className="text-jeopardy-gold font-bold tracking-widest">{roomCode}</span>
      </div>

      {myId && assignment && phase !== 'finished' && phase !== 'closed' && <p className="text-gray-300 mb-4">Physical buzzer: {assignment} ({availability.find(a => a.color === assignment)?.online ? 'online' : 'offline — reserved for you'}). Your browser buzzer also works.</p>}
      {/* JOIN phase */}
      {phase === 'join' && (
        <div className="w-full max-w-sm">
          <h1 className="text-4xl font-black text-jeopardy-gold text-center mb-8" style={{ textShadow: '2px 2px 0 #000' }}>
            JEOPARDY!
          </h1>
          <input
            autoFocus
            className="input-field text-xl py-4 text-center mb-4"
            placeholder="Your name"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && joinGame()}
          />
          <label htmlFor="physical-buzzer" className="block text-gray-300 mb-2">Buzzer</label>
          <select id="physical-buzzer" className="input-field mb-4" value={physicalColor} onChange={e => setPhysicalColor(e.target.value)}>
            <option value="">Browser buzzer only</option>
            {availability.filter(a => a.online).map(a => <option key={a.color} value={a.color} disabled={a.reserved}>{a.color[0].toUpperCase() + a.color.slice(1)}{a.reserved ? ' — unavailable' : ''}</option>)}
          </select>
          {!selectedAvailable && <p className="text-red-400 mb-3">That buzzer is no longer available. Choose again.</p>}
          {error && <p className="text-red-400 text-center mb-3">{error}</p>}
          <button className="btn-primary w-full text-xl py-4" onClick={joinGame} disabled={!selectedAvailable}>
            Join Game
          </button>
        </div>
      )}

      {/* Room closed by the host */}
      {phase === 'closed' && (
        <div className="text-center">
          <h2 className="text-3xl font-black text-jeopardy-gold mb-2">Room Closed</h2>
          <p className="text-gray-400">The host ended this game session.</p>
        </div>
      )}

      {/* Game finished — leaderboard */}
      {phase === 'finished' && gameState && (
        <Leaderboard gameState={gameState} compact myId={myId} />
      )}

      {/* Final Jeopardy takes over once it starts */}
      {phase !== 'join' && phase !== 'finished' && phase !== 'closed' && gameState?.finalJeopardy && myId && (
        <PlayerFinal gameState={gameState} myId={myId} />
      )}

      {/* Daily Double wager — only the assigned contestant sees this */}
      {phase !== 'join' && !gameState?.finalJeopardy && isDDWagering && gameState?.dailyDouble && (
        <DDPlayerWager dailyDouble={gameState.dailyDouble} />
      )}

      {/* Inline name editor — lobby only, shown once regardless of sub-phase */}
      {phase !== 'join' && phase !== 'finished' && phase !== 'closed' && gameState?.phase === 'lobby' && myId && (
        <div className="mb-4 w-full max-w-xs">
          {editingName ? (
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                className="input-field text-sm text-center"
                value={editNameValue}
                onChange={e => setEditNameValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveEditName(); if (e.key === 'Escape') cancelEditName(); }}
                maxLength={LIMITS.PLAYER_NAME_MAX}
              />
              {editNameError && <p className="text-red-400 text-xs text-center">{editNameError}</p>}
              <div className="flex gap-2 justify-center">
                <button className="btn-primary text-xs py-1 px-3" onClick={saveEditName}>Save</button>
                <button className="btn-ghost text-xs py-1 px-3" onClick={cancelEditName}>Cancel</button>
              </div>
            </div>
          ) : (
            <button
              className="text-xs text-gray-500 hover:text-gray-300 underline underline-offset-2 mx-auto block"
              onClick={startEditName}
            >
              ✎ Edit name
            </button>
          )}
        </div>
      )}

      {/* WAITING phase */}
      {!gameState?.finalJeopardy && !isDDWagering && phase === 'waiting' && (
        <div className="text-center">
          <p className="text-3xl font-black text-white mb-2">{name}</p>
          <p className="text-jeopardy-gold font-black text-2xl mb-8">
            {formatMoney(myScore)}
          </p>
          <div className="w-48 h-48 rounded-full bg-gray-800 border-8 border-gray-600 flex items-center justify-center mx-auto">
            <span className="text-gray-500 text-xl font-bold text-center px-4">Waiting...</span>
          </div>
        </div>
      )}

      {/* ARMED phase — question is active but buzzer isn't open yet; pressing still reaches the server */}
      {!gameState?.finalJeopardy && !isDDWagering && phase === 'armed' && (
        <div className="text-center">
          <p className="text-3xl font-black text-white mb-2">{name}</p>
          <p className="text-jeopardy-gold font-black text-2xl mb-8">
            {formatMoney(myScore)}
          </p>
          <button
            className="w-48 h-48 rounded-full bg-gray-800 border-8 border-gray-600 flex items-center justify-center mx-auto cursor-pointer"
            style={{ fontSize: '1.25rem', fontWeight: 900, color: '#6b7280', touchAction: 'manipulation' }}
            onClick={buzz}
            onTouchStart={e => { e.preventDefault(); buzz(); }}
          >
            Wait...
          </button>
          <p className="text-gray-500 font-bold mt-6">Get ready</p>
        </div>
      )}

      {/* LOCKED-OUT phase — pressed too early */}
      {!gameState?.finalJeopardy && phase === 'locked-out' && (
        <div className="text-center flip-in">
          <div className="w-48 h-48 rounded-full bg-red-900 border-8 border-red-500 flex items-center justify-center mx-auto animate-pulse">
            <span className="text-red-300 text-2xl font-black">Too early!</span>
          </div>
        </div>
      )}

      {/* OPEN phase — buzzer ready */}
      {!gameState?.finalJeopardy && !isDDWagering && phase === 'open' && (
        <div className="text-center">
          <p className="text-3xl font-black text-white mb-2">{name}</p>
          <p className="text-jeopardy-gold font-black text-2xl mb-8">
            {formatMoney(myScore)}
          </p>
          <button
            className="w-56 h-56 rounded-full border-8 border-jeopardy-gold bg-jeopardy-blue flex items-center justify-center mx-auto buzzer-active cursor-pointer"
            style={{ fontSize: '1.5rem', fontWeight: 900, color: '#FFD700', touchAction: 'manipulation' }}
            onClick={buzz}
            onTouchStart={e => { e.preventDefault(); buzz(); }}
          >
            BUZZ!
          </button>
          <p className="text-green-400 font-bold mt-6 animate-pulse">Buzzers are open!</p>
        </div>
      )}

      {/* WINNER phase */}
      {!gameState?.finalJeopardy && phase === 'winner' && (
        <div className="text-center flip-in">
          <div className="text-6xl mb-4">⚡</div>
          <h2 className="text-4xl font-black text-jeopardy-gold mb-2" style={{ textShadow: '2px 2px 0 #000' }}>
            YOU BUZZED IN!
          </h2>
          <p className="text-white text-xl">{name}</p>
        </div>
      )}

      {/* TOO LATE phase */}
      {!gameState?.finalJeopardy && phase === 'too-late' && (
        <div className="text-center flip-in">
          <div className="text-6xl mb-4">❌</div>
          <h2 className="text-3xl font-black text-red-400 mb-2">Too slow!</h2>
          <p className="text-gray-400">{winnerName} buzzed in first</p>
        </div>
      )}

      {/* Players list (compact) */}
      {!gameState?.finalJeopardy && gameState && gameState.players.length > 0 && phase !== 'join' && phase !== 'finished' && phase !== 'closed' && (
        <div className="mt-12 w-full max-w-sm">
          <h3 className="text-gray-500 text-xs uppercase tracking-widest mb-2 text-center">Scoreboard</h3>
          <div className="space-y-1">
            {[...gameState.players].sort((a, b) => b.score - a.score).map(p => (
              <div key={p.id} className="flex justify-between items-center px-3 py-1 rounded bg-gray-900">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                  <span className={`text-sm ${p.id === myId ? 'text-white font-bold' : 'text-gray-400'}`}>{p.name}</span>
                </div>
                <span className="font-bold text-sm" style={{ color: p.score < 0 ? '#ef4444' : '#FFD700' }}>
                  {formatMoney(p.score)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
