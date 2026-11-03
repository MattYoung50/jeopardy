import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import ShareLink from '../components/host/ShareLink';

// This display only shares a URL: no game subscriptions, joins, or reservations.
export default function PlayerQR() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const playerUrl = `${window.location.origin}/buzz/${encodeURIComponent(roomCode ?? '')}`;

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-4xl md:text-6xl font-black text-jeopardy-gold">Scan to join</h1>
      <p className="text-2xl md:text-4xl">Room <strong className="tracking-widest text-jeopardy-gold">{roomCode}</strong></p>
      <QRCodeSVG
        value={playerUrl}
        size={640}
        level="M"
        marginSize={4}
        title={`Scan to join room ${roomCode}`}
        className="max-w-full h-auto w-[min(65vh,640px)] flex-shrink-0"
      />
      <p className="text-xl md:text-2xl">Connect to the same Wi-Fi, then scan with your phone camera to join.</p>
      <div className="w-full max-w-4xl text-left">
        <ShareLink label="Player join URL" url={playerUrl} wrap />
      </div>
      <p className="text-gray-400 text-base max-w-3xl">Open this display using the host’s LAN address so phones can reach it. A localhost address only works on this device.</p>
    </main>
  );
}
