// Logik bebas-platform: profil enjin, pengesanan knock, decode isyarat CAN ECU.
// Tiada kebergantungan Arduino supaya boleh diuji di PC (lihat ../test/).
#pragma once
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include "knock_proto.h"

// ---------------- Profil enjin ----------------
struct Profile {
  char     name[16];
  uint8_t  cyl;          // 1..8
  uint8_t  order[8];     // firing order, order[0] mesti 1
  uint8_t  boreMm;
  uint8_t  freqAuto;     // 1: frekuensi dikira dari bore
  uint8_t  freqIdx;      // dipakai bila freqAuto = 0
  uint8_t  gainIdx;
  uint8_t  winStart;     // darjah selepas spark
  uint8_t  winLen;       // darjah
  uint8_t  sensors;      // 1 atau 2
  uint8_t  tachoRising;
  uint8_t  threshold10;  // ambang nisbah x10 (18 = 1.8x paras latar)
  uint16_t minRpm;
};

struct Preset { const char *name; uint8_t cyl; uint8_t order[8]; uint8_t bore; };
constexpr Preset PRESETS[] = {
  {"3 SIL 1-2-3",     3, {1, 2, 3},                71},
  {"3 SIL 1-3-2",     3, {1, 3, 2},                71},
  {"4 SIL 1-3-4-2",   4, {1, 3, 4, 2},             81},
  {"4 SIL 1-2-4-3",   4, {1, 2, 4, 3},             81},
  {"5 SIL 1-2-4-5-3", 5, {1, 2, 4, 5, 3},          81},
  {"6 SIL 1-5-3-6-2-4", 6, {1, 5, 3, 6, 2, 4},     86},
  {"8 SIL 1-8-4-3-6-5-7-2", 8, {1, 8, 4, 3, 6, 5, 7, 2}, 96},
};
constexpr int NUM_PRESETS = sizeof(PRESETS) / sizeof(PRESETS[0]);

inline void applyPreset(Profile &p, int i) {
  const Preset &s = PRESETS[i];
  memset(p.name, 0, sizeof(p.name));
  strncpy(p.name, s.name, sizeof(p.name) - 1);
  p.cyl = s.cyl;
  memset(p.order, 0, sizeof(p.order));
  memcpy(p.order, s.order, s.cyl);
  p.boreMm = s.bore;
}

inline Profile defaultProfile(int presetIdx = 2) {
  Profile p{};
  applyPreset(p, presetIdx);
  p.freqAuto = 1; p.freqIdx = 40; p.gainIdx = 14; p.winStart = 10; p.winLen = 60;
  p.sensors = 2; p.tachoRising = 0; p.threshold10 = 18; p.minRpm = 1200;
  return p;
}

inline bool profileValid(const Profile &p) {
  if (p.cyl < 1 || p.cyl > kp::MAX_CYL || p.order[0] != 1 || p.freqIdx > 63 || p.gainIdx > 63) return false;
  if (p.winLen == 0 || p.sensors < 1 || p.sensors > 2 || p.threshold10 < 11) return false;
  uint16_t seen = 0;
  for (int i = 0; i < p.cyl; i++) {
    if (p.order[i] < 1 || p.order[i] > p.cyl || (seen >> p.order[i]) & 1) return false;
    seen |= 1 << p.order[i];
  }
  return true;
}

inline uint8_t profileFreqIdx(const Profile &p) {
  return p.freqAuto ? kp::nearestFreqIdx(kp::knockFreqKhz(p.boreMm)) : p.freqIdx;
}

// Sensor 1 di depan blok (dekat silinder 1), sensor 2 di belakang.
// Silinder separuh belakang guna channel 2.
inline uint8_t profileCh2Mask(const Profile &p) {
  if (p.sensors < 2) return 0;
  uint8_t m = 0;
  for (int i = 0; i < p.cyl; i++) if (p.order[i] * 2 > p.cyl + 1) m |= 1 << i;
  return m;
}

inline kp::NodeConfig profileToNode(const Profile &p) {
  kp::NodeConfig c;
  c.cylinders = p.cyl; c.freqIdx = profileFreqIdx(p); c.gainIdx = p.gainIdx;
  c.winStartDeg = p.winStart; c.winLenDeg = p.winLen; c.ch2Mask = profileCh2Mask(p); c.tachoRising = p.tachoRising;
  return c;
}

// Label silinder untuk indeks pembakaran. Wasted spark: pasangan, cth "1/4".
inline void firingLabel(const Profile &p, uint8_t firing, bool wasted, char *out, int n) {
  if (firing >= p.cyl) { snprintf(out, n, "?"); return; }
  if (wasted && p.cyl % 2 == 0 && firing < p.cyl / 2)
    snprintf(out, n, "%u/%u", p.order[firing], p.order[firing + p.cyl / 2]);
  else snprintf(out, n, "%u", p.order[firing]);
}

// ---------------- Isyarat CAN dari ECU (cth MyEFI) ----------------
enum SigId { SIG_RPM, SIG_MAP, SIG_ADV, SIG_AFR, SIG_CLT, SIG_TPS, SIG_N };
constexpr const char *SIG_NAME[SIG_N] = {"rpm", "map", "adv", "afr", "clt", "tps"};
constexpr const char *SIG_UNIT[SIG_N] = {"rpm", "kPa", "deg", "AFR", "C", "%"};

struct CanSig {
  uint16_t id;      // ID CAN 11-bit
  uint8_t  start;   // bait mula (0..7)
  uint8_t  len;     // 1 atau 2 bait
  uint8_t  be;      // 1: big-endian (Motorola), 0: little-endian (Intel)
  uint8_t  sgn;     // 1: bertanda
  uint8_t  en;
  float    scale, offset;
};

inline bool decodeSig(const CanSig &s, uint32_t id, uint8_t dlc, const uint8_t *d, float &out) {
  if (!s.en || id != s.id || s.len < 1 || s.len > 2 || s.start + s.len > dlc) return false;
  int32_t raw;
  if (s.len == 1) raw = s.sgn ? (int8_t)d[s.start] : d[s.start];
  else {
    uint16_t u = s.be ? (uint16_t)(d[s.start] << 8 | d[s.start + 1]) : (uint16_t)(d[s.start + 1] << 8 | d[s.start]);
    raw = s.sgn ? (int16_t)u : u;
  }
  out = raw * s.scale + s.offset;
  return true;
}

// ---------------- Pengesan knock ----------------
struct CylState {
  float    bg;          // paras latar (mV) yang dipelajari
  float    ratio;       // nisbah terakhir
  float    peak;        // puncak (menyusut perlahan) untuk paparan bar
  uint16_t lastMv;
  uint32_t count;
  uint32_t lastKnockMs;
  uint32_t samples;
};

struct LogEntry { uint32_t ms; uint8_t slot; uint8_t wasted; float ratio; uint16_t rpm; float map, adv; uint8_t mapOk, advOk; };

class KnockEngine {
 public:
  static constexpr int RPM_BINS = 16;   // 0..8000 rpm, 500 setiap sel
  static constexpr int MAP_BINS = 10;   // 0..300 kPa, 30 setiap sel
  static constexpr int LOG_N = 64;
  static constexpr int SLOT_NOSYNC = kp::MAX_CYL;
  static constexpr int LEARN_SAMPLES = 20;  // tidak tanda knock sebelum paras latar stabil

  CylState s[kp::MAX_CYL + 1];
  LogEntry log[LOG_N];
  int      logHead = 0, logCount = 0;
  uint16_t grid[MAP_BINS][RPM_BINS];
  uint32_t totalKnock = 0;

  KnockEngine() { reset(); }
  void reset() {
    memset(s, 0, sizeof(s)); memset(grid, 0, sizeof(grid)); memset(log, 0, sizeof(log));
    logHead = logCount = 0; totalKnock = 0;
  }

  static int rpmBin(uint16_t rpm) { int b = rpm / 500; return b >= RPM_BINS ? RPM_BINS - 1 : b; }
  static int mapBin(float kpa) { int b = kpa < 0 ? 0 : (int)(kpa / 30.0f); return b >= MAP_BINS ? MAP_BINS - 1 : b; }

  // Pulangkan true jika knock dikesan
  bool onEvent(const Profile &p, uint8_t firing, bool wasted, uint16_t mv, uint16_t rpm,
               float map, bool mapOk, float adv, bool advOk, uint32_t ms) {
    int slot = firing < p.cyl ? firing : SLOT_NOSYNC;
    CylState &c = s[slot];
    c.lastMv = mv;
    c.samples++;
    if (c.bg <= 0) { c.bg = mv > 20 ? mv : 20; return false; }
    float r = mv / (c.bg > 20 ? c.bg : 20);
    c.ratio = r;
    if (r > c.peak) c.peak = r;
    bool armed = rpm >= p.minRpm && c.samples > LEARN_SAMPLES;
    bool knock = armed && r >= p.threshold10 / 10.0f;
    // Paras latar: belajar cepat dari pembakaran biasa, hampir tidak belajar dari knock
    c.bg += (mv - c.bg) * (knock ? 0.002f : 0.03f);
    if (!knock) return false;
    c.count++; c.lastKnockMs = ms; totalKnock++;
    LogEntry &e = log[logHead];
    e.ms = ms; e.slot = slot; e.wasted = wasted; e.ratio = r; e.rpm = rpm;
    e.map = map; e.adv = adv; e.mapOk = mapOk; e.advOk = advOk;
    logHead = (logHead + 1) % LOG_N;
    if (logCount < LOG_N) logCount++;
    uint16_t &g = grid[mapOk ? mapBin(map) : 0][rpmBin(rpm)];
    if (g < 65535) g++;
    return true;
  }

  // Panggil ~10 kali sesaat: puncak bar menyusut ke nilai semasa
  void decay() {
    for (auto &c : s) { float d = c.peak * 0.85f; c.peak = d > c.ratio ? d : c.ratio; }
  }

  // i = 0 entri terbaru
  const LogEntry *logAt(int i) const {
    if (i >= logCount) return nullptr;
    return &log[(logHead - 1 - i + LOG_N) % LOG_N];
  }
};
