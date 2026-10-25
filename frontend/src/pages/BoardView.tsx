import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { socket } from '../socket';
import { useGameStore } from '../store/gameStore';
import type { Board, GameState, Question } from '@shared/types';
import { SOCKET_EVENTS } from '@shared/socketEvents';
import { playDailyDouble, playBuzzerReady, playBuzzIn, playQuestionOpen, playCorrect, playWrong } from '../utils/sounds';
import FinalBoardScreen from '../components/final/FinalBoardScreen';
import Leaderboard from '../components/shared/Leaderboard';
import { getRound, isRoundComplete } from '../utils/rounds';
import { getYouTubeEmbedUrl } from '../utils/media';
import { formatMoney } from '../utils/format';

const API = '/api';

export default function BoardView() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const { gameState, setGameState } = useGameStore();
  const [board, setBoard] = useState<Board | null>(null);
  const [showQuestion, setShowQuestion] = useState<Question | null>(null);
  const [buzzWinner, setBuzzWinner] = useState<{ playerName: string } | null>(null);
  const [roundSplash, setRoundSplash] = useState<{ index: number; name: string | null } | null>(null);
  const [roomClosed, setRoomClosed] = useState(false);
  const prevBuzzerState = useRef<string>('idle');
  const prevActiveId = useRef<string | null>(null);

  // Re-join the host:<roomCode> room after a socket reconnect (WiFi blip,
  // browser sleep, backend restart) so this board keeps receiving host-only state.
  useEffect(() => {
    if (!roomCode) return;
    function rejoin() { socket.emit(SOCKET_EVENTS.HOST_JOIN, { roomCode }); }
    socket.on('connect', rejoin);
    return () => { socket.off('connect', rejoin); };
  }, [roomCode]);

  useEffect(() => {
    if (!roomCode) return;
    socket.emit(SOCKET_EVENTS.HOST_JOIN, { roomCode });
    socket.on(SOCKET_EVENTS.GAME_STATE, (state: GameState) => {
      setGameState(state);
      if (!board && state.boardId) {
        fetch(`${API}/boards/${state.boardId}`).then(r => r.json()).then(setBoard);
      }
      // Play sound when buzzers first open
      if (state.buzzerState === 'open' && prevBuzzerState.current !== 'open') {
        playBuzzerReady();
      }
      prevBuzzerState.current = state.buzzerState;
    });
    socket.on(SOCKET_EVENTS.BUZZ_WINNER, ({ playerName }: { playerName: string }) => {
      setBuzzWinner({ playerName });
      playBuzzIn();
      setTimeout(() => setBuzzWinner(null), 1500);
    });
    socket.on(SOCKET_EVENTS.SCORE_RESULT, ({ correct }: { correct: boolean }) => {
      correct ? playCorrect() : playWrong();
    });
    socket.on(SOCKET_EVENTS.ROUND_CHANGED, ({ index, name }: { index: number; name: string | null }) => {
      setRoundSplash({ index, name });
      setTimeout(() => setRoundSplash(null), 3000);
    });
    socket.on(SOCKET_EVENTS.GAME_ENDED, () => setRoomClosed(true));
    socket.emit(SOCKET_EVENTS.GET_STATE, { roomCode });
    return () => {
      socket.off('game:state');
      socket.off('buzz:winner');
      socket.off('score:result');
      socket.off('round:changed');
      socket.off('game:ended');
    };
  }, [roomCode]);

  // Sync active question display + play DD sound
  useEffect(() => {
    if (!gameState || !board) return;
    if (!gameState.activeQuestionId) { setShowQuestion(null); return; }
    if (gameState.activeQuestionId === prevActiveId.current) return;
    prevActiveId.current = gameState.activeQuestionId;
    const round = getRound(board, gameState);
    const q = round.categories.flatMap(c => c.questions).find(q => q.id === gameState.activeQuestionId);
    setShowQuestion(q ?? null);
    if (q?.isDailyDouble) playDailyDouble();
    else if (q) playQuestionOpen();
  }, [gameState?.activeQuestionId, board, gameState?.currentRoundIndex]);

  if (roomClosed) {
    return (
      <div className="min-h-screen bg-jeopardy-dark flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-black text-jeopardy-gold mb-4">Room Closed</h1>
          <p className="text-gray-400">The host ended this game session.</p>
        </div>
      </div>
    );
  }

  if (!gameState || !board) {
    return (
      <div className="min-h-screen bg-jeopardy-dark flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-black text-jeopardy-gold mb-4">Connecting...</h1>
          <p className="text-gray-400">Room: {roomCode}</p>
        </div>
      </div>
    );
  }

  if (gameState.phase === 'finished') {
    return (
      <div className="min-h-screen bg-jeopardy-dark flex items-center justify-center py-12" style={{ fontFamily: 'Arial Black, Impact, sans-serif' }}>
        <Leaderboard gameState={gameState} />
      </div>
    );
  }

  const answeredSet = new Set(gameState.answeredQuestions);
  const round = getRound(board, gameState);
  const roundComplete = isRoundComplete(board, gameState.answeredQuestions, gameState.currentRoundIndex);
  const isLastRound = gameState.currentRoundIndex >= board.rounds.length - 1;
  const isDDSplash = showQuestion?.isDailyDouble && (
    !gameState.dailyDoubleRevealed || (gameState.dailyDouble != null && gameState.dailyDouble.stage !== 'ready')
  );

  return (
    <div className="min-h-screen bg-jeopardy-dark flex flex-col overflow-hidden" style={{ fontFamily: 'Arial Black, Impact, sans-serif' }}>

      {/* Final Jeopardy takes over the whole screen once it starts */}
      {gameState.finalJeopardy && <FinalBoardScreen gameState={gameState} />}

      {/* Round splash — shown briefly when the host advances to a new round */}
      {roundSplash && !gameState.finalJeopardy && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center"
             style={{ background: 'linear-gradient(135deg, #060CE9 0%, #0A0A2E 100%)' }}>
          <div className="text-jeopardy-gold font-black dd-reveal text-center"
               style={{ fontSize: 'clamp(36px, 9vw, 110px)', textShadow: '4px 4px 0 #000, 0 0 40px rgba(255,215,0,0.5)', letterSpacing: '0.06em' }}>
            {roundSplash.name ?? `Round ${roundSplash.index + 1}`}
          </div>
        </div>
      )}

      {/* End-of-round interstitial — shown when the round is done but it isn't the last one */}
      {!gameState.finalJeopardy && !roundSplash && roundComplete && !isLastRound && !gameState.activeQuestionId && (
        <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-jeopardy-dark/95">
          <div className="text-jeopardy-gold font-black text-4xl mb-4" style={{ textShadow: '2px 2px 0 #000' }}>
            End of {round.name ?? 'Round'}
          </div>
          <p className="text-gray-400 text-xl animate-pulse">Waiting for the host to start the next round…</p>
        </div>
      )}
      {/* Buzz winner overlay */}
      {buzzWinner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-jeopardy-blue border-8 border-jeopardy-gold rounded-2xl px-16 py-10 text-center flip-in">
            <div className="text-3xl text-gray-300 mb-2">BUZZED IN</div>
            <div className="text-6xl font-black text-jeopardy-gold" style={{ textShadow: '3px 3px 0 #000' }}>
              {buzzWinner.playerName}
            </div>
          </div>
        </div>
      )}

      {/* Daily Double splash — shown instead of clue until host reveals */}
      {isDDSplash && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center"
             style={{ background: 'linear-gradient(135deg, #060CE9 0%, #0A0A2E 100%)' }}>
          <div className="text-jeopardy-gold font-black dd-reveal"
               style={{ fontSize: 'clamp(48px, 12vw, 140px)', textShadow: '4px 4px 0 #000, 0 0 40px rgba(255,215,0,0.5)', letterSpacing: '0.08em' }}>
            DAILY
          </div>
          <div className="text-jeopardy-gold font-black dd-reveal"
               style={{ fontSize: 'clamp(48px, 12vw, 140px)', textShadow: '4px 4px 0 #000, 0 0 40px rgba(255,215,0,0.5)', letterSpacing: '0.08em', animationDelay: '0.15s' }}>
            DOUBLE!
          </div>
          <div className="mt-8 text-white text-xl font-bold opacity-60 animate-pulse">
            ${showQuestion?.value}
          </div>
        </div>
      )}

      {/* Question overlay — shown after DD reveal or immediately for regular questions */}
      {showQuestion && !isDDSplash && (
        <div className="fixed inset-0 bg-jeopardy-blue z-40 flex flex-col items-center justify-center p-8 flip-in">
          <div className="text-jeopardy-gold font-black text-2xl mb-4 tracking-widest">
            ${showQuestion.value}
            {showQuestion.isDailyDouble && (
              <span className="ml-4 bg-yellow-400 text-black px-3 py-1 rounded text-xl">DAILY DOUBLE!</span>
            )}
          </div>

          {/* Media */}
          {showQuestion.mediaType === 'image' && showQuestion.mediaUrl && (
            <img src={showQuestion.mediaUrl} alt="clue" className="max-h-64 max-w-full object-contain mb-6 rounded" />
          )}
          {showQuestion.mediaType === 'video' && showQuestion.mediaUrl && (
            <video src={showQuestion.mediaUrl} autoPlay controls className="max-h-64 max-w-2xl mb-6 rounded w-full" />
          )}
          {showQuestion.mediaType === 'youtube' && showQuestion.mediaUrl && (
            <div className="mb-6 w-full max-w-2xl aspect-video">
              <iframe
                className="w-full h-full rounded"
                src={getYouTubeEmbedUrl(showQuestion.mediaUrl)}
                allow="autoplay; fullscreen"
                allowFullScreen
              />
            </div>
          )}

          {/* Clue text */}
          <div className="text-white text-center text-3xl md:text-5xl font-black max-w-4xl leading-tight"
               style={{ textShadow: '2px 2px 0 #000' }}>
            {showQuestion.clue}
          </div>

          {/* Answer — shown when host clicks "Show Answer" */}
          {gameState.responseVisible && (
            <div className="mt-8 fade-up bg-black/60 border-2 border-jeopardy-gold rounded-xl px-8 py-4 text-center max-w-3xl">
              <div className="text-gray-400 text-lg mb-1 uppercase tracking-widest">Answer</div>
              <div className="text-jeopardy-gold font-black text-3xl md:text-4xl" style={{ textShadow: '2px 2px 0 #000' }}>
                {showQuestion.response}
              </div>
            </div>
          )}

          {/* Buzzer state indicator */}
          <div className="mt-6">
            {gameState.buzzerState === 'open' && (
              <div className="text-green-400 text-2xl font-bold animate-pulse">🔔 BUZZERS OPEN</div>
            )}
            {gameState.buzzerState === 'locked' && gameState.buzzedPlayerName && (
              <div className="text-jeopardy-gold text-2xl font-bold">
                ⚡ {gameState.buzzedPlayerName}
              </div>
            )}
          </div>

          {/* Buzz order panel */}
          {gameState?.buzzQueue && gameState.buzzQueue.length > 0 && (
            <div className="absolute bottom-4 right-4 bg-gray-900 bg-opacity-90 border border-gray-600 rounded-lg p-3 text-sm min-w-[160px]">
              <div className="text-[10px] text-gray-500 uppercase mb-2">Buzz Order</div>
              {gameState.buzzQueue.map((entry, i) => (
                <div
                  key={entry.playerId}
                  className={`flex items-center gap-2 py-0.5 ${
                    entry.attemptedAnswer ? 'text-gray-600 line-through' :
                    entry.playerId === gameState.buzzedPlayerId ? 'text-yellow-400 font-bold' :
                    'text-gray-300'
                  }`}
                >
                  <span className="text-gray-500 w-4 text-xs">{i + 1}.</span>
                  <span className="flex-1 text-xs">{entry.playerName}</span>
                  <span className="text-gray-500 text-xs tabular-nums">{entry.reactionMs}ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Board grid */}
      <div className="flex-1 grid" style={{
        gridTemplateColumns: `repeat(${round.categories.length}, 1fr)`,
        gap: '4px',
        padding: '4px',
      }}>
      {/* Category headers */}
      {round.categories.map(cat => (
        <div
          key={cat.id}
          className="bg-jeopardy-blue border-4 border-black text-white font-black text-center flex items-center justify-center p-2"
          style={{
            minHeight: '80px',
            fontSize: 'clamp(18px, 2.5vw, 36px)',
            textTransform: 'uppercase',
            textShadow: '2px 2px 0 #000',
            overflowWrap: 'anywhere',
          }}
        >
          {cat.name || 'CATEGORY'}
        </div>
      ))}

        {/* Question cells */}
        {round.pointValues.map(pv => (
          round.categories.map(cat => {
            const q = cat.questions.find(q => q.value === pv);
            const isAnswered = q ? answeredSet.has(q.id) : false;
            return (
              <div
                key={`${cat.id}-${pv}`}
                className={`border-4 border-black flex items-center justify-center font-black text-center
                  ${isAnswered ? 'bg-jeopardy-dark text-gray-800' : 'bg-jeopardy-blue text-jeopardy-gold'}`}
                style={{ fontSize: 'clamp(18px, 3vw, 48px)', textShadow: isAnswered ? 'none' : '2px 2px 0 #000', minHeight: '60px' }}
              >
                {isAnswered ? '' : `$${pv}`}
              </div>
            );
          })
        ))}
      </div>

      {/* Score bar */}
      <div className="bg-black border-t-4 border-jeopardy-gold flex">
        {gameState.players.map(player => (
          <div
            key={player.id}
            className="flex-1 text-center py-2 border-r border-gray-700 last:border-0"
            style={{ borderBottomColor: player.color, borderBottomWidth: 4 }}
          >
            <div className="text-white font-bold text-sm truncate px-2">{player.name}</div>
            <div
              className="font-black text-xl"
              style={{ color: player.score < 0 ? '#ef4444' : '#FFD700' }}
            >
              {formatMoney(player.score)}
            </div>
          </div>
        ))}
        {gameState.players.length === 0 && (
          <div className="flex-1 text-center py-2 text-gray-600 text-sm">No players yet</div>
        )}
      </div>
    </div>
  );
}
