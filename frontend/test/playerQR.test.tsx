import React, { act } from 'react';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import PlayerQR from '../src/pages/PlayerQR';
import ShareLink from '../src/components/host/ShareLink';

function setup(origin: string) {
  const dom = new JSDOM('<div id="root"></div>', { url: origin });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  return dom;
}

for (const [origin, room] of [
  ['http://192.168.68.63:5173', '9F52W'],
  ['https://game.example.com', 'ABCDE'],
  ['http://localhost:3001', '12345'],
  ['http://10.0.0.42:8088', 'ZX987'],
  ['http://[::1]:5173', 'ROOM2'],
]) {
  test(`display QR decodes to the player URL at ${origin} for ${room}`, async () => {
    const dom = setup(origin);
    const root = createRoot(document.getElementById('root')!);
    try {
      await act(async () => root.render(
        <MemoryRouter initialEntries={[`/qr/${room}`]}>
          <Routes><Route path="/qr/:roomCode" element={<PlayerQR />} /></Routes>
        </MemoryRouter>,
      ));
      const svg = document.querySelector('svg')!;
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // Decode the actual rendered QR independently of the encoder.
      const { data, width, height } = PNG.sync.read(new Resvg(svg.outerHTML).render().asPng());
      const decoded = jsQR(new Uint8ClampedArray(data), width, height);
      assert.equal(decoded?.data, `${origin}/buzz/${room}`);
      assert.ok(document.body.textContent?.includes(`${origin}/buzz/${room}`));
      assert.ok(document.body.textContent?.includes('same Wi-Fi'));
      assert.ok(document.body.textContent?.includes(room));
      // It works directly, even for a nonexistent/closed room, without server data.
      assert.equal(document.querySelectorAll('button').length, 1);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}

test('sharing offers the QR display URL and copies on an HTTP LAN origin', async () => {
  const dom = setup('http://192.168.1.5:5173');
  const root = createRoot(document.getElementById('root')!);
  const url = 'http://192.168.1.5:5173/qr/ABCDE';
  let copied = '';
  Object.defineProperty(document, 'execCommand', { value: (command: string) => {
    assert.equal(command, 'copy');
    copied = document.querySelector('textarea')!.value;
    return true;
  } });
  try {
    await act(async () => root.render(<ShareLink label="Player QR code" url={url} open />));
    assert.equal(document.querySelector('a')?.href, url);
    assert.equal(document.querySelector('a')?.target, '_blank');
    await act(async () => document.querySelector('button')!.click());
    assert.equal(copied, url);
    assert.equal(document.querySelector('textarea'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
