import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { existsSync } from 'fs';
import { networkInterfaces } from 'os';
import { fileURLToPath } from 'url';
import boardsRouter from './routes/boards.js';
import mediaRouter from './routes/media.js';
import { registerSocketHandlers } from './socket/socketHandler.js';
import { CONTENT_TYPE_BY_EXT } from './mediaTypes.js';
import { attachHardwareBuzzers, readDeviceTokens } from './hardware/buzzers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const DATA_DIR = process.env.DATA_DIR ?? './data';
const hardwareTokens = readDeviceTokens();

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // The hardware handler owns non-Socket.IO upgrades, including rejecting unknown paths.
  destroyUpgrade: false,
});

attachHardwareBuzzers(httpServer, {
  tokens: hardwareTokens,
  onEvent: event => console.log('[hardware]', JSON.stringify(event)),
});
console.log(`[hardware] ${hardwareTokens ? 'Enabled at /hardware/buzzers' : 'Disabled: no device tokens configured'}`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve uploaded media files
const mediaPath = path.resolve(DATA_DIR, 'media');
app.use('/media', express.static(mediaPath, {
  index: false,
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream');
  },
}));

// API routes
app.use('/api/boards', boardsRouter);
app.use('/api/media', mediaRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: err.message });
});

registerSocketHandlers(io);

// Serve built React frontend in production (after `npm run build`)
const publicPath = path.resolve(__dirname, '../public');
if (existsSync(publicPath)) {
  app.use(express.static(publicPath));
  // SPA fallback — any non-API route returns index.html
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(publicPath, 'index.html'));
  });
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n>> Jeopardy server running`);
  console.log(`   Local:   http://localhost:${PORT}`);
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of (ifaces ?? [])) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`   Network: http://${iface.address}:${PORT}  <- share this on LAN`);
      }
    }
  }
  console.log(`   Data:    ${path.resolve(DATA_DIR)}\n`);
});
