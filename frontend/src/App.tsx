import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { socket } from './socket';
import { useGameStore } from './store/gameStore';
import Dashboard from './pages/Dashboard';
import Editor from './pages/Editor';
import Host from './pages/Host';
import BoardView from './pages/BoardView';
import Buzzer from './pages/Buzzer';
import PlayerQR from './pages/PlayerQR';
import type { GameState, Player } from '@shared/types';
import { SOCKET_EVENTS } from '@shared/socketEvents';

export default function App() {
  const { setGameState, setConnected } = useGameStore();

  useEffect(() => {
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on(SOCKET_EVENTS.GAME_STATE, (state: GameState) => setGameState(state));
    socket.on(SOCKET_EVENTS.PLAYER_JOINED, ({ player, state }: { player: Player; state: GameState }) => {
      useGameStore.getState().setMyPlayer(player);
      setGameState(state);
    });
    socket.connect();
    return () => { socket.disconnect(); };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/editor/:boardId" element={<Editor />} />
        <Route path="/host/:boardId" element={<Host />} />
        <Route path="/board/:roomCode" element={<BoardView />} />
        <Route path="/buzz/:roomCode" element={<Buzzer />} />
        <Route path="/qr/:roomCode" element={<PlayerQR />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
