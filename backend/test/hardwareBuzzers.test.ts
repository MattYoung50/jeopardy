import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Server as SocketServer } from 'socket.io';
import { io as connectBrowser, type Socket } from 'socket.io-client';
import WebSocket from 'ws';
import { attachHardwareBuzzers, readDeviceTokens, type DeviceId } from '../src/hardware/buzzers.js';
import { registerSocketHandlers } from '../src/socket/socketHandler.js';
import { SOCKET_EVENTS as E } from '../src/shared/socketEvents.js';

const tokens = {
  blue: 'b'.repeat(32), green: 'g'.repeat(32),
  red: 'r'.repeat(32), yellow: 'y'.repeat(32),
};

test('four authenticated devices connect, acknowledge presses, and disconnect', { timeout: 5000 }, async t => {
  const server = createServer();
  const events = new EventEmitter();
  const hardware = attachHardwareBuzzers(server, { tokens, onEvent: event => events.emit(event.type, event) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/hardware/buzzers`;
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await hardware.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  for (const deviceId of ['blue', 'green', 'red', 'yellow'] as const) {
    const client = new WebSocket(url, {
      headers: { 'X-Buzzer-Id': deviceId, Authorization: `Bearer ${tokens[deviceId]}` },
    });
    clients.push(client);
    const [ready] = await once(client, 'message');
    assert.equal(JSON.parse(ready.toString()).deviceId, deviceId);
    const receipt = once(client, 'message');
    client.send(JSON.stringify({ type: 'press', sequence: 1 }));
    const [data] = await receipt;
    assert.deepEqual(JSON.parse(data.toString()), {
      type: 'press:accepted', deviceId, sequence: 1,
      receivedAt: JSON.parse(data.toString()).receivedAt,
    });
    assert.equal(typeof JSON.parse(data.toString()).receivedAt, 'number');
  }
  assert.equal(hardware.getDevices().filter(d => d.connected).length, 4);
  const closed = once(clients[0], 'close');
  const disconnected = once(events, 'disconnected');
  clients[0].close();
  await closed;
  await disconnected;
  assert.equal(hardware.getDevices().find(d => d.deviceId === 'blue')?.connected, false);
});

async function fixture(t: TestContext, options: Parameters<typeof attachHardwareBuzzers>[1] = { tokens }) {
  const server = createServer((_req, res) => res.end('ok'));
  const io = new SocketServer(server, { destroyUpgrade: false });
  const events = new EventEmitter();
  const hardware = attachHardwareBuzzers(server, {
    ...options, onEvent: event => events.emit(event.type, event),
  });
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await hardware.close();
    await new Promise<void>(resolve => io.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const url = origin.replace('http:', 'ws:') + '/hardware/buzzers';
  const headers = (id: DeviceId) => ({ 'X-Buzzer-Id': id, Authorization: `Bearer ${tokens[id]}` });
  const raw = (clientUrl = url, clientHeaders: Record<string, string> = headers('blue'), autoPong = true) => {
    const client = new WebSocket(clientUrl, { headers: clientHeaders, autoPong });
    clients.push(client);
    return client;
  };
  const connect = async (id: DeviceId = 'blue', autoPong = true) => {
    const client = raw(url, headers(id), autoPong);
    const [data] = await once(client, 'message');
    assert.deepEqual(JSON.parse(data.toString()), { type: 'ready', deviceId: id });
    return client;
  };
  return { origin, url, io, events, hardware, raw, connect, headers };
}

function socketEvent(socket: Socket, event: string): Promise<any[]> {
  return new Promise(resolve => socket.once(event, (...args: any[]) => resolve(args)));
}

async function exchange(client: WebSocket, data: string | Buffer) {
  const response = once(client, 'message');
  client.send(data);
  const [message] = await response;
  return JSON.parse(message.toString());
}

async function rejected(client: WebSocket, status: number) {
  // Receiving an HTTP response instead of 101 is a failed upgrade, never a device connection.
  client.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => reject(new Error('Unexpected authenticated connection')));
    client.once('unexpected-response', (_req, res) => {
      try { assert.equal(res.statusCode, status); resolve(); } catch (error) { reject(error); }
      res.resume();
      client.terminate();
    });
  });
}

test('authentication rejects missing, wrong, cross-device, and unknown credentials', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const invalidHeaders: Record<string, string>[] = [
    {}, { 'X-Buzzer-Id': 'blue' },
    { 'X-Buzzer-Id': 'blue', Authorization: 'Bearer wrong' },
    { 'X-Buzzer-Id': 'green', Authorization: `Bearer ${tokens.blue}` },
    { 'X-Buzzer-Id': 'purple', Authorization: `Bearer ${tokens.blue}` },
  ];
  for (const headers of invalidHeaders) await rejected(f.raw(f.url, headers), 401);
  assert(f.hardware.getDevices().every(d => !d.connected && d.pressCount === 0));
});

test('unconfigured hardware is disabled while HTTP and Socket.IO remain available', { timeout: 5000 }, async t => {
  const f = await fixture(t, {});
  await rejected(f.raw(), 503);
  assert.equal(await (await fetch(f.origin)).text(), 'ok');
  const browser = connectBrowser(f.origin, { transports: ['websocket'], reconnection: false });
  t.after(() => browser.disconnect());
  await socketEvent(browser, 'connect');
  assert(browser.connected);
});

test('rejects unknown upgrade paths', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await rejected(f.raw(f.url + '/other'), 404);
});

test('duplicate identity cannot displace a device; reconnect resets sequence and retains totals', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const blue = await f.connect();
  await rejected(f.raw(), 409);
  assert.equal((await exchange(blue, '{"type":"press","sequence":5}')).type, 'press:accepted');
  const disconnected = once(f.events, 'disconnected');
  blue.close();
  await disconnected;
  const next = await f.connect();
  assert.equal((await exchange(next, '{"type":"press","sequence":1}')).type, 'press:accepted');
  const status = f.hardware.getDevices().find(d => d.deviceId === 'blue')!;
  assert.equal(status.pressCount, 2);
  assert(status.connected && status.connectedAt && status.disconnectedAt && status.lastPressAt);
  status.connected = false;
  assert.equal(f.hardware.getDevices()[0].connected, true, 'status snapshots cannot mutate device records');
});

test('validates text messages and rejects stale presses without counting them', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const blue = await f.connect();
  for (const payload of ['{', 'null', '[]', '{"type":"buzz","sequence":1}',
    '{"type":"press","sequence":0}', '{"type":"press","sequence":1.5}',
    '{"type":"press","sequence":1,"deviceId":"red"}', Buffer.from('binary')]) {
    assert.deepEqual(await exchange(blue, payload), { type: 'error', code: 'invalid_message' });
  }
  assert.equal(f.hardware.getDevices()[0].pressCount, 0);
});

test('replayed sequences are rejected and the next sequence is accepted', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const blue = await f.connect();
  assert.equal((await exchange(blue, '{"type":"press","sequence":2}')).type, 'press:accepted');
  for (const sequence of [2, 1]) {
    assert.deepEqual(await exchange(blue, JSON.stringify({ type: 'press', sequence })), {
      type: 'error', code: 'stale_sequence',
    });
  }
  assert.equal((await exchange(blue, '{"type":"press","sequence":3}')).type, 'press:accepted');
  assert.equal(f.hardware.getDevices()[0].pressCount, 2);
});

test('oversized messages close the device with 1009', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const blue = await f.connect();
  const closed = once(blue, 'close');
  blue.send('x'.repeat(513));
  assert.equal((await closed)[0], 1009);
  assert.equal(f.hardware.getDevices()[0].pressCount, 0);
});

test('excessive message rates close only the offending device with 1008', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const blue = await f.connect();
  const green = await f.connect('green');
  const closed = once(blue, 'close');
  for (let sequence = 1; sequence <= 11; sequence++) blue.send(JSON.stringify({ type: 'press', sequence }));
  assert.equal((await closed)[0], 1008);
  assert.equal(f.hardware.getDevices()[0].pressCount, 10);
  assert.equal((await exchange(green, '{"type":"press","sequence":1}')).deviceId, 'green');
});

test('heartbeat detects a dead device and permits a replacement connection', { timeout: 5000 }, async t => {
  const f = await fixture(t, { tokens, heartbeatMs: 20 });
  const disconnected = once(f.events, 'disconnected');
  await f.connect('blue', false);
  await disconnected;
  assert.equal(f.hardware.getDevices()[0].connected, false);
  const replacement = await f.connect();
  assert.equal((await exchange(replacement, '{"type":"press","sequence":1}')).type, 'press:accepted');
});

test('configuration is disabled by default and rejects partial, weak, or shared secrets', () => {
  assert.equal(readDeviceTokens({}), undefined);
  assert.throws(() => readDeviceTokens({ HARDWARE_BUZZER_BLUE_TOKEN: tokens.blue }));
  const env = Object.fromEntries(Object.entries(tokens).map(([id, token]) => [
    `HARDWARE_BUZZER_${id.toUpperCase()}_TOKEN`, token,
  ]));
  assert.deepEqual(readDeviceTokens(env), tokens);
  assert.throws(() => readDeviceTokens({ ...env, HARDWARE_BUZZER_BLUE_TOKEN: 'short' }));
  assert.throws(() => readDeviceTokens({ ...env, HARDWARE_BUZZER_BLUE_TOKEN: tokens.red }));
});

test('the Node simulator exercises all four devices and exits nonzero for bad credentials', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const env = { ...process.env, ...Object.fromEntries(Object.entries(tokens).map(([id, token]) => [
    `HARDWARE_BUZZER_${id.toUpperCase()}_TOKEN`, token,
  ])) };
  const script = fileURLToPath(new URL('../scripts/simulate-buzzers.mjs', import.meta.url));
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [script, f.url], { env, timeout: 7000 });
  assert.match(stdout, /PASS: all four devices acknowledged two presses each/);
  // Wait for all server-side disconnects from the simulator before reusing colors.
  const deadline = Date.now() + 1000;
  while (f.hardware.getDevices().some(d => d.connected) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(f.hardware.getDevices().every(d => !d.connected && d.pressCount === 2));
  await assert.rejects(run(process.execPath, [script, f.url], {
    env: { ...env, HARDWARE_BUZZER_BLUE_TOKEN: 'invalid' }, timeout: 7000,
  }), (error: any) => error.code === 1 && error.stderr.includes('401'));
});

test('hardware presses leave gameplay untouched and the browser buzzer still wins normally', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  registerSocketHandlers(f.io);
  const host = connectBrowser(f.origin, { transports: ['websocket'], reconnection: false });
  const player = connectBrowser(f.origin, { transports: ['polling', 'websocket'], reconnection: false });
  t.after(() => { host.disconnect(); player.disconnect(); });
  await Promise.all([socketEvent(host, 'connect'), socketEvent(player, 'connect')]);
  const created = socketEvent(host, E.HOST_CREATED);
  host.emit(E.HOST_CREATE, { boardId: 'hardware-regression-test' });
  const [{ roomCode }] = await created;
  const joined = socketEvent(player, E.PLAYER_JOINED);
  host.emit(E.HOST_SET_AUTO_LOCK, { roomCode, enabled: false });
  player.emit(E.PLAYER_JOIN, { roomCode, name: 'Browser player', color: '#123456' });
  const [{ player: registered }] = await joined;
  let updated = socketEvent(host, E.GAME_STATE);
  host.emit(E.HOST_OPEN_QUESTION, { roomCode, questionId: 'question', isDailyDouble: false });
  await updated;
  updated = socketEvent(host, E.GAME_STATE);
  host.emit(E.HOST_ENABLE_BUZZER, { roomCode });
  await updated;
  const stateBefore = socketEvent(host, E.GAME_STATE);
  host.emit(E.GET_STATE, { roomCode });
  const [before] = await stateBefore;
  const blue = await f.connect();
  await exchange(blue, '{"type":"press","sequence":1}');
  const stateAfter = socketEvent(host, E.GAME_STATE);
  host.emit(E.GET_STATE, { roomCode });
  assert.deepEqual((await stateAfter)[0], before);
  assert.equal(before.players.length, 1);
  const winner = socketEvent(host, E.BUZZ_WINNER);
  player.emit(E.BUZZ);
  assert.equal((await winner)[0].playerId, registered.id);
  const ended = socketEvent(host, E.GAME_ENDED);
  host.emit(E.HOST_END, { roomCode });
  await ended;
});

// Reservation ownership is independent of transport connectivity.
import * as gm from '../src/socket/gameManager.js';
import { getBuzzerAvailability, setDeviceOnline } from '../src/socket/gameManager/reservations.js';

test('physical reservations enforce exclusivity and survive disconnects until lifecycle release', async () => {
  const a = gm.createSession('reservation-test');
  const b = gm.createSession('reservation-test');
  try {
    assert.equal(gm.addPlayer(a.roomCode, 'Offline', '#fff', 'blue'), null);
    setDeviceOnline('blue', true);
    setDeviceOnline('green', true);
    const claims = await Promise.all([
      Promise.resolve().then(() => gm.addPlayer(a.roomCode, 'One', '#fff', 'blue')),
      Promise.resolve().then(() => gm.addPlayer(a.roomCode, 'Two', '#fff', 'blue')),
      Promise.resolve().then(() => gm.addPlayer(b.roomCode, 'Other room', '#fff', 'green')),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const owner = claims[0]!;
    assert.equal(owner.physicalColor, 'blue');
    assert(gm.addPlayer(b.roomCode, 'Browser only', '#fff'));
    setDeviceOnline('blue', false);
    assert.equal(owner.physicalColor, 'blue');
    assert.deepEqual(getBuzzerAvailability(a.roomCode).find(s => s.color === 'blue'), { color: 'blue', online: false, reserved: true });
    setDeviceOnline('blue', true);
    assert.equal(owner.physicalColor, 'blue');
    gm.removePlayer(a.roomCode, owner.id);
    assert(gm.addPlayer(b.roomCode, 'New owner', '#fff', 'blue'));
    gm.endGame(b.roomCode);
    assert(b.players.every(p => !p.physicalColor));
    assert(gm.addPlayer(a.roomCode, 'After end', '#fff', 'green'));
    gm.deleteSession(a.roomCode);
    gm.resumeGame(b.roomCode);
    assert(gm.addPlayer(b.roomCode, 'After deletion', '#fff', 'green'));
  } finally {
    gm.deleteSession(a.roomCode);
    gm.deleteSession(b.roomCode);
    setDeviceOnline('blue', false);
    setDeviceOnline('green', false);
  }
});

test('socket joins race safely, refresh stale claims, and rejoin preserves offline assignment', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  registerSocketHandlers(f.io);
  const room = gm.createSession('reservation-socket-test');
  const other = gm.createSession('reservation-socket-test');
  const clients = Array.from({ length: 3 }, () => connectBrowser(f.origin, { transports: ['websocket'], reconnection: false }));
  t.after(() => {
    for (const client of clients) client.disconnect();
    gm.deleteSession(room.roomCode);
    gm.deleteSession(other.roomCode);
    setDeviceOnline('blue', false);
    setDeviceOnline('green', false);
  });
  await Promise.all(clients.map(client => socketEvent(client, 'connect')));
  setDeviceOnline('blue', true);
  setDeviceOnline('green', true);
  const results = clients.map(client => new Promise<{ client: Socket; joined?: any; error?: string }>(resolve => {
    client.once(E.PLAYER_JOINED, joined => resolve({ client, joined }));
    client.once('error', error => resolve({ client, error: error.message }));
  }));
  const refreshed = socketEvent(clients[1], E.BUZZER_AVAILABILITY);
  clients[0].emit(E.PLAYER_JOIN, { roomCode: room.roomCode, name: 'First', color: '#fff', physicalColor: 'blue' });
  clients[1].emit(E.PLAYER_JOIN, { roomCode: room.roomCode, name: 'Second', color: '#fff', physicalColor: 'blue' });
  clients[2].emit(E.PLAYER_JOIN, { roomCode: other.roomCode, name: 'Third', color: '#fff', physicalColor: 'green' });
  const settled = await Promise.all(results);
  assert.equal(settled.filter(r => r.joined).length, 1);
  assert(settled.filter(r => r.error).every(r => /reserved|another game/.test(r.error!)));
  assert((await refreshed)[0].find((s: any) => s.color === 'blue').reserved);
  const winner = settled.find(r => r.joined)!;
  const playerId = winner.joined.player.id;
  winner.client.disconnect();
  setDeviceOnline('blue', false);
  // Use a fresh browser socket to restore the same persistent player.
  const replacement = connectBrowser(f.origin, { transports: ['websocket'], reconnection: false });
  clients.push(replacement);
  await socketEvent(replacement, 'connect');
  const rejoined = socketEvent(replacement, E.PLAYER_JOINED);
  replacement.emit(E.PLAYER_REJOIN, { roomCode: room.roomCode, playerId });
  assert.equal((await rejoined)[0].player.physicalColor, 'blue');
  assert.equal(room.players.length, 1);
  setDeviceOnline('blue', true);
  const hostJoined = socketEvent(replacement, E.GAME_STATE);
  replacement.emit(E.HOST_JOIN, { roomCode: room.roomCode });
  await hostJoined;
  const ended = socketEvent(replacement, E.GAME_ENDED);
  replacement.emit(E.HOST_END, { roomCode: room.roomCode });
  await ended;
  assert.equal(gm.getSession(room.roomCode), undefined);
  const nextJoin = socketEvent(clients[2], E.PLAYER_JOINED);
  clients[2].emit(E.PLAYER_JOIN, { roomCode: other.roomCode, name: 'After cancellation', color: '#fff', physicalColor: 'blue' });
  assert.equal((await nextJoin)[0].player.physicalColor, 'blue');
});
