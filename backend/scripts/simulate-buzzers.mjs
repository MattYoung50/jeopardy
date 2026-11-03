import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

const ids = ['blue', 'green', 'red', 'yellow'];
const url = process.argv[2] ?? 'ws://127.0.0.1:3001/hardware/buzzers';
const clients = [];

function message(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for a device receipt')), 5000);
    const onMessage = data => finish(undefined, data);
    const onError = error => finish(error);
    const onClose = () => finish(new Error('Connection closed before the expected receipt'));
    function finish(error, data) {
      clearTimeout(timer);
      client.off('message', onMessage);
      client.off('error', onError);
      client.off('close', onClose);
      if (error) reject(error); else resolve(data);
    }
    client.once('message', onMessage);
    client.once('error', onError);
    client.once('close', onClose);
  });
}

async function connect(id) {
  const token = process.env[`HARDWARE_BUZZER_${id.toUpperCase()}_TOKEN`];
  if (!token) throw new Error(`Missing token for ${id}; load the same environment as the server.`);
  const client = new WebSocket(url, {
    headers: { 'X-Buzzer-Id': id, Authorization: `Bearer ${token}` },
    handshakeTimeout: 5000,
  });
  clients.push(client);
  // Keep unexpected post-handshake socket errors observable without crashing the process.
  client.on('error', () => { process.exitCode = 1; });
  const ready = await message(client);
  assert.deepEqual(JSON.parse(ready.toString()), { type: 'ready', deviceId: id });
  console.log(`${id}: connected`);
  return client;
}

async function press(id, client, sequence) {
  const receipt = message(client);
  client.send(JSON.stringify({ type: 'press', sequence }));
  const result = JSON.parse((await receipt).toString());
  assert.equal(result.type, 'press:accepted');
  assert.equal(result.deviceId, id);
  assert.equal(result.sequence, sequence);
  assert.equal(typeof result.receivedAt, 'number');
  console.log(`${id}: press ${sequence} acknowledged at ${result.receivedAt}`);
}

try {
  for (const id of ids) {
    if (!process.env[`HARDWARE_BUZZER_${id.toUpperCase()}_TOKEN`]) throw new Error(`Missing token for ${id}`);
  }
  const connected = await Promise.all(ids.map(connect));
  await Promise.all(ids.map((id, i) => press(id, connected[i], 1)));
  await Promise.all(ids.map((id, i) => press(id, connected[i], 2)));
  console.log('PASS: all four devices acknowledged two presses each. Gameplay was not invoked.');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map(async client => {
    if (client.readyState !== WebSocket.OPEN) { client.terminate(); return; }
    const closed = once(client, 'close');
    client.close();
    const timer = setTimeout(() => client.terminate(), 1000);
    try { await closed; } finally { clearTimeout(timer); }
  }));
}
