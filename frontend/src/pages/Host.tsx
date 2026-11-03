import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { socket } from '../socket';
import { useGameStore } from '../store/gameStore';
import type { Board, GameState, Question } from '@shared/types';
import { SOCKET_EVENTS } from '@shared/socketEvents';
import HostFinalPanel from '../components/final/HostFinalPanel';
import DDHostPanel from '../components/dailydouble/DDHostPanel';
import Leaderboard from '../components/shared/Leaderboard';
import { getRound, isRoundComplete } from '../utils/rounds';
import { PLAYER_COLORS } from '../utils/colors';
import ShareLink from '../components/host/ShareLink';
import BoardGrid from '../components/host/BoardGrid';
import ActiveQuestionPanel from '../components/host/ActiveQuestionPanel';
import PlayersTab from '../components/host/PlayersTab';
import LogTab from '../components/host/LogTab';
import StatsTab from '../components/host/StatsTab';

const API = '/api';

export default function Host() {
  const { boardId } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const { gameState, setGameState, roomCode, setRoomCode, gameLog, addLog, clearLog } = useGameStore();
  const [board, setBoard] = useState<Board | null>(null);
  const [activeQ, setActiveQ] = useState<Question | null>(null);
  const [addPlayerName, setAddPlayerName] = useState('');
  const [buzzWinner, setBuzzWinner] = useState<string | null>(null);
  const [buzzWinnerId, setBuzzWinnerId] = useState<string | null>(null);
  const [renamingPlayerId, setRenamingPlayerId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [tab, setTab] = useState<'players' | 'log' | 'stats'>('players');

  useEffect(() => {
    fetch(`${API}/boards/${boardId}`).then(r => r.json()).then(setBoard);

    socket.on(SOCKET_EVENTS.GAME_STATE, (state: GameState) => {
      setGameState(state);
      setRoomCode(state.roomCode);
    });
    socket.on(SOCKET_EVENTS.BUZZ_WINNER, ({ playerName, playerId }: { playerName: string; playerId: string }) => {
      setBuzzWinner(playerName);
      setBuzzWinnerId(playerId);
      addLog({ type: 'buzz', msg: `${playerName} buzzed in`, player: playerName });
    });
    socket.on(SOCKET_EVENTS.HOST_CREATED, ({ roomCode: rc, state }: { roomCode: string; state: GameState }) => {
      setRoomCode(rc);
      setGameState(state);
      clearLog();
      addLog({ type: 'open', msg: 'Game session started' });
    });
    socket.on(SOCKET_EVENTS.FJ_HOST_LOG, ({ msg }: { msg: string }) => {
      addLog({ type: 'fj', msg });
    });
    socket.on(SOCKET_EVENTS.BUZZ_NEXT_IN_QUEUE, ({ playerName, playerId }: { playerName: string; playerId: string }) => {
      setBuzzWinner(playerName);
      setBuzzWinnerId(playerId);
      addLog({ type: 'buzz', msg: `Queue advance → ${playerName}`, player: playerName });
    });

    socket.emit(SOCKET_EVENTS.HOST_CREATE, { boardId });

    return () => {
      socket.off('game:state');
      socket.off('buzz:winner');
      socket.off('host:created');
      socket.off('fj:host-log');
      socket.off('buzz:next-in-queue');
    };
  }, [boardId]);

  // Re-join the host:<roomCode> room after a socket reconnect (WiFi blip,
  // laptop sleep, backend restart) so host-only socket events keep working.
  useEffect(() => {
    function rejoinAsHost() {
      if (roomCode) socket.emit(SOCKET_EVENTS.HOST_JOIN, { roomCode });
    }
    socket.on('connect', rejoinAsHost);
    return () => { socket.off('connect', rejoinAsHost); };
  }, [roomCode]);

  useEffect(() => {
    if (!gameState || !board) return;
    if (!gameState.activeQuestionId) { setActiveQ(null); return; }
    const round = getRound(board, gameState);
    const q = round.categories.flatMap(c => c.questions).find(q => q.id === gameState.activeQuestionId);
    setActiveQ(q ?? null);
  }, [gameState?.activeQuestionId, board, gameState?.currentRoundIndex]);

  if (!board || !gameState || !roomCode) {
    return <div className="flex items-center justify-center h-screen text-gray-400">Starting game session...</div>;
  }

  const answered = new Set(gameState.answeredQuestions);
  const round = getRound(board, gameState);
  const isLastRound = gameState.currentRoundIndex >= board.rounds.length - 1;
  const roundComplete = isRoundComplete(board, gameState.answeredQuestions, gameState.currentRoundIndex);

  function getCatName(q: Question): string {
    return round.categories.find(c => c.questions.some(cq => cq.id === q.id))?.name ?? '';
  }

  function openQuestion(q: Question) {
    setBuzzWinner(null);
    setBuzzWinnerId(null);
    const boardHighValue = Math.max(...round.pointValues);
    socket.emit(SOCKET_EVENTS.HOST_OPEN_QUESTION, { roomCode, questionId: q.id, isDailyDouble: !!q.isDailyDouble, boardHighValue });
    if (q.isDailyDouble) {
      addLog({ type: 'dd', msg: `Daily Double opened — $${q.value} (${getCatName(q)})` });
    } else {
      addLog({ type: 'open', msg: `Opened $${q.value} — ${getCatName(q)}` });
    }
  }

  function revealDD() {
    socket.emit(SOCKET_EVENTS.HOST_REVEAL_DD, { roomCode });
    addLog({ type: 'dd', msg: 'Daily Double clue revealed' });
  }

  function closeQuestion() {
    setBuzzWinner(null);
    setBuzzWinnerId(null);
    const label = activeQ ? `$${activeQ.value} — ${getCatName(activeQ)}` : 'question';
    socket.emit(SOCKET_EVENTS.HOST_CLOSE_QUESTION, { roomCode });
    addLog({ type: 'close', msg: `Closed ${label} (no score)` });
  }

  function enableBuzzer() {
    setBuzzWinner(null);
    setBuzzWinnerId(null);
    socket.emit(SOCKET_EVENTS.HOST_ENABLE_BUZZER, { roomCode });
  }

  function lockBuzzer() {
    socket.emit(SOCKET_EVENTS.HOST_LOCK_BUZZER, { roomCode });
  }

  function resetBuzzer() {
    setBuzzWinner(null);
    setBuzzWinnerId(null);
    socket.emit(SOCKET_EVENTS.HOST_RESET_BUZZER, { roomCode });
  }

  function showAnswer() {
    socket.emit(SOCKET_EVENTS.HOST_SHOW_RESPONSE, { roomCode });
  }

  function awardPoints(playerId: string, correct: boolean) {
    const isDD = !!activeQ?.isDailyDouble && gameState!.dailyDouble?.stage === 'ready';
    const value = isDD ? (gameState!.dailyDouble!.wager ?? 0) : (activeQ?.value ?? 0);
    const delta = correct ? value : -value;
    const player = gameState!.players.find(p => p.id === playerId);
    socket.emit(SOCKET_EVENTS.HOST_SCORE, { roomCode, playerId, delta, outcome: correct ? 'correct' : 'wrong', isDailyDouble: isDD });
    if (correct) {
      addLog({ type: 'correct', msg: `${player?.name} answered correctly (+$${value})`, player: player?.name });
    } else {
      addLog({ type: 'wrong', msg: `${player?.name} answered wrong (-$${value})`, player: player?.name });
    }
    // close without double-logging
    setBuzzWinner(null);
    setBuzzWinnerId(null);
    socket.emit(SOCKET_EVENTS.HOST_CLOSE_QUESTION, { roomCode });
  }

  function markWrongAndReopen(playerId: string) {
    const value = activeQ?.value ?? 0;
    const player = gameState!.players.find(p => p.id === playerId);
    socket.emit(SOCKET_EVENTS.HOST_WRONG_REOPEN, { roomCode, playerId, delta: -value });
    addLog({ type: 'wrong', msg: `${player?.name ?? 'Player'} answered wrong (-$${value})`, player: player?.name });
    setBuzzWinner(null);
    setBuzzWinnerId(null);
  }

  function adjustScore(playerId: string, delta: number) {
    const player = gameState!.players.find(p => p.id === playerId);
    socket.emit(SOCKET_EVENTS.HOST_SCORE, { roomCode, playerId, delta });
    addLog({ type: 'score', msg: `${player?.name} score adjusted ${delta > 0 ? '+' : ''}${delta}`, player: player?.name });
  }

  function addPlayer() {
    if (!addPlayerName.trim()) return;
    const color = PLAYER_COLORS[(gameState?.players.length ?? 0) % PLAYER_COLORS.length];
    socket.emit(SOCKET_EVENTS.HOST_ADD_PLAYER, { roomCode, name: addPlayerName.trim(), color });
    setAddPlayerName('');
  }

  function removePlayer(playerId: string) {
    socket.emit(SOCKET_EVENTS.HOST_REMOVE_PLAYER, { roomCode, playerId });
  }

  function startRenamePlayer(player: { id: string; name: string }) {
    setRenamingPlayerId(player.id);
    setRenameValue(player.name);
    setRenameError('');
  }

  function cancelRenamePlayer() {
    setRenamingPlayerId(null);
    setRenameError('');
  }

  function saveRenamePlayer(playerId: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) { setRenameError('Name cannot be empty'); return; }
    socket.emit(SOCKET_EVENTS.HOST_RENAME_PLAYER, { roomCode, playerId, newName: trimmed }, (res: { ok: boolean; error?: string }) => {
      if (res.ok) {
        setRenamingPlayerId(null);
        setRenameError('');
      } else {
        setRenameError(res.error ?? 'Could not rename');
      }
    });
  }

  function startFinalJeopardy() {
    const totalQuestions = board!.rounds.reduce((n, r) => n + r.categories.reduce((n2, c) => n2 + c.questions.length, 0), 0);
    const remaining = totalQuestions - gameState!.answeredQuestions.length;
    if (remaining > 0 && !confirm(`${remaining} clue(s) haven't been played yet. Start Final Jeopardy anyway?`)) return;
    socket.emit(SOCKET_EVENTS.HOST_FJ_START, { roomCode });
  }

  function nextRound() {
    socket.emit(SOCKET_EVENTS.HOST_NEXT_ROUND, { roomCode });
  }

  function endGame() {
    if (!confirm('End the game and show the leaderboard?')) return;
    socket.emit(SOCKET_EVENTS.HOST_END_GAME, { roomCode });
  }

  function resumeGame() {
    socket.emit(SOCKET_EVENTS.HOST_RESUME_GAME, { roomCode });
  }

  function closeRoom() {
    if (!confirm('Close this room? This ends the session for everyone and cannot be undone.')) return;
    socket.emit(SOCKET_EVENTS.HOST_END, { roomCode });
    navigate('/');
  }
  const boardUrl = `${window.location.origin}/board/${roomCode}`;
  const buzzUrl = `${window.location.origin}/buzz/${roomCode}`;
  const qrUrl = `${window.location.origin}/qr/${roomCode}`;

  // Per-player stats come from the server (survives refresh, includes early buzzes)
  const playerStats = gameState.players.map(p => ({
    ...p,
    correct: p.stats?.correct ?? 0,
    wrong: p.stats?.wrong ?? 0,
    buzzes: p.stats?.buzzes ?? 0,
    earlyBuzzes: p.stats?.earlyBuzzes ?? 0,
  })).sort((a, b) => b.score - a.score);

  function setLockout(ms: number) {
    socket.emit(SOCKET_EVENTS.HOST_SET_LOCKOUT, { roomCode, ms });
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col text-white">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-700 px-4 py-3 flex items-center gap-4 flex-wrap">
        <button onClick={closeRoom} className="text-gray-400 hover:text-white text-sm">Close Room</button>
        <h1 className="text-xl font-black text-jeopardy-gold">{board.name}</h1>
        <div className="bg-gray-800 rounded px-3 py-1 text-sm">
          Round {gameState.currentRoundIndex + 1} of {board.rounds.length}
          {round.name ? ` — ${round.name}` : ''}
        </div>
        <div className="ml-auto flex gap-3 items-center flex-wrap">
          {!isLastRound && (
            <button
              className={`text-sm py-1 px-3 rounded font-bold ${roundComplete ? 'bg-jeopardy-gold text-jeopardy-dark' : 'btn-ghost'}`}
              disabled={!!gameState.activeQuestionId}
              onClick={nextRound}
            >
              Next Round →
            </button>
          )}
          <div className="bg-gray-800 rounded px-3 py-1 text-sm">
            Room: <span className="text-jeopardy-gold font-black tracking-widest text-lg">{roomCode}</span>
          </div>
          <a href={boardUrl} target="_blank" rel="noopener" className="btn-ghost text-sm py-1 px-3">📺 Board View</a>
          <div className="bg-gray-800 rounded px-3 py-1 text-sm flex items-center gap-2">
            <span className="text-gray-400">Lockout:</span>
            <select
              className="bg-gray-800 text-white text-sm"
              value={gameState.settings.lockoutMs}
              onChange={e => setLockout(Number(e.target.value))}
            >
              <option value={0}>Off</option>
              <option value={250}>250ms</option>
              <option value={500}>500ms</option>
              <option value={1000}>1000ms</option>
            </select>
          </div>
          <div className="flex items-center gap-2 bg-gray-800 rounded px-3 py-1 text-sm">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={gameState.settings.autoLockEnabled}
                onChange={e => socket.emit(SOCKET_EVENTS.HOST_SET_AUTO_LOCK, { roomCode, enabled: e.target.checked })}
                className="accent-yellow-400"
              />
              <span className="text-gray-400 text-xs">Auto-lock</span>
            </label>
            {gameState.settings.autoLockEnabled && (
              <>
                <input
                  type="number"
                  min={5}
                  max={10}
                  value={gameState.settings.autoLockTimeoutS}
                  onChange={e => {
                    const s = Number(e.target.value);
                    if (s >= 5 && s <= 10) socket.emit(SOCKET_EVENTS.HOST_SET_AUTO_LOCK_TIMEOUT, { roomCode, seconds: s });
                  }}
                  className="bg-gray-700 text-white text-xs w-10 rounded px-1 py-0.5 text-center"
                />
                <span className="text-gray-400 text-xs">s</span>
              </>
            )}
          </div>
          {gameState.phase !== 'finished' && (
            <button className="btn-danger text-sm py-1 px-3" onClick={endGame}>End Game</button>
          )}
        </div>
      </div>

      {/* Game-over banner */}
      {gameState.phase === 'finished' && (
        <div className="bg-jeopardy-gold text-jeopardy-dark px-4 py-2 flex items-center gap-4 flex-wrap font-bold">
          <span>🏁 Game ended</span>
          <div className="ml-auto flex gap-2">
            <button className="bg-jeopardy-dark text-white text-sm py-1 px-3 rounded" onClick={resumeGame}>Resume</button>
            <button className="bg-red-700 text-white text-sm py-1 px-3 rounded" onClick={closeRoom}>Close Room</button>
          </div>
        </div>
      )}

      {/* Prompt when the last round is complete and the board has Final Jeopardy */}
      {gameState.phase !== 'finished' && isLastRound && roundComplete && !gameState.activeQuestionId && board.finalJeopardy && !gameState.finalJeopardy && (
        <div className="bg-jeopardy-blue px-4 py-2 flex items-center gap-4 flex-wrap font-bold text-white">
          <span>⚡ Last round complete — start Final Jeopardy or end the game.</span>
          <div className="ml-auto flex gap-2">
            <button className="bg-jeopardy-gold text-jeopardy-dark text-sm py-1 px-3 rounded" onClick={startFinalJeopardy}>Start Final Jeopardy</button>
            <button className="bg-red-700 text-white text-sm py-1 px-3 rounded" onClick={endGame}>End Game</button>
          </div>
        </div>
      )}

      {gameState.phase === 'finished' ? (
        <div className="flex-1 overflow-auto p-8">
          <Leaderboard gameState={gameState} />
        </div>
      ) : (
      <div className="flex-1 flex gap-0 overflow-hidden">
        {/* Left: Board grid */}
        <div className="flex-1 overflow-auto p-3">
          <BoardGrid
            round={round}
            answered={answered}
            activeQuestionId={gameState.activeQuestionId}
            onOpenQuestion={openQuestion}
          />

          {/* Final Jeopardy launcher */}
          {board.finalJeopardy && !gameState.finalJeopardy && (
            <button
              className="mt-4 w-full bg-jeopardy-gold text-jeopardy-dark font-black py-3 rounded-lg hover:brightness-110 transition-all"
              onClick={startFinalJeopardy}
            >
              ⚡ Start Final Jeopardy
            </button>
          )}

          {/* Share links */}
          <div className="mt-4 space-y-2">
            <ShareLink label="Board view (project this)" url={boardUrl} open />
            <ShareLink label="Player buzzer (share with players)" url={buzzUrl} open />
            <ShareLink label="Player QR code (project this)" url={qrUrl} open />
          </div>
        </div>

        {/* Right panel */}
        <div className="w-80 bg-gray-900 border-l border-gray-700 flex flex-col overflow-hidden">

          {/* Active question panel */}
          <div className="p-4 border-b border-gray-700 flex-shrink-0">
            <h2 className="text-sm font-bold text-gray-400 uppercase mb-3">Active Question</h2>
            {gameState.finalJeopardy ? (
              <HostFinalPanel roomCode={roomCode} gameState={gameState} board={board} />
            ) : activeQ?.isDailyDouble && gameState.dailyDouble ? (
              <DDHostPanel
                roomCode={roomCode}
                gameState={gameState}
                activeQ={activeQ}
                onAward={awardPoints}
                onReveal={revealDD}
                onClose={closeQuestion}
              />
            ) : activeQ ? (
              <ActiveQuestionPanel
                activeQ={activeQ}
                responseVisible={gameState.responseVisible}
                buzzerState={gameState.buzzerState}
                buzzWinner={buzzWinner}
                buzzWinnerId={buzzWinnerId}
                players={gameState.players}
                buzzLockouts={gameState.buzzLockouts}
                buzzQueue={gameState.buzzQueue}
                buzzedPlayerId={gameState.buzzedPlayerId}
                onShowAnswer={showAnswer}
                onEnableBuzzer={enableBuzzer}
                onLockBuzzer={lockBuzzer}
                onResetBuzzer={resetBuzzer}
                onAward={awardPoints}
                onMarkWrong={markWrongAndReopen}
                onClose={closeQuestion}
              />
            ) : (
              <p className="text-gray-500 text-sm">Click a question on the board to open it.</p>
            )}
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-gray-700 flex-shrink-0">
            {(['players', 'log', 'stats'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2 text-xs font-bold uppercase transition-colors
                  ${tab === t ? 'text-jeopardy-gold border-b-2 border-jeopardy-gold bg-gray-800' : 'text-gray-500 hover:text-gray-300'}`}
              >
                {t === 'players' ? '👥 Players' : t === 'log' ? '📜 Log' : '📊 Stats'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-4">

            {/* Players tab */}
            {tab === 'players' && (
              <PlayersTab
                players={gameState.players}
                addPlayerName={addPlayerName}
                onAddPlayerNameChange={setAddPlayerName}
                onAddPlayer={addPlayer}
                renamingPlayerId={renamingPlayerId}
                renameValue={renameValue}
                onRenameValueChange={setRenameValue}
                renameError={renameError}
                onStartRename={startRenamePlayer}
                onCancelRename={cancelRenamePlayer}
                onSaveRename={saveRenamePlayer}
                onAdjustScore={adjustScore}
                onRemovePlayer={removePlayer}
              />
            )}

            {/* Log tab */}
            {tab === 'log' && (
              <LogTab gameLog={gameLog} onClearLog={clearLog} />
            )}

            {/* Stats tab */}
            {tab === 'stats' && (
              <StatsTab
                playerStats={playerStats}
                answeredQuestionsCount={gameState.answeredQuestions.length}
                gameLog={gameLog}
              />
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
