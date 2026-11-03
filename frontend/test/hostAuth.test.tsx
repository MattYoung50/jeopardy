import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostFetch } from '../src/lib/hostAuth';

test('creating a board without server authentication does not invoke a browser prompt', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  let requests = 0;
  Object.assign(globalThis, {
    window: { prompt: () => { throw new Error('prompt() is not supported.'); } },
    localStorage: { getItem: () => null },
    fetch: async (_input: string, init: RequestInit) => {
      requests++;
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify({ id: 'created', name: 'Test' }), { status: 201 });
    },
  });
  try {
    const response = await hostFetch('/api/boards', { method: 'POST', body: '{"name":"Test"}' });
    assert.equal(response.status, 201);
    assert.equal(requests, 1);
  } finally {
    Object.assign(globalThis, { fetch: originalFetch, window: originalWindow, localStorage: originalStorage });
  }
});

test('a protected server still prompts and retries with the host passcode', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  let requests = 0;
  let prompts = 0;
  Object.assign(globalThis, {
    window: { prompt: () => { prompts++; return 'test-only-passcode'; } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async (_input: string, init: RequestInit) => {
      requests++;
      if (requests === 1) return new Response(null, { status: 401 });
      assert.equal(new Headers(init.headers).get('X-Host-Passcode'), 'test-only-passcode');
      return new Response(null, { status: 201 });
    },
  });
  try {
    assert.equal((await hostFetch('/api/boards', { method: 'POST' })).status, 201);
    assert.equal(requests, 2);
    assert.equal(prompts, 1);
  } finally {
    Object.assign(globalThis, { fetch: originalFetch, window: originalWindow, localStorage: originalStorage });
  }
});
