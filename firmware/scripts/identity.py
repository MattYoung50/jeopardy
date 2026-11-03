Import('env')
import json
import os
import pathlib
import re

root = pathlib.Path(env['PROJECT_DIR'])
path = pathlib.Path(os.environ.get('FIRMWARE_FACTORY_FILE', str(root / 'factory.local.json')))
if not path.exists():
    raise RuntimeError('Generate firmware/factory.local.json first; see docs/firmware-setup.md')
factory = json.loads(path.read_text())
colors = ['blue', 'green', 'red', 'yellow']
color = env['PIOENV']
devices = factory['devices']
def require(condition, message):
    if not condition:
        raise RuntimeError(message)
require(color in colors, 'Unknown fixed device color')
for name in colors:
    require(re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', devices[name]['mac']), 'Invalid STA MAC')
    mac = bytes.fromhex(devices[name]['mac'].replace(':', ''))
    require(any(mac) and not (mac[0] & 1), 'STA MAC must be nonzero unicast')
    require(re.fullmatch(r'[0-9a-f]{64}', devices[name]['token']), 'Expected generated 256-bit backend token')
    require(re.fullmatch(r'[0-9a-f]{32}', devices[name]['pmk']), 'Expected generated PMK')
    if name != 'blue':
        require(re.fullmatch(r'[0-9a-f]{32}', devices[name]['lmk']), 'Expected generated pairwise LMK')
require(len({devices[c]['token'] for c in colors}) == 4, 'Backend tokens must be distinct')
require(len({devices[c]['mac'].lower() for c in colors}) == 4, 'STA MACs must be distinct')
require(len({devices[c]['lmk'] for c in colors[1:]}) == 3, 'Pairwise LMKs must be distinct')
for key in ['apPassword', 'webPassword']:
    require(re.fullmatch(r'[0-9a-f]{32}', factory[key]), 'Expected generated setup passwords')
def array(hex_string):
    return '{' + ','.join('0x' + hex_string[i:i+2] for i in range(0, len(hex_string), 2)) + '}'
peers = colors[1:] if color == 'blue' else ['blue']
lines = ['#pragma once', '#include <stdint.h>',
         'constexpr uint8_t DEVICE_INDEX = %d;' % colors.index(color),
         'constexpr const char* DEVICE_COLOR = %s;' % json.dumps(color),
         'constexpr const char* DEVICE_TOKEN = %s;' % json.dumps(devices[color]['token']),
         'constexpr uint8_t LOCAL_MAC[6] = %s;' % array(devices[color]['mac'].replace(':', '')),
         'constexpr uint8_t PMK[16] = %s;' % array(devices[color]['pmk']),
         'struct FactoryPeer { uint8_t id; uint8_t mac[6]; uint8_t key[16]; };',
         'constexpr FactoryPeer PEERS[] = {']
for peer in peers:
    key = devices[peer if color == 'blue' else color]['lmk']
    lines.append('{%d,%s,%s},' % (colors.index(peer), array(devices[peer]['mac'].replace(':', '')), array(key)))
lines.append('};')
if color == 'blue':
    lines += ['constexpr const char* AP_PASSWORD = %s;' % json.dumps(factory['apPassword']),
              'constexpr const char* WEB_PASSWORD = %s;' % json.dumps(factory['webPassword'])]
else:
    lines += ['constexpr const char* AP_PASSWORD = "";', 'constexpr const char* WEB_PASSWORD = "";']
out = root / '.generated' / color
out.mkdir(parents=True, exist_ok=True)
(out / 'identity.h').write_text('\n'.join(lines) + '\n')
env.Append(CPPPATH=[str(out)])
