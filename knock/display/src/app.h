// Keadaan aplikasi yang dikongsi antara tugas CAN, UI dan konsol Serial
#pragma once
#include <Arduino.h>
#include "engine.h"

constexpr int NUM_PROFILES = 6;
constexpr int SNIFF_N = 64;

struct NodeStatus {
  uint32_t lastMs = 0;      // bila status terakhir diterima
  uint8_t  flags = 0, cyl = 0, freqIdx = 0, gainIdx = 0, winStart = 0, winLen = 0;
  uint16_t rpm = 0;
  uint32_t events = 0, lost = 0;
  uint8_t  lastSeq = 0;
  bool online() const { return lastMs && millis() - lastMs < 1500; }
};

struct SniffEntry {
  uint32_t id;
  uint8_t  dlc, ext;
  uint8_t  data[8];
  uint32_t count, winCount, winStart;
  float    hz;
};

struct App {
  Profile    prof[NUM_PROFILES];
  uint8_t    active = 0;
  CanSig     sig[SIG_N];
  float      sigVal[SIG_N];
  uint32_t   sigMs[SIG_N];
  KnockEngine knock;
  NodeStatus node;
  SniffEntry sniff[SNIFF_N];
  int        sniffN = 0;
  uint32_t   canRx = 0, canErr = 0;
  bool       demo = false;
  bool       dirty = false;          // ada perubahan belum disimpan
  bool       configPending = true;   // hantar config ke node
  uint32_t   lastKnockMs = 0;
  SemaphoreHandle_t lock;

  Profile &cur() { return prof[active]; }
  bool sigOk(int i) const { return sigMs[i] && millis() - sigMs[i] < 1000; }
  bool wasted() const { return node.flags & kp::ST_WASTED; }
  // Bilangan bar di skrin Live
  int slots() { return wasted() && cur().cyl % 2 == 0 ? cur().cyl / 2 : cur().cyl; }
};

extern App app;

struct Lock {
  Lock() { xSemaphoreTake(app.lock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(app.lock); }
};

// main.cpp
void saveAll();
void sendNodeConfig();

// ui.cpp
void uiInit();
void uiLoop();
