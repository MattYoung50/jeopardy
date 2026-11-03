#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include "identity.h"
#include "provisioning.h"
#include "portal.h"

using namespace provisioning;
#ifndef BUTTON_GPIO
#error Configure a provisional active-low BUTTON_GPIO
#endif
static_assert(BUTTON_GPIO != 2, "A0/GPIO2 is battery sensing, not the button");

struct NvsStorage : Storage {
  Preferences preferences;
  bool opened = false;
  bool read(Saved& saved) override {
    return opened && preferences.getBytesLength("settings") == sizeof saved &&
           preferences.getBytes("settings", &saved, sizeof saved) == sizeof saved;
  }
  bool write(const Saved& saved) override {
    if (!opened || preferences.putBytes("settings", &saved, sizeof saved) != sizeof saved) return false;
    Saved check{};
    return read(check) && !memcmp(&saved, &check, sizeof saved);
  }
} storage;

// Authentication in addition to encrypted unicast: reject any plaintext injection
// spoofing a registered MAC. The tag covers the whole packet, including boot nonce.
struct Wire { Packet packet; uint8_t tag[16]; };
static_assert(sizeof(Wire) <= 250, "Fits ESP-NOW v1");
struct Received { uint8_t peer; Wire wire; };
QueueHandle_t incoming;
uint64_t random64() { return (uint64_t(esp_random()) << 32) | esp_random() | 1; }
bool tag(const Packet& packet, const uint8_t* key, uint8_t* output) {
  uint8_t full[32];
  if (mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 16,
      reinterpret_cast<const uint8_t*>(&packet), sizeof packet, full)) return false;
  memcpy(output, full, 16);
  return true;
}
bool equalBytes(const uint8_t* a, const uint8_t* b, size_t length) {
  uint8_t difference = 0;
  for (size_t i = 0; i < length; ++i) difference |= a[i] ^ b[i];
  return difference == 0;
}
const FactoryPeer* findPeer(uint8_t id) {
  for (auto& peer : PEERS) if (peer.id == id) return &peer;
  return nullptr;
}
struct EspRadio : Radio {
  void send(uint8_t destination, const Packet& packet) override {
    auto peer = findPeer(destination);
    if (!peer) return;
    Wire wire{}; wire.packet = packet;
    if (tag(wire.packet, peer->key, wire.tag))
      esp_now_send(peer->mac, reinterpret_cast<const uint8_t*>(&wire), sizeof wire);
    // MAC delivery callbacks are not durable receipts. Setup retries until SavedAck.
  }
} radio;
Setup* provision = nullptr;
WebServer web(80);
DNSServer dns;
String csrf;
String networkOptions;
bool setupMode = false;
bool joined = false;
uint32_t lastWifiAttempt = 0;

String escape(const String& text) {
  String out;
  for (size_t i = 0; i < text.length(); ++i) {
    switch (text[i]) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out += text[i];
    }
  }
  return out;
}
String randomString() {
  char value[33];
  snprintf(value, sizeof value, "%08lx%08lx%08lx%08lx", (unsigned long)esp_random(),
    (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random());
  return String(value);
}
void noCache() { web.sendHeader("Cache-Control", "no-store"); web.sendHeader("X-Content-Type-Options", "nosniff"); }
bool authorizedPost() {
  if (web.arg("csrf") != csrf) {
    noCache(); web.send(403, "text/plain", "Reload the setup page and try again."); return false;
  }
  return true;
}
void redirectHome() {
  noCache(); web.sendHeader("Location", "http://192.168.4.1/"); web.send(302, "text/plain", "Open Jeopardy Buzzer Setup");
}
void home() {
  noCache();
  String page = PAGE_START;
  page += "<p>Put all four buzzers in setup mode. Choose your home Wi-Fi and enter its password once.</p><form method='post' action='/settings'><input type='hidden' name='csrf' value='" + csrf + "'><label>Home Wi-Fi<select name='ssid'>" + networkOptions + "</select></label>";
  page += "<small>If your network is missing, restart Blue to scan again. Hidden networks can be entered below.</small><label>Hidden network name (optional)<input name='hidden' maxlength='32'></label><label>Home Wi-Fi password<input name='password' type='password' maxlength='63' autocomplete='new-password'></label>";
  page += "<label>Jeopardy server address<input name='backend' placeholder='ws://192.168.1.42:3001/hardware/buzzers' maxlength='96' required></label><small>Use the backend computer's address, not this setup page. Device credentials are already installed separately.</small><button id='save'>Save to all four buzzers</button></form>";
  page += "<ul><li id='blue'>Blue</li><li id='green'>Green</li><li id='red'>Red</li><li id='yellow'>Yellow</li></ul><p id='message'>Wait for all four to show Settings saved, then finish.</p><form method='post' action='/finish'><input type='hidden' name='csrf' value='" + csrf + "'><button id='finish' disabled>Finish and join home Wi-Fi</button></form>";
  page += PAGE_SCRIPT;
  web.send(200, "text/html; charset=utf-8", page);
}
void startPortal() {
  csrf = randomString();
  web.on("/", HTTP_GET, home);
  web.on("/settings", HTTP_POST, [] {
    if (!authorizedPost()) return;
    Settings s{};
    String ssid = web.arg("hidden").length() ? web.arg("hidden") : web.arg("ssid");
    String password = web.arg("password"), backend = web.arg("backend");
    if (ssid.length() > 32 || password.length() > 63 || backend.length() > 96) {
      web.send(400, "text/plain", "A field is too long."); return;
    }
    ssid.toCharArray(s.ssid, sizeof s.ssid); password.toCharArray(s.password, sizeof s.password);
    backend.toCharArray(s.backend, sizeof s.backend);
    if (!valid(s)) { web.send(400, "text/plain", "Enter a Wi-Fi name, an 8-63 character password (or empty for open Wi-Fi), and ws://host:port/hardware/buzzers or wss://host/hardware/buzzers."); return; }
    if (!provision->configure(s, random64())) { web.send(409, "text/plain", "Could not save, or finishing is already in progress. Restart in setup mode to try again."); return; }
    redirectHome();
  });
  web.on("/status", HTTP_GET, [] {
    noCache();
    String json = "{\"allSaved\":" + String(provision->allSaved() ? "true" : "false") +
      ",\"releasing\":" + String(provision->releasing() ? "true" : "false") + ",\"devices\":[";
    for (uint8_t i = 0; i < 4; ++i) {
      auto p = provision->progress(i);
      if (i) json += ',';
      json += "{\"color\":\"" + String(COLORS[i]) + "\",\"seen\":" + String(p.seen ? "true" : "false") +
        ",\"saved\":" + String(p.saved ? "true" : "false") + ",\"released\":" + String(p.released ? "true" : "false") + "}";
    }
    web.send(200, "application/json", json + "]}");
  });
  web.on("/finish", HTTP_POST, [] {
    if (!authorizedPost()) return;
    if (!provision->finish(millis())) { web.send(409, "text/plain", "Wait for all four buzzers to save their settings."); return; }
    redirectHome();
  });
  web.onNotFound(redirectHome); // Android, Apple and Windows captive-portal probes.
  dns.start(53, "*", WiFi.softAPIP());
  web.begin();
}

void receive(const uint8_t* mac, const uint8_t* bytes, int length) {
  if (length != sizeof(Wire)) return;
  for (auto& peer : PEERS) {
    if (memcmp(mac, peer.mac, 6)) continue;
    Received item{}; item.peer = peer.id; memcpy(&item.wire, bytes, sizeof item.wire);
    xQueueSend(incoming, &item, 0);
    return;
  }
}
void fatal(const char* message) { Serial.println(message); while (true) delay(1000); }
bool startupHold() {
  if (digitalRead(BUTTON_GPIO) != LOW) return false;
  uint32_t start = millis();
  while (uint32_t(millis() - start) < 5000) {
    if (digitalRead(BUTTON_GPIO) != LOW) return false;
    delay(10);
  }
  return true;
}
void joinHome() {
  if (setupMode) {
    if (DEVICE_INDEX == 0) { dns.stop(); web.stop(); WiFi.softAPdisconnect(true); }
    esp_now_deinit();
    setupMode = false;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(provision->settings().ssid, provision->settings().password);
  lastWifiAttempt = millis();
  joined = true;
  Serial.println("Joining saved home Wi-Fi directly. Gameplay transport follows in issue #17.");
}
void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_GPIO, INPUT_PULLUP);
  bool requested = startupHold();
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  Serial.printf("%s STA MAC: %s; provisional active-low button GPIO %d\n", DEVICE_COLOR, WiFi.macAddress().c_str(), BUTTON_GPIO);
  uint8_t actual[6]; WiFi.macAddress(actual);
  if (memcmp(actual, LOCAL_MAC, 6)) fatal("Factory STA MAC does not match this board. Generate identities using actual board addresses.");
  storage.opened = storage.preferences.begin("buzzer", false);
  provision = new Setup(DEVICE_INDEX, random64(), storage, radio);
  if (!requested && !provision->needsSetup()) { joinHome(); return; }
  setupMode = true;
  // Scan BEFORE starting ESP-NOW; scans hop channels and would interrupt delivery.
  if (DEVICE_INDEX == 0) {
    networkOptions = "<option value=''>Choose a network</option>";
    int count = WiFi.scanNetworks();
    for (int i = 0; i < count && i < 30; ++i) {
      String ssid = escape(WiFi.SSID(i));
      networkOptions += "<option value=\"" + ssid + "\">" + ssid + "</option>";
    }
    WiFi.scanDelete();
    WiFi.mode(WIFI_AP_STA);
    WiFi.softAPConfig(IPAddress(192,168,4,1), IPAddress(192,168,4,1), IPAddress(255,255,255,0));
    if (!WiFi.softAP("Jeopardy Buzzer Setup", AP_PASSWORD, CHANNEL)) fatal("Cannot start setup Wi-Fi");
  }
  if (esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE) != ESP_OK) fatal("Cannot select setup channel");
  incoming = xQueueCreate(16, sizeof(Received));
  if (!incoming || esp_now_init() != ESP_OK || esp_now_set_pmk(PMK) != ESP_OK) fatal("Cannot start encrypted setup radio");
  for (auto& peer : PEERS) {
    esp_now_peer_info_t info{};
    memcpy(info.peer_addr, peer.mac, 6); memcpy(info.lmk, peer.key, 16);
    info.channel = CHANNEL; info.ifidx = WIFI_IF_STA; info.encrypt = true;
    if (esp_now_add_peer(&info) != ESP_OK) fatal("Cannot configure encrypted setup peer");
  }
  esp_now_register_recv_cb(receive);
  if (DEVICE_INDEX == 0) { startPortal(); Serial.println("Connect to Jeopardy Buzzer Setup. If no page opens, visit http://192.168.4.1"); }
  else Serial.println("Setup mode: waiting for Blue on channel 1.");
}
void loop() {
  if (setupMode) {
    if (DEVICE_INDEX == 0) { dns.processNextRequest(); web.handleClient(); }
    Received item;
    while (xQueueReceive(incoming, &item, 0) == pdTRUE) {
      auto peer = findPeer(item.peer);
      uint8_t expected[16];
      if (peer && tag(item.wire.packet, peer->key, expected) && equalBytes(expected, item.wire.tag, 16))
        provision->receive(item.peer, item.wire.packet, millis());
    }
    provision->tick(millis());
    if (provision->canJoin(millis())) joinHome();
  } else if (joined && WiFi.status() != WL_CONNECTED && uint32_t(millis() - lastWifiAttempt) >= 10000) {
    // Never erase a configuration merely because the home network is unavailable.
    WiFi.disconnect(); WiFi.begin(provision->settings().ssid, provision->settings().password);
    lastWifiAttempt = millis();
  }
  delay(5);
}
