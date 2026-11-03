// Desktop preview of the actual firmware HTML. All radio/Wi-Fi behavior is simulated.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const main = readFileSync(new URL('../src/main.cpp', import.meta.url), 'utf8');
const header = readFileSync(new URL('../include/portal.h', import.meta.url), 'utf8');
const raw = name => {
  const match = header.match(new RegExp(`${name} = R"HTML\\(([\\s\\S]*?)\\)HTML";`));
  if (!match) throw new Error(`Cannot find firmware HTML ${name}`);
  return match[1];
};
const home = main.split('void home() {')[1]?.split('void startPortal()')[0];
if (!home) throw new Error('Cannot find firmware home page');
const csrf = randomBytes(16).toString('hex');
const colors = ['blue', 'green', 'red', 'yellow'];
const networks = ['Game Night Wi-Fi', 'Home Network', 'Guest Wi-Fi', 'Test & "Quotes"'];
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const networkOptions = '<option value="">Choose a network</option>' + networks.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('');
// Read the current C++ page += expressions rather than maintaining another form.
function render(source) {
  return [...source.matchAll(/page \+= ([\s\S]*?);\r?\n/g)].map(([, expression]) =>
    expression.split(' + ').map(part => {
      if (part === 'csrf') return csrf;
      if (part === 'networkOptions') return networkOptions;
      if (part === 'PAGE_SCRIPT') return raw('PAGE_SCRIPT');
      if (part.startsWith('"') && part.endsWith('"')) return JSON.parse(part);
      throw new Error(`Unsupported firmware HTML expression: ${part}`);
    }).join(''),
  ).join('');
}
const formHtml = render(home);
let devices, savedAt, releasing, weakSignal;
function reset() {
  devices = colors.map(color => ({ color, online: true, seen: true, saved: false, released: false }));
  savedAt = null; releasing = false; weakSignal = false;
}
reset();
function status() {
  const now = Date.now();
  devices.forEach((device, index) => {
    device.seen = device.online;
    if (savedAt !== null && device.online && now - savedAt > index * (weakSignal ? 2500 : 800)) device.saved = true;
    device.released = releasing && device.saved && device.online;
  });
  return { allSaved: devices.every(device => device.saved), releasing, weakSignal, devices };
}
const previewControls = `<aside style="padding:16px;border:1px solid #6879ac;border-radius:8px;margin-bottom:24px;font-size:15px"><strong>Local preview · simulated buzzers</strong><p>No real Wi-Fi scan, connection, or network changes. Use a made-up home password.</p><details><summary>Test controls</summary><p>Turn Yellow off before saving to try a missing buzzer. Turn it back on and watch it catch up.</p><label style="display:flex;gap:10px;align-items:center"><input id="yellow-online" type="checkbox" style="width:auto;margin:0" checked>Yellow powered on</label><label style="display:flex;gap:10px;align-items:center;margin:12px 0"><input id="weak-signal" type="checkbox" style="width:auto;margin:0">Slow down delivery</label><button id="preview-reset" type="button">Start over</button><p id="preview-message" aria-live="polite"></p></details></aside>`;
const controlsScript = `<script>
async function simulate(values){const r=await fetch('/preview/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values,csrf:'${csrf}'})});if(!r.ok)throw Error('Preview control failed');}
const yellow=document.getElementById('yellow-online'), weak=document.getElementById('weak-signal');
yellow.onchange=()=>simulate({yellowOnline:yellow.checked});weak.onchange=()=>simulate({weakSignal:weak.checked});
document.getElementById('preview-reset').onclick=async()=>{await simulate({reset:true});location.href='/';};
fetch('/preview/state').then(r=>r.json()).then(s=>{yellow.checked=s.devices[3].online;weak.checked=s.weakSignal;});
</script>`;
function page(message = '') {
  return (raw('PAGE_START') + previewControls + (message ? `<p role="alert">${escape(message)}</p>` : '') + formHtml)
    .replace('</body>', controlsScript + '</body>');
}
function valid(fields) {
  const ssid = fields.get('hidden') || fields.get('ssid') || '';
  const pass = fields.get('password') || '', backend = fields.get('backend') || '';
  return ssid && Buffer.byteLength(ssid) <= 32 &&
    (!pass || (Buffer.byteLength(pass) >= 8 && Buffer.byteLength(pass) <= 63)) &&
    Buffer.byteLength(backend) <= 96 && /^wss?:\/\/[^\s/@?#]+\/hardware\/buzzers$/.test(backend) &&
    ![ssid, pass, backend].some(value => value.includes('\0'));
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  const json = value => send(200, 'application/json', JSON.stringify(value));
  const redirect = () => { res.writeHead(303, { Location: '/' }); res.end(); };
  const route = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET') {
    if (route === '/status') return json(status());
    if (route === '/preview/state') return json(status());
    if (route === '/favicon.ico') return send(204, 'text/plain', '');
    return send(200, 'text/html; charset=utf-8', page());
  }
  if (req.method !== 'POST') return send(405, 'text/plain', 'Method not allowed');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return send(413, 'text/plain', 'Request too large');
  }
  if (route === '/preview/control') {
    let values;
    try { values = JSON.parse(body); } catch { return send(400, 'text/plain', 'Invalid request'); }
    if (values.csrf !== csrf) return send(403, 'text/plain', 'Reload the preview');
    if (values.reset) reset();
    if (typeof values.yellowOnline === 'boolean') devices[3].online = values.yellowOnline;
    if (typeof values.weakSignal === 'boolean') weakSignal = values.weakSignal;
    return json(status());
  }
  const fields = new URLSearchParams(body);
  if (fields.get('csrf') !== csrf) return send(403, 'text/plain', 'Reload the setup page and try again.');
  if (route === '/settings') {
    if (releasing) return send(409, 'text/html; charset=utf-8', page('Setup has finished. Use Start over to try again.'));
    if (!valid(fields)) return send(400, 'text/html; charset=utf-8', page('Choose a Wi-Fi name, use an 8–63 character password (or leave empty for open Wi-Fi), and enter a server address such as ws://192.168.1.42:3001/hardware/buzzers.'));
    // Deliberately retain no submitted passwords or network/server addresses.
    devices.forEach(device => { device.saved = false; device.released = false; });
    savedAt = Date.now(); return redirect();
  }
  if (route === '/finish') {
    if (!status().allSaved || releasing) return send(409, 'text/html; charset=utf-8', page('Wait for all four buzzers to save their settings.'));
    releasing = true; return redirect();
  }
  send(404, 'text/plain', 'Not found');
});
server.listen(Number(process.env.PREVIEW_PORT || 4176), '127.0.0.1', () => {
  console.log(`Jeopardy setup preview: http://127.0.0.1:${server.address().port}`);
  console.log('Simulation only: no real Wi-Fi changes. Ctrl+C stops the preview.');
});
