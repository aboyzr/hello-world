// Protokol CAN antara modul sensor knock (node) dan skrin (display).
// Kedua-dua berkongsi bas CAN yang sama dengan ECU (cth MyEFI).
// PENTING: pastikan ID di bawah TIDAK digunakan oleh ECU anda (semak dengan sniff dulu).
#pragma once
#include <stdint.h>

namespace kp {

constexpr uint32_t CAN_KBPS  = 500;    // mesti sama dengan kadar bit CAN ECU
constexpr uint32_t ID_EVENT  = 0x6E0;  // node -> skrin, satu bingkai setiap pembakaran
constexpr uint32_t ID_STATUS = 0x6E1;  // node -> skrin, 5 Hz
constexpr uint32_t ID_CONFIG = 0x6E2;  // skrin -> node

constexpr uint8_t NO_SYNC = 0xFF;      // indeks pembakaran tidak diketahui (tiada sync silinder 1)
constexpr uint8_t MAX_CYL = 8;

// Bendera status node
constexpr uint8_t ST_SYNC   = 0x01;    // sync silinder 1 OK
constexpr uint8_t ST_WASTED = 0x02;    // pulse silinder 1 datang setiap pusingan (wasted spark)
constexpr uint8_t ST_CHIP   = 0x04;    // INTOUT cip knock kelihatan hidup (> 50 mV)
constexpr uint8_t ST_TACHO  = 0x08;    // pulse tacho diterima (enjin hidup)

struct NodeConfig {
  uint8_t cylinders   = 4;   // 1..8
  uint8_t freqIdx     = 40;  // indeks bandpass TPIC8101 (0..63), lihat BANDPASS_KHZ
  uint8_t gainIdx     = 14;  // indeks gain (0 = 2.0x, 14 = 1.0x ... 63 = 0.111x)
  uint8_t winStartDeg = 10;  // tetingkap knock bermula N darjah crank SELEPAS spark (pulse tacho)
  uint8_t winLenDeg   = 60;  // panjang tetingkap (darjah crank)
  uint8_t ch2Mask     = 0;   // bit i = 1: pembakaran ke-i (0 = silinder 1) guna sensor/channel 2
  uint8_t tachoRising = 0;   // 0: pulse tacho dikira pada sisi jatuh, 1: sisi naik
};

// Bingkai CONFIG: [0]=0xC5 [1]=cyl [2]=freq [3]=gain [4]=winStart [5]=winLen [6]=ch2Mask [7]=tachoRising
inline void packConfig(const NodeConfig &c, uint8_t d[8]) {
  d[0] = 0xC5; d[1] = c.cylinders; d[2] = c.freqIdx; d[3] = c.gainIdx;
  d[4] = c.winStartDeg; d[5] = c.winLenDeg; d[6] = c.ch2Mask; d[7] = c.tachoRising;
}
inline bool unpackConfig(const uint8_t d[8], NodeConfig &c) {
  if (d[0] != 0xC5 || d[1] < 1 || d[1] > MAX_CYL || d[2] > 63 || d[3] > 63 || d[5] == 0) return false;
  c.cylinders = d[1]; c.freqIdx = d[2]; c.gainIdx = d[3];
  c.winStartDeg = d[4]; c.winLenDeg = d[5]; c.ch2Mask = d[6]; c.tachoRising = d[7] ? 1 : 0;
  return true;
}

// Bingkai EVENT: [0]=indeks pembakaran (0 = silinder 1, NO_SYNC jika tiada sync)
//                [1]=channel (0/1) [2..3]=voltan INTOUT integrator dalam mV (LE) [4..5]=rpm (LE)
//                [6]=nombor siri (seq) [7]=bendera status
struct Event { uint8_t firing, channel, seq, flags; uint16_t level, rpm; };
inline void packEvent(const Event &e, uint8_t d[8]) {
  d[0] = e.firing; d[1] = e.channel; d[2] = e.level & 0xFF; d[3] = e.level >> 8;
  d[4] = e.rpm & 0xFF; d[5] = e.rpm >> 8; d[6] = e.seq; d[7] = e.flags;
}
inline Event unpackEvent(const uint8_t d[8]) {
  Event e; e.firing = d[0]; e.channel = d[1]; e.level = d[2] | (d[3] << 8);
  e.rpm = d[4] | (d[5] << 8); e.seq = d[6]; e.flags = d[7]; return e;
}

// Bingkai STATUS: [0]=bendera [1]=cyl [2..3]=rpm (LE) [4]=freqIdx [5]=gainIdx [6]=winStart [7]=winLen

// Frekuensi tengah bandpass TPIC8101 (kHz) ikut indeks 0..63.
// Dari Jadual 3 datasheet HIP9011 (TPIC8101 serasi pin & daftar).
constexpr float BANDPASS_KHZ[64] = {
  1.22, 1.26, 1.31, 1.35, 1.40, 1.45, 1.51, 1.57, 1.63, 1.71, 1.78, 1.87, 1.96, 2.07, 2.18, 2.31,
  2.46, 2.54, 2.62, 2.71, 2.81, 2.92, 3.03, 3.15, 3.28, 3.43, 3.59, 3.76, 3.95, 4.16, 4.39, 4.66,
  4.95, 5.12, 5.29, 5.48, 5.68, 5.90, 6.12, 6.37, 6.64, 6.94, 7.27, 7.63, 8.02, 8.46, 8.95, 9.50,
  10.12, 10.46, 10.83, 11.22, 11.65, 12.10, 12.60, 13.14, 13.72, 14.36, 15.07, 15.84, 16.71, 17.67,
  18.76, 19.98
};

// Gain ikut indeks 0..63 (Jadual 3 datasheet HIP9011)
constexpr float GAIN[64] = {
  2.000, 1.882, 1.778, 1.684, 1.600, 1.523, 1.455, 1.391, 1.333, 1.280, 1.231, 1.185, 1.143, 1.063, 1.000, 0.944,
  0.895, 0.850, 0.810, 0.773, 0.739, 0.708, 0.680, 0.654, 0.630, 0.607, 0.586, 0.567, 0.548, 0.500, 0.471, 0.444,
  0.421, 0.400, 0.381, 0.364, 0.348, 0.333, 0.320, 0.308, 0.296, 0.286, 0.276, 0.267, 0.258, 0.250, 0.236, 0.222,
  0.211, 0.200, 0.190, 0.182, 0.174, 0.167, 0.160, 0.154, 0.148, 0.143, 0.138, 0.133, 0.129, 0.125, 0.118, 0.111
};

// Anggaran frekuensi knock dari bore (formula Draper, mod (1,0)): f = 900 * 1.84 / (pi * B)
inline float knockFreqKhz(float boreMm) { return boreMm > 0 ? (900.0f * 1.84f / (3.14159f * boreMm / 1000.0f)) / 1000.0f : 0; }

inline uint8_t nearestFreqIdx(float khz) {
  uint8_t best = 0; float bd = 1e9;
  for (uint8_t i = 0; i < 64; i++) { float d = BANDPASS_KHZ[i] - khz; if (d < 0) d = -d; if (d < bd) { bd = d; best = i; } }
  return best;
}

}  // namespace kp
