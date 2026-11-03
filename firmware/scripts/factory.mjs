import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// Supply actual STA MAC addresses printed by the serial boot log, in color order.
const colors = ['blue', 'green', 'red', 'yellow'];
const macs = process.argv.slice(2);
if (macs.length !== 4 || macs.some(mac => !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) ||
    new Set(macs.map(mac => mac.toLowerCase())).size !== 4 ||
    macs.some(mac => (parseInt(mac.slice(0, 2), 16) & 1) || /^00(?::00){5}$/.test(mac))) {
  throw new Error('Usage: node scripts/factory.mjs <blue-STA-MAC> <green-STA-MAC> <red-STA-MAC> <yellow-STA-MAC> (unique unicast addresses)');
}
const secret = () => randomBytes(16).toString('hex');
const devices = Object.fromEntries(colors.map((color, i) => [color, {
  mac: macs[i].toLowerCase(), token: randomBytes(32).toString('hex'), pmk: secret(),
  ...(i ? { lmk: secret() } : {}),
}]));
writeFileSync('factory.local.json', JSON.stringify({
  apPassword: secret(), devices,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created factory.local.json. Keep this file private; it contains the setup Wi-Fi password and four distinct backend tokens.');
