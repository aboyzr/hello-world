// Ujian logik di PC:  g++ -std=c++17 -I../src -I../../shared test_engine.cpp -o t && ./t
#include <assert.h>
#include <stdlib.h>
#include "engine.h"

int main() {
  // jadual datasheet lengkap 64 entri dan menaik
  for (int i = 1; i < 64; i++) { assert(kp::BANDPASS_KHZ[i] > kp::BANDPASS_KHZ[i - 1]); assert(kp::GAIN[i] < kp::GAIN[i - 1]); }
  assert(kp::BANDPASS_KHZ[63] > 19.9f && kp::GAIN[14] == 1.0f);

  Profile p = defaultProfile(2);  // 4 SIL 1-3-4-2
  assert(profileValid(p));
  float f = kp::knockFreqKhz(81);
  printf("bore 81 mm -> %.2f kHz -> idx %d (%.2f kHz)\n", f, profileFreqIdx(p), kp::BANDPASS_KHZ[profileFreqIdx(p)]);
  assert(f > 6.0f && f < 7.0f);
  assert(profileCh2Mask(p) == 0b0110);              // pembakaran 1,2 = silinder 3,4 -> sensor belakang
  Profile p3 = defaultProfile(0);                    // 3 SIL 1-2-3
  assert(profileCh2Mask(p3) == 0b100);
  p3.sensors = 1; assert(profileCh2Mask(p3) == 0);

  char lb[8];
  firingLabel(p, 1, false, lb, 8); assert(!strcmp(lb, "3"));
  firingLabel(p, 1, true, lb, 8);  assert(!strcmp(lb, "3/2"));
  firingLabel(p, kp::NO_SYNC, false, lb, 8); assert(!strcmp(lb, "?"));

  // config round-trip
  uint8_t d[8]; kp::NodeConfig c = profileToNode(p), c2; kp::packConfig(c, d);
  assert(kp::unpackConfig(d, c2) && !memcmp(&c, &c2, sizeof(c)));
  kp::Event e{2, 1, 7, kp::ST_SYNC, 1234, 5600}; kp::packEvent(e, d);
  kp::Event e2 = kp::unpackEvent(d); assert(e2.level == 1234 && e2.rpm == 5600 && e2.firing == 2);

  // decode isyarat: 2 bait big-endian, skala 0.1
  CanSig s{0x5F0, 2, 2, 1, 0, 1, 0.1f, 0}; uint8_t m[8] = {0, 0, 0x06, 0x40, 0, 0, 0, 0}; float v;
  assert(decodeSig(s, 0x5F0, 8, m, v) && v > 159.9f && v < 160.1f);
  assert(!decodeSig(s, 0x5F1, 8, m, v));
  CanSig sl{0x100, 0, 1, 0, 1, 1, 1, 0}; uint8_t m2[1] = {0xF6}; assert(decodeSig(sl, 0x100, 1, m2, v) && v == -10);

  // pengesanan: latar ~500 mV dengan hingar, silinder 4 (pembakaran 2) knock pada kitaran 300
  KnockEngine k; srand(1);
  int detected = 0, falsePos = 0;
  for (int cyc = 0; cyc < 400; cyc++)
    for (int fi = 0; fi < 4; fi++) {
      uint16_t mv = 500 + rand() % 80;
      bool kn = (fi == 2 && cyc >= 300 && cyc % 10 == 0);
      if (kn) mv = 1400;
      bool r = k.onEvent(p, fi, false, mv, 4000, 150, true, 25, true, cyc * 20);
      if (r && kn) detected++; else if (r) falsePos++;
    }
  printf("knock dikesan %d/10, palsu %d, latar sil4 %.0f mV\n", detected, falsePos, k.s[2].bg);
  assert(detected == 10 && falsePos == 0 && k.s[2].count == 10);
  assert(k.grid[KnockEngine::mapBin(150)][KnockEngine::rpmBin(4000)] == 10);
  assert(k.logAt(0)->slot == 2 && k.logCount == 10);
  // bawah minRpm: tiada knock
  assert(!k.onEvent(p, 2, false, 3000, 800, 0, false, 0, false, 0));
  puts("OK");
}
