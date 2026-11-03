#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace provisioning {
constexpr uint8_t CHANNEL = 1;
constexpr uint32_t RETRY_MS = 500;
constexpr uint32_t RELEASE_MS = 10000;
constexpr uint32_t JOIN_MS = 15000;
constexpr const char* COLORS[] = {"blue", "green", "red", "yellow"};

struct Settings {
  char ssid[33]{};
  char password[65]{};
  char backend[97]{};
};
inline bool valid(const Settings& s) {
  if (!memchr(s.ssid, 0, sizeof s.ssid) || !s.ssid[0] ||
      !memchr(s.password, 0, sizeof s.password) ||
      !memchr(s.backend, 0, sizeof s.backend)) return false;
  auto passwordLength = strlen(s.password);
  if (passwordLength && (passwordLength < 8 || passwordLength > 63)) return false;
  const char* host = nullptr;
  if (!strncmp(s.backend, "ws://", 5)) host = s.backend + 5;
  if (!strncmp(s.backend, "wss://", 6)) host = s.backend + 6;
  if (!host || !*host) return false;
  const char* path = strchr(host, '/');
  if (!path || path == host || strcmp(path, "/hardware/buzzers")) return false;
  for (const char* p = s.backend; *p; ++p) {
    if (static_cast<unsigned char>(*p) <= 32 || *p == '@' || *p == '?' || *p == '#') return false;
  }
  return true;
}

struct Saved {
  uint32_t magic = 0x42555a31;
  Settings settings{};
  uint64_t transaction = 0;
  bool staged = true;
};
enum class Kind : uint8_t { Hello = 1, Prepare, SavedAck, Release, ReleaseAck };
struct Packet {
  uint8_t version = 1;
  Kind kind = Kind::Hello;
  uint64_t nonce = 0;
  uint64_t transaction = 0;
  Settings settings{};
};
static_assert(sizeof(Packet) <= 250, "Must fit encrypted ESP-NOW v1 payload");

// Only these hardware boundaries are substituted by the desktop harness.
struct Storage {
  virtual bool read(Saved& saved) = 0;
  virtual bool write(const Saved& saved) = 0;
  virtual ~Storage() = default;
};
struct Radio {
  virtual void send(uint8_t destination, const Packet& packet) = 0;
  virtual ~Radio() = default;
};
struct Progress {
  bool seen = false;
  bool saved = false;
  bool released = false;
};

class Setup {
 public:
  Setup(uint8_t id, uint64_t bootNonce, Storage& storage, Radio& radio)
      : id_(id), nonce_(bootNonce), storage_(storage), radio_(radio) {
    hasSaved_ = storage_.read(saved_) && saved_.magic == 0x42555a31 &&
                saved_.transaction != 0 && valid(saved_.settings);
    progress_[id_].seen = true;
    progress_[id_].saved = hasSaved_;
  }
  bool hasSettings() const { return hasSaved_; }
  bool needsSetup() const { return !hasSaved_ || saved_.staged; }
  const Settings& settings() const { return saved_.settings; }
  Progress progress(uint8_t id) const { return progress_[id]; }
  bool allSaved() const {
    if (!hasSaved_) return false;
    for (auto& p : progress_) if (!p.saved) return false;
    return true;
  }
  bool releasing() const { return releasing_; }
  bool canJoin(uint32_t now) const { return releasing_ && uint32_t(now - releaseAt_) >= JOIN_MS; }

  bool configure(const Settings& settings, uint64_t transaction) {
    if (id_ != 0 || releasing_ || !transaction || !valid(settings)) return false;
    Saved next{};
    next.settings = settings;
    next.transaction = transaction;
    if (!storage_.write(next)) return false;
    saved_ = next;
    hasSaved_ = true;
    for (auto& p : progress_) { p.saved = false; p.released = false; }
    progress_[0].saved = true;
    return true;
  }
  bool finish(uint32_t now) {
    if (id_ != 0 || !allSaved() || releasing_) return false;
    Saved next = saved_;
    next.staged = false;
    if (!storage_.write(next)) return false;
    saved_ = next;
    releasing_ = true;
    releaseAt_ = now;
    progress_[0].released = true;
    return true;
  }
  void receive(uint8_t sender, const Packet& p, uint32_t now) {
    if (sender > 3 || sender == id_ || p.version != 1 || !p.nonce) return;
    if (id_ == 0) {
      if (p.kind == Kind::Hello) {
        // Rebooted peers must confirm persistence again, under their new nonce.
        if (peerNonces_[sender] != p.nonce) {
          progress_[sender] = {true, false, false};
          peerNonces_[sender] = p.nonce;
        }
        progress_[sender].seen = true;
      } else if (p.nonce == peerNonces_[sender] && hasSaved_ && p.transaction == saved_.transaction) {
        if (p.kind == Kind::SavedAck) progress_[sender].saved = true;
        if (p.kind == Kind::ReleaseAck && releasing_) progress_[sender].released = true;
      }
    } else if (sender == 0 && p.nonce == nonce_) {
      if (p.kind == Kind::Prepare && !releasing_ && p.transaction && valid(p.settings)) {
        if (!hasSaved_ || saved_.transaction != p.transaction ||
            memcmp(&saved_.settings, &p.settings, sizeof(Settings))) {
          Saved next{};
          next.settings = p.settings;
          next.transaction = p.transaction;
          if (!storage_.write(next)) return;
          saved_ = next;
          hasSaved_ = true;
        }
        reply(Kind::SavedAck);
      } else if (p.kind == Kind::Release && hasSaved_ && p.transaction == saved_.transaction) {
        if (!releasing_) {
          Saved next = saved_;
          next.staged = false;
          if (!storage_.write(next)) return;
          saved_ = next;
          releasing_ = true;
          releaseAt_ = now;
        }
        reply(Kind::ReleaseAck);
      }
    }
  }
  void tick(uint32_t now) {
    if (ticked_ && uint32_t(now - lastSend_) < RETRY_MS) return;
    ticked_ = true;
    lastSend_ = now;
    if (id_) {
      if (!releasing_) reply(Kind::Hello);
      return;
    }
    if (!hasSaved_) return;
    for (uint8_t peer = 1; peer < 4; ++peer) {
      if (!peerNonces_[peer]) continue;
      Packet packet{};
      packet.nonce = peerNonces_[peer];
      packet.transaction = saved_.transaction;
      if (releasing_) {
        if (uint32_t(now - releaseAt_) > RELEASE_MS) continue;
        packet.kind = Kind::Release;
      } else {
        if (progress_[peer].saved) continue;
        packet.kind = Kind::Prepare;
        packet.settings = saved_.settings;
      }
      radio_.send(peer, packet);
    }
  }
 private:
  void reply(Kind kind) {
    Packet packet{};
    packet.kind = kind;
    packet.nonce = nonce_;
    packet.transaction = hasSaved_ ? saved_.transaction : 0;
    radio_.send(0, packet);
  }
  uint8_t id_;
  uint64_t nonce_;
  Storage& storage_;
  Radio& radio_;
  Saved saved_{};
  bool hasSaved_ = false;
  Progress progress_[4]{};
  uint64_t peerNonces_[4]{};
  bool releasing_ = false;
  bool ticked_ = false;
  uint32_t lastSend_ = 0;
  uint32_t releaseAt_ = 0;
};
} // namespace provisioning
