#include "provisioning.h"
#include <array>
#include <deque>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <cstdio>
using namespace provisioning;

void check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
struct Disk : Storage {
  std::string path;
  bool failing = false;
  explicit Disk(std::string path) : path(path) { std::remove(path.c_str()); }
  ~Disk() { std::remove(path.c_str()); }
  bool read(Saved& saved) override {
    std::ifstream in(path, std::ios::binary);
    return bool(in.read(reinterpret_cast<char*>(&saved), sizeof saved));
  }
  bool write(const Saved& saved) override {
    if (failing) return false;
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out.write(reinterpret_cast<const char*>(&saved), sizeof saved);
    out.close();
    return bool(out);
  }
};
struct Delivery { uint8_t from, to; Packet packet; };
struct Network;
struct Endpoint : Radio {
  Network& network;
  uint8_t id;
  Endpoint(Network& network, uint8_t id) : network(network), id(id) {}
  void send(uint8_t destination, const Packet& packet) override;
};
struct Network {
  std::array<Disk, 4> disks{Disk("blue.bin"), Disk("green.bin"), Disk("red.bin"), Disk("yellow.bin")};
  std::array<Endpoint, 4> radios{Endpoint(*this, 0), Endpoint(*this, 1), Endpoint(*this, 2), Endpoint(*this, 3)};
  std::array<std::unique_ptr<Setup>, 4> nodes;
  std::deque<Delivery> queue;
  uint32_t now = 0;
  uint64_t nonce = 100;
  int offline = -1;
  int dropTo = -1;
  Kind dropKind = Kind::Hello;
  unsigned dropsLeft = 0;
  Network() { for (uint8_t i = 0; i < 4; ++i) reboot(i); }
  void reboot(uint8_t id) { nodes[id].reset(new Setup(id, ++nonce, disks[id], radios[id])); }
  void drain() {
    while (!queue.empty()) {
      auto item = queue.front(); queue.pop_front();
      if (item.to == offline || item.from == offline) continue;
      if (item.to == dropTo && item.packet.kind == dropKind && dropsLeft) { --dropsLeft; continue; }
      nodes[item.to]->receive(item.from, item.packet, now);
    }
  }
  void advance(uint32_t milliseconds) {
    for (uint32_t elapsed = 0; elapsed < milliseconds; elapsed += 100) {
      now += 100;
      for (uint8_t i = 0; i < 4; ++i) if (i != offline) nodes[i]->tick(now);
      drain();
    }
  }
};
void Endpoint::send(uint8_t destination, const Packet& packet) { network.queue.push_back({id, destination, packet}); }
Settings settings() {
  Settings s{};
  strcpy(s.ssid, "Game night"); strcpy(s.password, "home-password");
  strcpy(s.backend, "ws://192.168.1.42:3001/hardware/buzzers");
  return s;
}
void distribution() {
  Network n;
  check(n.nodes[0]->configure(settings(), 42), "Blue accepts valid settings");
  n.offline = 3;
  n.advance(3000);
  check(!n.nodes[0]->allSaved() && !n.nodes[0]->finish(n.now), "Missing Yellow prevents finish");
  for (auto& node : n.nodes) check(!node->canJoin(n.now), "No device changes channel before all have saved");
  n.offline = -1;
  n.dropTo = 2; n.dropKind = Kind::Prepare; n.dropsLeft = 3;
  n.advance(4000);
  check(n.nodes[0]->allSaved(), "Retry reaches Yellow and recovers lost Red deliveries");
  for (auto& node : n.nodes) check(!strcmp(node->settings().ssid, "Game night"), "Each device receives the home network");
  check(n.nodes[0]->finish(n.now), "Finish allowed only after every device saves");
  n.dropTo = 1; n.dropKind = Kind::Release; n.dropsLeft = 3;
  n.advance(18000);
  for (auto& node : n.nodes) check(node->canJoin(n.now), "Release retries let every device join");
}
void delayedRelease() {
  Network n;
  n.nodes[0]->configure(settings(), 91);
  n.advance(2000);
  check(n.nodes[0]->allSaved(), "All settings saved before release");
  check(n.nodes[0]->finish(n.now), "Finish starts release");
  n.offline = 1;
  n.advance(18000);
  check(!n.nodes[0]->canJoin(n.now), "Blue stays in setup while Green has not acknowledged release");
  n.offline = -1;
  n.advance(2000);
  check(n.nodes[0]->progress(1).released, "Green receives release after the old ten-second retry window");
  check(n.nodes[0]->canJoin(n.now), "Blue can join after all release receipts arrive");
  n.advance(16000);
  check(n.nodes[1]->canJoin(n.now), "Recovered Green can join independently");
}
void persistence() {
  Network n;
  check(n.nodes[0]->configure(settings(), 80), "Settings accepted");
  n.advance(2000);
  n.reboot(2);
  check(n.nodes[2]->needsSetup(), "Reboot during distribution stays on setup channel");
  check(!strcmp(n.nodes[2]->settings().backend, "ws://192.168.1.42:3001/hardware/buzzers"), "Backend survives reboot");
  n.reboot(0);
  n.advance(2000);
  check(n.nodes[0]->allSaved(), "Blue reboot resumes distribution from durable settings");
  check(n.nodes[0]->finish(n.now), "Can finish after recovery");
  n.advance(18000);
  for (uint8_t i = 0; i < 4; ++i) {
    n.reboot(i);
    check(!n.nodes[i]->needsSetup(), "Released device boots onto saved home Wi-Fi");
    check(!strcmp(n.nodes[i]->settings().password, "home-password"), "Saved password reloads");
  }
}
void failedWritesAndAcks() {
  Network n;
  n.disks[0].failing = true;
  check(!n.nodes[0]->configure(settings(), 42), "Blue reports a failed local save");
  n.disks[0].failing = false;
  n.nodes[0]->configure(settings(), 42);
  n.disks[1].failing = true;
  n.advance(2000);
  check(!n.nodes[0]->progress(1).saved, "Green must not acknowledge a failed persistent write");
  n.disks[1].failing = false;
  n.dropTo = 0; n.dropKind = Kind::SavedAck; n.dropsLeft = 6;
  n.advance(5000);
  check(n.nodes[0]->allSaved(), "Repeated saves acknowledge again when an acknowledgment is lost");
}
void rejectStaleAndInvalid() {
  Network n;
  auto invalid = settings(); strcpy(invalid.backend, "ws://secret@host/hardware/buzzers");
  check(!n.nodes[0]->configure(invalid, 42), "Credentials in backend URL are rejected");
  n.nodes[0]->configure(settings(), 42);
  n.advance(2000);
  Packet stale{}; stale.kind = Kind::Release; stale.nonce = 999; stale.transaction = 42;
  n.nodes[1]->receive(0, stale, n.now);
  n.advance(16000);
  check(!n.nodes[1]->canJoin(n.now), "Release from an old boot cannot change channels");
  auto other = settings(); strcpy(other.ssid, "New network");
  n.nodes[0]->configure(other, 43);
  n.offline = 3;
  n.advance(2000);
  check(!n.nodes[0]->allSaved(), "Old receipts do not complete a new configuration");
}
int main() {
  try {
    distribution(); delayedRelease(); persistence(); failedWritesAndAcks(); rejectStaleAndInvalid();
    std::cout << "PASS: distribution, offline peer, delayed release recovery, retries, lost acknowledgments, storage failure, reboot, stale messages, channel barrier\n";
  } catch (const std::exception& e) { std::cerr << "FAIL: " << e.what() << '\n'; return 1; }
}
