import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export const DEVICE_IDS = ['blue', 'green', 'red', 'yellow'] as const;
export type DeviceId = typeof DEVICE_IDS[number];
export type DeviceTokens = Record<DeviceId, string>;
export const HARDWARE_PATH = '/hardware/buzzers';

export interface DeviceStatus {
  deviceId: DeviceId;
  connected: boolean;
  connectedAt: number | null;
  disconnectedAt: number | null;
  lastPressAt: number | null;
  pressCount: number;
}

export type HardwareEvent =
  | { type: 'connected' | 'disconnected'; deviceId: DeviceId; at: number }
  | { type: 'press'; deviceId: DeviceId; sequence: number; at: number };

export function readDeviceTokens(env: NodeJS.ProcessEnv = process.env): DeviceTokens | undefined {
  const values = DEVICE_IDS.map(id => env[`HARDWARE_BUZZER_${id.toUpperCase()}_TOKEN`]);
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => !value || !/^[\x21-\x7e]{32,256}$/.test(value)) || new Set(values).size !== 4) {
    throw new Error('Configure all four HARDWARE_BUZZER_<COLOR>_TOKEN values with distinct 32–256 character printable, non-space secrets.');
  }
  return Object.fromEntries(DEVICE_IDS.map((id, i) => [id, values[i]])) as DeviceTokens;
}

function isDeviceId(value: unknown): value is DeviceId {
  return typeof value === 'string' && DEVICE_IDS.includes(value as DeviceId);
}

function sameSecret(actual: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

/** Independent device transport. It neither imports nor mutates game/player state. */
export function attachHardwareBuzzers(server: Server, options: {
  tokens?: DeviceTokens;
  onEvent?: (event: HardwareEvent) => void;
  heartbeatMs?: number;
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });
  const connections = new Map<DeviceId, WebSocket>();
  const statuses = new Map<DeviceId, DeviceStatus>(DEVICE_IDS.map(deviceId => [deviceId, {
    deviceId, connected: false, connectedAt: null, disconnectedAt: null,
    lastPressAt: null, pressCount: 0,
  }]));
  const alive = new Set<WebSocket>();
  let closed = false;

  function reject(socket: Duplex, status: string) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Socket.IO owns its own upgrade path. Close other unhandled upgrades.
    socket.on('error', () => {});
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname.startsWith('/socket.io/')) return;
    if (pathname !== HARDWARE_PATH) return reject(socket, '404 Not Found');
    if (closed || !options.tokens) return reject(socket, '503 Service Unavailable');
    const deviceId = req.headers['x-buzzer-id'];
    const auth = req.headers.authorization;
    if (!isDeviceId(deviceId) || !auth?.startsWith('Bearer ') ||
        !sameSecret(auth.slice(7), options.tokens[deviceId])) {
      return reject(socket, '401 Unauthorized');
    }
    if (connections.has(deviceId)) return reject(socket, '409 Conflict');
    wss.handleUpgrade(req, socket, head, ws => {
      connections.set(deviceId, ws);
      alive.add(ws);
      const status = statuses.get(deviceId)!;
      const now = Date.now();
      status.connected = true;
      status.connectedAt = now;
      let sequence = 0;
      let windowStart = now;
      let messageCount = 0;
      ws.on('error', () => {}); // ws reports malformed/oversized frames here before closing.
      ws.on('pong', () => alive.add(ws));
      ws.on('close', () => {
        alive.delete(ws);
        if (connections.get(deviceId) !== ws) return;
        connections.delete(deviceId);
        status.connected = false;
        status.disconnectedAt = Date.now();
        options.onEvent?.({ type: 'disconnected', deviceId, at: status.disconnectedAt });
      });
      ws.on('message', (data, binary) => {
        const receivedAt = Date.now();
        if (receivedAt - windowStart >= 1000) { windowStart = receivedAt; messageCount = 0; }
        if (++messageCount > 10) { ws.close(1008, 'Rate limit exceeded'); return; }
        const error = (code: string) => ws.send(JSON.stringify({ type: 'error', code }));
        let message: unknown;
        try { message = binary ? null : JSON.parse(data.toString()); }
        catch { error('invalid_message'); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          error('invalid_message'); return;
        }
        const press = message as Record<string, unknown>;
        if (Object.keys(press).length !== 2 || press.type !== 'press' ||
            !Number.isSafeInteger(press.sequence) || (press.sequence as number) < 1) {
          error('invalid_message'); return;
        }
        if ((press.sequence as number) <= sequence) { error('stale_sequence'); return; }
        sequence = press.sequence as number;
        status.lastPressAt = receivedAt;
        status.pressCount++;
        ws.send(JSON.stringify({ type: 'press:accepted', deviceId, sequence, receivedAt }));
        options.onEvent?.({ type: 'press', deviceId, sequence, at: receivedAt });
      });
      ws.send(JSON.stringify({ type: 'ready', deviceId }));
      options.onEvent?.({ type: 'connected', deviceId, at: now });
    });
  }

  server.on('upgrade', upgrade);
  const heartbeat = setInterval(() => {
    for (const ws of connections.values()) {
      if (!alive.delete(ws)) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, options.heartbeatMs ?? 15000);
  heartbeat.unref();

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    clearInterval(heartbeat);
    server.off('upgrade', upgrade);
    server.off('close', onServerClose);
    closing = new Promise(resolve => {
      for (const ws of connections.values()) ws.terminate();
      wss.close(() => resolve());
    });
    return closing;
  }
  function onServerClose() { void close(); }
  server.once('close', onServerClose);
  return {
    getDevices: (): DeviceStatus[] => [...statuses.values()].map(status => ({ ...status })),
    close,
  };
}
