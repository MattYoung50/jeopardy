# Shared buzzer Wi-Fi setup (issue #16)

## Try the setup page without boards

From the repo root, run `npm run preview:setup` and open
[the local preview](http://127.0.0.1:4176). It opens directly to the setup form.
Choose any sample Wi-Fi, enter a made-up password of at least
eight characters, and use `ws://192.168.1.42:3001/hardware/buzzers` as the sample
server address. Save, watch all four statuses, and Finish.

The Test controls panel lets you turn Yellow off before saving, turn it back on
to receive settings, slow delivery, or start over. It serves the actual firmware
HTML and page script, with simulated HTTP responses and buzzer progress. It does
not scan/connect Wi-Fi, send settings to physical devices, retain submitted
passwords, or verify the firmware radio/storage implementation. The separate
desktop harness below exercises that shared protocol implementation. The server
listens only on this computer, and Ctrl+C stops it. No extra dependencies needed.

## What you do

1. On each buzzer, hold its button while turning it on/resetting it. Keep holding
   for **five continuous seconds**. New or partially configured boards enter setup
   automatically. Only Blue creates a Wi-Fi network; keep all four nearby.
2. On a phone, join **Jeopardy Buzzer Setup** using the setup Wi-Fi password from
   the private factory file (`apPassword`). A setup page should pop up. If the
   phone does not open it, stay on this network despite its “no Internet” warning
   and open **http://192.168.4.1**. Captive popup behavior depends on the phone OS;
   HTTPS sites cannot be redirected to this HTTP setup page.
3. Select your home Wi-Fi from the dropdown and enter its password. A hidden network can be typed manually.
   Blue scans once on startup; restart Blue in setup mode to refresh the list.
   Only 2.4 GHz networks work with these boards. Home passwords may be 8–63 bytes;
   an empty password means an open network. Enterprise Wi-Fi is not supported.
4. Enter the Jeopardy backend address once, for example
   `ws://192.168.1.42:3001/hardware/buzzers` (use your computer's actual LAN address).
   `wss://` is accepted for a TLS backend. The complete address is limited to 96
   bytes. Credentials must not be put in the URL.
5. Tap **Save to all four buzzers**. Blue, Green, Red and Yellow each show whether
   they are waiting, receiving, or have saved their settings. If one is missing,
   put it into setup mode; Blue keeps retrying without re-entering the settings.
6. Once all four show **Settings saved**, tap **Finish and join home Wi-Fi**.
   Leave power on for 30 seconds, then reconnect the phone to the home network.
   Each buzzer joins independently and retains its settings across restarts.

“Settings saved” confirms storage, not that the Wi-Fi password or backend address
is reachable. If you entered a wrong password/address, repeat the five-second
startup hold on all four and save the corrected values. Restarting normally does
not erase settings. There is no battery behavior or gameplay relay in this work.
Basic press/WebSocket firmware follows in #17; this version joins Wi-Fi but does
not yet open a backend connection or send presses.

## Build and flash

Use Python 3.11+, Node.js 20.6+ and PlatformIO Core **6.1.18**. From the repo root:

```powershell
py -m venv .venv-firmware
.venv-firmware/Scripts/python.exe -m pip install platformio==6.1.18
```

On macOS/Linux use `python3` and `.venv-firmware/bin/python` instead. The board,
Arduino framework, RISC-V compiler and build/uploader versions are pinned in
`firmware/platformio.ini`; no third-party Arduino libraries are required.

Before flashing, confirm the physical button wiring. `BUTTON_GPIO=3` (D1) is a
**provisional development placeholder**, active-low with `INPUT_PULLUP` and a
button to GND. Change the build flag to the confirmed GPIO before connecting
assembled boards. **A0/GPIO2 is reserved for battery sensing, not the button.**
No battery thresholds, cutoff, sensing circuit, or wake source are assumed.

1. Record each board's **station (STA) MAC**, and assign its permanent color.
   Read the factory MAC over USB with the ROM tool; this does not require existing
   firmware. Install the pinned packages first, then repeat `read_mac` for each
   board, replacing `COM7` with its actual port:

   ```powershell
   cd firmware
   ../.venv-firmware/Scripts/pio.exe pkg install
   ../.venv-firmware/Scripts/pio.exe pkg exec --package tool-esptoolpy -- esptool.py --chip esp32c3 --port COM7 read_mac
   ```

   Use the reported factory Wi-Fi MAC, not Blue's SoftAP MAC. If USB does not
   enumerate, follow Seeed's bootloader procedure for this board.
2. Still in `firmware/`, create the private factory file, giving the actual MACs
   in **Blue, Green, Red, Yellow** order:

   ```powershell
   node scripts/factory.mjs <blue-mac> <green-mac> <red-mac> <yellow-mac>
   ```

   Angle-bracket arguments above are placeholders, not literal PowerShell syntax.
   This writes git-ignored `factory.local.json` and refuses to overwrite it. Keep
   this file private and backed up. It contains the setup Wi-Fi password, four different
   backend tokens, separate PMKs and three pairwise ESP-NOW keys. Do not regenerate
   it for just one board: matching peers must be reflashed if pairing keys change.
3. Copy each device's `token` from the private file into its matching backend
   `HARDWARE_BUZZER_<COLOR>_TOKEN` environment variable. Never give all four one
   token. See [backend setup](hardware-buzzers.md).
4. Build all four images and flash each matching physical board:

   ```powershell
   ../.venv-firmware/Scripts/pio.exe run
   ../.venv-firmware/Scripts/pio.exe run -e blue -t upload --upload-port COM7
   ../.venv-firmware/Scripts/pio.exe device monitor --port COM7 --baud 115200
   ```

   Repeat upload with `green`, `red`, `yellow` and their ports. The boot log prints
   color, STA MAC and provisional GPIO, never passwords or tokens. A mismatched
   factory MAC stops startup rather than silently installing the wrong identity.
   Each image's generated header has only its own backend token. Blue has three
   peer keys, each other image has only its Blue pairing key. Generated headers
   and firmware binaries contain secrets and are git-ignored.

## Setup protocol and recovery

All setup traffic stays on channel **1** until settings are durably acknowledged
by every board and the operator taps Finish. Blue uses its AP for the phone and
its STA interface for encrypted ESP-NOW unicast. There is no broadcast of settings.
Peers are pre-paired by actual STA MAC with different 128-bit LMKs; a truncated
128-bit HMAC-SHA256 also authenticates every application packet, including the
fresh per-boot receiver nonce. Unknown MACs, wrong tags and obsolete boot nonces
are rejected. Device backend tokens never travel through the setup page or radio.

Blue saves first, then resends Prepare every 500 ms until each peer confirms its
NVS write and read-back. Receipts bind to the receiver's current boot nonce and
the configuration transaction. A failed write produces no receipt. NVS stores one
record (settings, transaction, staged flag), so an interrupted update cannot mix
fields. A staged record survives reboot and stays in setup; Blue can resume after
its own restart. The desktop harness uses actual files at this storage boundary.

Finish is disabled until all four receipts arrive. Blue persists release, repeats
the authenticated Release every 500 ms to unacknowledged peers. Blue stays on the
setup channel for at least 15 seconds and until all release receipts arrive.
Peers save release before acknowledging it and wait 15
seconds after their first Release before joining home Wi-Fi. Release duplicates
do not restart the timer. This leaves time for retries before changing channels.

Radio delivery can fail indefinitely. Blue keeps its setup page available and retries while a device has not confirmed
Release. If that device briefly loses reception, delivery resumes when it returns.
A permanently lost receipt after a peer has already left, or a power loss between
Finish and delivery, can still leave a partial group.
Recovery is to hold startup buttons on all four again, connect to Blue, and finish
the saved configuration again (or save corrected settings). No device switches
channels merely because a timeout expired while waiting for its settings. Home
Wi-Fi failure retries every 10 seconds without clearing saved settings.

The factory secrets and settings are stored in ordinary firmware/NVS on developer
boards, without flash encryption or secure boot. Setup radio traffic is encrypted;
this is not protection against reading a board's flash physically. The HTTP portal
is accessible on the password-protected setup AP only; it opens directly to the form without a page login, and uses CSRF tokens and
no-store responses. The page login was removed at Matt's request after previewing
the initial implementation; this supersedes the original issue wording.

## Repeatable automated verification

From the root, run:

```powershell
npm run test:firmware
```

The desktop harness compiles the same `provisioning.h` used by all board images.
Windows requires Visual Studio C++ Build Tools; Linux/macOS require a C++17 compiler
(`CXX` can select it). It substitutes only radio, time and persistent storage.
It verifies an offline fourth board blocks Finish; dropped configuration packets,
receipts and Release messages recover by retry (including an 18-second outage
after Finish); failed writes do not acknowledge;
Blue and peer restarts reload saved settings; staged peers do not leave setup;
completed peers restart onto their home Wi-Fi; and stale nonces/transactions and
invalid backend URLs do not bypass the channel barrier. Temporary files and the
test executable stay under git-ignored `firmware/.pio/harness`.

Build all four PlatformIO environments as well: the desktop harness does not
exercise ESP-NOW encryption, NVS power-loss atomicity, RF/channel behavior, the
phone captive popup, HTTP handlers, or electrical wiring. For compile-only CI,
`FIRMWARE_FACTORY_FILE` can point to a separately generated fixture with synthetic
MACs. Never flash fixture images to physical boards.

## Physical verification procedure (not yet executed)

Use USB power and confirmed development button wiring; assembled battery testing
waits for #11/#18. Record date, image commit, board MAC/color, GPIO and phone OS.

1. Verify wrong setup AP password fails, the correct password connects, and the
   setup page automatically appears on the intended phones. Check the manual IP
   fallback. Confirm the form opens directly with no page password prompt.
2. Verify holding fewer than five seconds does not request setup on a configured
   board; a continuous five-second hold does. Check each fixed color in its log.
3. Confirm nearby home SSIDs appear in the dropdown; test an SSID containing `&`
   or quotes, and a hidden SSID. Enter the real home Wi-Fi and backend once.
4. Leave Yellow off. Save and verify only three show saved and Finish is disabled.
   Start Yellow in setup; it should receive the same settings without another form
   submission, and all four should show saved. Power-cycle Red before finishing;
   it must return to setup and acknowledge its persisted configuration again.
5. Finish. Keep all powered for 30 seconds. Check your router shows four separate
   STA MACs on the home network (preferably set its channel to 6 or 11 to verify
   an actual channel change). The Blue setup SSID should disappear. Power-cycle
   every board normally and confirm all four rejoin without re-entering settings.
6. Enter an intentionally wrong home password, verify no silent erase or false
   success claim, then use startup setup to correct it. Interrupt power during a
   save and during Finish; recover the group with the documented procedure.
7. Verify each build's own backend token matches the distinct backend variable.
   Backend authentication and presses require #17; do not claim them from this
   setup-only image. Blue is never a gameplay relay.

Do not mark physical verification passed merely because compilation/tests pass.

## Primary references

- [PlatformIO XIAO ESP32-C3 board configuration](https://docs.platformio.org/en/stable/boards/espressif32/seeed_xiao_esp32c3.html)
- [Espressif ESP-NOW encrypted peers and channel requirements](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32c3/api-reference/network/esp_now.html)
