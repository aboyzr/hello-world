// Antara muka 800x480: LIVE, PETA, LOG, CAN, TETAPAN
#include "app.h"
#include "board.h"

static LGFX lcd;
static LGFX_Sprite fb(&lcd);  // lukis di PSRAM, kemudian tolak ke skrin (tiada kelipan)

enum Page { P_LIVE, P_MAP, P_LOG, P_CAN, P_SET, P_N };
static const char *PAGE_NAME[P_N] = {"LIVE", "PETA", "LOG", "CAN", "TETAPAN"};
static uint8_t page = P_LIVE;
static int canScroll = 0;
static uint8_t presetIdx = 2;

// Warna
static const uint16_t C_BG = 0x0841, C_PANEL = 0x18E3, C_LINE = 0x39E7, C_TEXT = TFT_WHITE, C_DIM = 0x8C71;
static const uint16_t C_OK = 0x2E68, C_WARN = 0xFDA0, C_KNOCK = 0xF8A2, C_ACC = 0x2D7F;

constexpr int TOP_H = 56, TAB_Y = 420, TAB_H = 60;

// ---------------- Butang ----------------
enum BtnId : uint16_t {
  B_NONE, B_TAB0, B_RESET = 20, B_CAN_UP, B_CAN_DN,
  B_PROF_PREV, B_PROF_NEXT, B_PRESET, B_BORE_M, B_BORE_P, B_FREQ_M, B_FREQ_P, B_FREQ_AUTO, B_GAIN_M, B_GAIN_P,
  B_WS_M, B_WS_P, B_WL_M, B_WL_P, B_TH_M, B_TH_P, B_MR_M, B_MR_P, B_SENS, B_EDGE, B_DEMO, B_SAVE
};
struct Btn { int16_t x, y, w, h; uint16_t id; };
static Btn btns[64];
static int nBtn;

static void button(int x, int y, int w, int h, const char *label, uint16_t id, uint16_t col = C_PANEL, uint16_t fg = C_TEXT) {
  fb.fillRoundRect(x, y, w, h, 8, col);
  fb.drawRoundRect(x, y, w, h, 8, C_LINE);
  fb.setTextColor(fg);
  fb.setTextDatum(textdatum_t::middle_center);
  fb.drawString(label, x + w / 2, y + h / 2);
  if (nBtn < 64) btns[nBtn++] = {(int16_t)x, (int16_t)y, (int16_t)w, (int16_t)h, id};
}

static uint16_t ratioColor(float r, float th) { return r >= th ? C_KNOCK : r >= th * 0.8f ? C_WARN : C_OK; }

// ---------------- Bar atas & tab ----------------
static void drawTop() {
  fb.fillRect(0, 0, 800, TOP_H, C_PANEL);
  fb.setTextDatum(textdatum_t::top_left);
  fb.setFont(&fonts::FreeSansBold12pt7b);
  fb.setTextColor(C_ACC);
  fb.drawString("KNOCK", 12, 6);
  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextColor(C_DIM);
  char s[48];
  snprintf(s, sizeof(s), "P%d  %s", app.active + 1, app.cur().name);
  fb.drawString(s, 12, 33);

  // RPM: utamakan rpm dari tacho (node), jika tiada guna CAN ECU
  int rpm = app.node.online() ? app.node.rpm : app.sigOk(SIG_RPM) ? (int)app.sigVal[SIG_RPM] : -1;
  fb.setFont(&fonts::FreeSansBold18pt7b);
  fb.setTextColor(C_TEXT);
  fb.setTextDatum(textdatum_t::middle_right);
  if (rpm >= 0) snprintf(s, sizeof(s), "%d", rpm); else snprintf(s, sizeof(s), "----");
  fb.drawString(s, 330, TOP_H / 2);
  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(C_DIM);
  fb.drawString("rpm", 336, TOP_H / 2 + 4);

  auto val = [&](int i, int x, const char *fmt) {
    if (app.sigOk(i)) snprintf(s, sizeof(s), fmt, app.sigVal[i]); else snprintf(s, sizeof(s), "%s --", SIG_NAME[i]);
    fb.setTextColor(app.sigOk(i) ? C_TEXT : C_DIM);
    fb.drawString(s, x, TOP_H / 2);
  };
  val(SIG_MAP, 390, "%.0f kPa");
  val(SIG_ADV, 480, "%.1f deg");
  val(SIG_AFR, 570, "AFR %.1f");

  // Status node
  const char *st; uint16_t col;
  if (app.node.online()) {
    if (!(app.node.flags & kp::ST_TACHO)) { st = "TIADA TACHO"; col = C_WARN; }
    else if (!(app.node.flags & kp::ST_SYNC)) { st = "TIADA SYNC"; col = C_WARN; }
    else if (app.wasted()) { st = "SYNC (WASTED)"; col = C_OK; }
    else { st = "SYNC OK"; col = C_OK; }
  } else if (app.demo) { st = "DEMO"; col = C_ACC; }
  else { st = "NODE OFF"; col = C_KNOCK; }
  fb.fillRoundRect(660, 12, 130, 32, 16, col);
  fb.setTextColor(TFT_BLACK);
  fb.setTextDatum(textdatum_t::middle_center);
  fb.drawString(st, 725, 28);

  // Kilat merah bila knock baru berlaku
  if (app.lastKnockMs && millis() - app.lastKnockMs < 300) fb.fillRect(0, TOP_H - 4, 800, 4, C_KNOCK);
}

static void drawTabs() {
  fb.setFont(&fonts::FreeSansBold9pt7b);
  int w = 800 / P_N;
  for (int i = 0; i < P_N; i++)
    button(i * w + 4, TAB_Y + 6, w - 8, TAB_H - 12, PAGE_NAME[i], B_TAB0 + i, i == page ? C_ACC : C_PANEL, i == page ? TFT_BLACK : C_TEXT);
}

// ---------------- LIVE: bar setiap silinder ----------------
static void drawLive() {
  Profile &p = app.cur();
  int n = app.slots();
  float th = p.threshold10 / 10.0f;
  const float SCALE = 4.0f;  // bar penuh = 4x paras latar
  int x0 = 20, x1 = 780, yTop = TOP_H + 50, yBot = TAB_Y - 70;
  int colW = (x1 - x0) / n;
  int barW = colW * 6 / 10;
  if (barW > 140) barW = 140;
  auto yOf = [&](float r) { float f = r / SCALE; if (f > 1) f = 1; return yBot - (int)(f * (yBot - yTop)); };

  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextDatum(textdatum_t::top_left);
  fb.setTextColor(C_DIM);
  char s[64];
  snprintf(s, sizeof(s), "Nisbah ke paras latar   ambang %.1fx   jumlah knock %lu", th, (unsigned long)app.knock.totalKnock);
  fb.drawString(s, 20, TOP_H + 12);
  fb.setFont(&fonts::FreeSansBold9pt7b);
  button(680, TOP_H + 6, 110, 34, "RESET", B_RESET);

  // garisan ambang
  int yt = yOf(th);
  for (int x = x0; x < x1; x += 12) fb.drawFastHLine(x, yt, 6, C_KNOCK);

  Profile pp = p;
  for (int i = 0; i < n; i++) {
    const CylState &c = app.knock.s[i];
    int cx = x0 + colW * i + colW / 2;
    fb.fillRect(cx - barW / 2, yTop, barW, yBot - yTop, C_PANEL);
    int yb = yOf(c.peak);
    fb.fillRect(cx - barW / 2, yb, barW, yBot - yb, ratioColor(c.peak, th));
    fb.setTextDatum(textdatum_t::bottom_center);
    fb.setTextColor(C_TEXT);
    fb.setFont(&fonts::FreeSans9pt7b);
    snprintf(s, sizeof(s), "%.2f", c.ratio);
    fb.drawString(s, cx, yTop - 4);

    bool recent = c.lastKnockMs && millis() - c.lastKnockMs < 600;
    char lb[8];
    firingLabel(pp, i, app.wasted(), lb, sizeof(lb));
    int ly = yBot + 6;
    fb.fillRoundRect(cx - barW / 2, ly, barW, 34, 6, recent ? C_KNOCK : C_PANEL);
    fb.setFont(&fonts::FreeSansBold12pt7b);
    fb.setTextDatum(textdatum_t::middle_center);
    fb.setTextColor(recent ? TFT_BLACK : C_TEXT);
    snprintf(s, sizeof(s), "SIL %s", lb);
    fb.drawString(s, cx, ly + 17);
    fb.setFont(&fonts::FreeSans9pt7b);
    fb.setTextColor(c.count ? C_KNOCK : C_DIM);
    uint8_t ch = (profileCh2Mask(pp) >> i) & 1;
    snprintf(s, sizeof(s), "%lux  S%d  %umV", (unsigned long)c.count, ch + 1, c.lastMv);
    fb.drawString(s, cx, ly + 48);
  }
  const CylState &ns = app.knock.s[KnockEngine::SLOT_NOSYNC];
  if (ns.samples) {
    fb.setTextDatum(textdatum_t::top_left);
    fb.setTextColor(C_WARN);
    snprintf(s, sizeof(s), "Tanpa sync: %lu knock (silinder tidak diketahui)", (unsigned long)ns.count);
    fb.drawString(s, 20, TOP_H + 32);
  }
}

// ---------------- PETA: RPM x MAP ----------------
static void drawMap() {
  constexpr int R = KnockEngine::RPM_BINS, M = KnockEngine::MAP_BINS;
  int gx = 70, gy = TOP_H + 14, cw = (790 - gx) / R, chh = 29;
  fb.setFont(&fonts::Font2);
  char s[16];
  for (int m = 0; m < M; m++) {
    int row = M - 1 - m;  // MAP tinggi di atas
    int y = gy + row * chh;
    fb.setTextDatum(textdatum_t::middle_right);
    fb.setTextColor(C_DIM);
    snprintf(s, sizeof(s), "%d", m * 30);
    fb.drawString(s, gx - 6, y + chh / 2);
    for (int r = 0; r < R; r++) {
      uint16_t v = app.knock.grid[m][r];
      uint16_t col = v == 0 ? C_PANEL : v < 3 ? C_WARN : v < 10 ? 0xFB20 : C_KNOCK;
      fb.fillRect(gx + r * cw + 1, y + 1, cw - 2, chh - 2, col);
      if (v) {
        fb.setTextDatum(textdatum_t::middle_center);
        fb.setTextColor(TFT_BLACK);
        snprintf(s, sizeof(s), "%u", v);
        fb.drawString(s, gx + r * cw + cw / 2, y + chh / 2);
      }
    }
  }
  int yb = gy + M * chh + 4;
  fb.setTextColor(C_DIM);
  fb.setTextDatum(textdatum_t::top_center);
  for (int r = 0; r < R; r += 2) {
    snprintf(s, sizeof(s), "%dk", r / 2);
    fb.drawString(s, gx + r * cw, yb);
  }
  fb.setTextDatum(textdatum_t::top_left);
  fb.drawString(app.sigOk(SIG_MAP) ? "kPa / rpm   (bilangan knock)" : "MAP belum diset dari CAN: semua knock di baris 0", gx, yb + 18);
}

// ---------------- LOG ----------------
static void drawLog() {
  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextDatum(textdatum_t::top_left);
  int y = TOP_H + 10;
  fb.setTextColor(C_DIM);
  const int cols[] = {20, 130, 240, 340, 450, 560};
  const char *hdr[] = {"Masa", "Silinder", "Nisbah", "RPM", "MAP kPa", "Timing"};
  for (int i = 0; i < 6; i++) fb.drawString(hdr[i], cols[i], y);
  y += 28;
  fb.drawFastHLine(20, y - 6, 760, C_LINE);
  char s[24];
  Profile pp = app.cur();
  for (int i = 0; i < 11; i++) {
    const LogEntry *e = app.knock.logAt(i);
    if (!e) break;
    fb.setTextColor(i == 0 ? C_KNOCK : C_TEXT);
    uint32_t t = e->ms / 100;
    snprintf(s, sizeof(s), "%lu:%02lu.%lu", (unsigned long)(t / 600), (unsigned long)(t / 10 % 60), (unsigned long)(t % 10));
    fb.drawString(s, cols[0], y);
    char lb[8];
    if (e->slot == KnockEngine::SLOT_NOSYNC) snprintf(lb, sizeof(lb), "?");
    else firingLabel(pp, e->slot, e->wasted, lb, sizeof(lb));
    snprintf(s, sizeof(s), "SIL %s", lb); fb.drawString(s, cols[1], y);
    snprintf(s, sizeof(s), "%.2fx", e->ratio); fb.drawString(s, cols[2], y);
    snprintf(s, sizeof(s), "%u", e->rpm); fb.drawString(s, cols[3], y);
    if (e->mapOk) snprintf(s, sizeof(s), "%.0f", e->map); else snprintf(s, sizeof(s), "-");
    fb.drawString(s, cols[4], y);
    if (e->advOk) snprintf(s, sizeof(s), "%.1f deg", e->adv); else snprintf(s, sizeof(s), "-");
    fb.drawString(s, cols[5], y);
    y += 30;
  }
  if (!app.knock.logCount) { fb.setTextColor(C_DIM); fb.drawString("Belum ada knock direkod", 20, y); }
}

// ---------------- CAN sniff ----------------
static void drawCan() {
  fb.setFont(&fonts::Font2);
  fb.setTextDatum(textdatum_t::top_left);
  char s[64];
  fb.setTextColor(C_DIM);
  snprintf(s, sizeof(s), "%d ID   %lu bingkai   %u kbps   ralat bas %lu", app.sniffN, (unsigned long)app.canRx,
           (unsigned)kp::CAN_KBPS, (unsigned long)app.canErr);
  fb.drawString(s, 20, TOP_H + 10);
  fb.setFont(&fonts::FreeSansBold9pt7b);
  button(620, TOP_H + 4, 80, 30, "ATAS", B_CAN_UP);
  button(710, TOP_H + 4, 80, 30, "BAWAH", B_CAN_DN);
  fb.setFont(&fonts::FreeMono9pt7b);
  const int ROWS = 11;
  if (canScroll > app.sniffN - ROWS) canScroll = app.sniffN - ROWS;
  if (canScroll < 0) canScroll = 0;
  int y = TOP_H + 42;
  for (int i = canScroll; i < app.sniffN && i < canScroll + ROWS; i++) {
    const SniffEntry &e = app.sniff[i];
    bool mine = e.id == kp::ID_EVENT || e.id == kp::ID_STATUS || e.id == kp::ID_CONFIG;
    bool used = false;
    for (int k = 0; k < SIG_N; k++) used |= app.sig[k].en && app.sig[k].id == e.id;
    fb.setTextColor(mine ? C_ACC : used ? C_OK : C_TEXT);
    int n = snprintf(s, sizeof(s), e.ext ? "%08lX" : "     %03lX", (unsigned long)e.id);
    n += snprintf(s + n, sizeof(s) - n, " [%u] ", e.dlc);
    for (int b = 0; b < e.dlc && n < (int)sizeof(s) - 4; b++) n += snprintf(s + n, sizeof(s) - n, "%02X ", e.data[b]);
    fb.drawString(s, 20, y);
    snprintf(s, sizeof(s), "%6.1f Hz", e.hz);
    fb.drawString(s, 640, y);
    y += 29;
  }
  if (!app.sniffN) { fb.setTextColor(C_DIM); fb.drawString("Tiada trafik CAN. Semak wayar CAN-H/CAN-L & kadar bit.", 20, y); }
}

// ---------------- TETAPAN ----------------
static void row(int x, int y, const char *label, const char *value, uint16_t idM, uint16_t idP) {
  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(C_DIM);
  fb.drawString(label, x, y + 12);
  fb.setTextColor(C_TEXT);
  fb.setFont(&fonts::FreeSansBold9pt7b);
  fb.drawString(value, x, y + 36);
  fb.setFont(&fonts::FreeSansBold12pt7b);
  if (idM) button(x + 250, y + 6, 60, 46, "-", idM);
  if (idP) button(x + 320, y + 6, 60, 46, "+", idP);
}

static void drawSet() {
  Profile &p = app.cur();
  char v[48];
  int L = 14, Rx = 410, y0 = TOP_H + 4, dy = 60;

  snprintf(v, sizeof(v), "P%d: %s", app.active + 1, p.name);
  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(C_DIM);
  fb.drawString("Profil", L, y0 + 12);
  fb.setTextColor(C_TEXT);
  fb.setFont(&fonts::FreeSansBold9pt7b);
  fb.drawString(v, L, y0 + 36);
  fb.setFont(&fonts::FreeSansBold12pt7b);
  button(L + 250, y0 + 6, 60, 46, "<", B_PROF_PREV);
  button(L + 320, y0 + 6, 60, 46, ">", B_PROF_NEXT);

  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(C_DIM);
  fb.drawString("Jenis enjin (firing order)", L, y0 + dy + 12);
  fb.setFont(&fonts::FreeSansBold9pt7b);
  snprintf(v, sizeof(v), "Tukar ke: %s", PRESETS[presetIdx].name);
  button(L, y0 + dy + 24, 380, 34, v, B_PRESET);

  snprintf(v, sizeof(v), "%u mm  (anggaran %.1f kHz)", p.boreMm, kp::knockFreqKhz(p.boreMm));
  row(L, y0 + dy * 2, "Bore", v, B_BORE_M, B_BORE_P);
  snprintf(v, sizeof(v), "%.2f kHz  %s", kp::BANDPASS_KHZ[profileFreqIdx(p)], p.freqAuto ? "(AUTO)" : "(manual)");
  row(L, y0 + dy * 3, "Frekuensi bandpass", v, B_FREQ_M, B_FREQ_P);
  snprintf(v, sizeof(v), "%.3fx  (indeks %u)", kp::GAIN[p.gainIdx], p.gainIdx);
  row(L, y0 + dy * 4, "Gain", v, B_GAIN_M, B_GAIN_P);

  snprintf(v, sizeof(v), "%u deg selepas spark", p.winStart);
  row(Rx, y0, "Tetingkap mula", v, B_WS_M, B_WS_P);
  snprintf(v, sizeof(v), "%u deg", p.winLen);
  row(Rx, y0 + dy, "Tetingkap panjang", v, B_WL_M, B_WL_P);
  snprintf(v, sizeof(v), "%.1fx paras latar", p.threshold10 / 10.0f);
  row(Rx, y0 + dy * 2, "Ambang knock", v, B_TH_M, B_TH_P);
  snprintf(v, sizeof(v), "%u rpm", p.minRpm);
  row(Rx, y0 + dy * 3, "RPM minimum", v, B_MR_M, B_MR_P);

  fb.setFont(&fonts::FreeSansBold9pt7b);
  int y4 = y0 + dy * 4 + 6;
  snprintf(v, sizeof(v), "%u sensor", p.sensors);
  button(Rx, y4, 120, 46, v, B_SENS);
  button(Rx + 130, y4, 120, 46, p.tachoRising ? "Tacho: naik" : "Tacho: jatuh", B_EDGE);
  button(Rx + 260, y4, 120, 46, app.demo ? "Demo: ON" : "Demo: OFF", B_DEMO, app.demo ? C_ACC : C_PANEL, app.demo ? TFT_BLACK : C_TEXT);

  // baris bawah
  int yb = y0 + dy * 5 + 8;
  fb.setFont(&fonts::FreeSans9pt7b);
  fb.setTextDatum(textdatum_t::middle_left);
  fb.setTextColor(C_DIM);
  int n = snprintf(v, sizeof(v), "Firing: ");
  for (int i = 0; i < p.cyl; i++) n += snprintf(v + n, sizeof(v) - n, i ? "-%u" : "%u", p.order[i]);
  fb.drawString(v, L, yb + 10);
  snprintf(v, sizeof(v), "Node: %s  hilang %lu", app.node.online() ? "online" : "offline", (unsigned long)app.node.lost);
  fb.drawString(v, L, yb + 34);
  fb.setFont(&fonts::FreeSansBold12pt7b);
  button(Rx + 130, yb, 250, 46, app.dirty ? "SIMPAN *" : "SIMPAN", B_SAVE, app.dirty ? C_WARN : C_PANEL, app.dirty ? TFT_BLACK : C_TEXT);
}

// ---------------- Sentuhan ----------------
template <typename T> static void step(T &v, int d, int lo, int hi) { int x = (int)v + d; v = (T)(x < lo ? lo : x > hi ? hi : x); }

static void onButton(uint16_t id) {
  if (id >= B_TAB0 && id < B_TAB0 + P_N) { page = id - B_TAB0; return; }
  Lock l;
  Profile &p = app.cur();
  bool changed = true, nodeCfg = true;
  switch (id) {
    case B_RESET: app.knock.reset(); changed = nodeCfg = false; break;
    case B_CAN_UP: canScroll -= 10; changed = nodeCfg = false; break;
    case B_CAN_DN: canScroll += 10; changed = nodeCfg = false; break;
    case B_PROF_PREV: app.active = (app.active + NUM_PROFILES - 1) % NUM_PROFILES; app.knock.reset(); break;
    case B_PROF_NEXT: app.active = (app.active + 1) % NUM_PROFILES; app.knock.reset(); break;
    case B_PRESET:
      applyPreset(p, presetIdx);
      presetIdx = (presetIdx + 1) % NUM_PRESETS;
      app.knock.reset();
      break;
    case B_BORE_M: step(p.boreMm, -1, 50, 140); break;
    case B_BORE_P: step(p.boreMm, +1, 50, 140); break;
    case B_FREQ_M: case B_FREQ_P:
      if (p.freqAuto) { p.freqIdx = profileFreqIdx(p); p.freqAuto = 0; }
      step(p.freqIdx, id == B_FREQ_M ? -1 : 1, 0, 63);
      break;
    case B_GAIN_M: step(p.gainIdx, +1, 0, 63); break;  // indeks naik = gain turun
    case B_GAIN_P: step(p.gainIdx, -1, 0, 63); break;
    case B_WS_M: step(p.winStart, -2, 0, 90); break;
    case B_WS_P: step(p.winStart, +2, 0, 90); break;
    case B_WL_M: step(p.winLen, -5, 10, 120); break;
    case B_WL_P: step(p.winLen, +5, 10, 120); break;
    case B_TH_M: step(p.threshold10, -1, 11, 60); nodeCfg = false; break;
    case B_TH_P: step(p.threshold10, +1, 11, 60); nodeCfg = false; break;
    case B_MR_M: step(p.minRpm, -100, 0, 8000); nodeCfg = false; break;
    case B_MR_P: step(p.minRpm, +100, 0, 8000); nodeCfg = false; break;
    case B_SENS: p.sensors = p.sensors == 1 ? 2 : 1; break;
    case B_EDGE: p.tachoRising ^= 1; break;
    case B_DEMO: app.demo = !app.demo; nodeCfg = false; break;
    case B_SAVE: changed = nodeCfg = false; break;
    default: changed = nodeCfg = false;
  }
  if (changed) app.dirty = true;
  if (nodeCfg) sendNodeConfig();
}

static void pollTouch() {
  static bool wasDown;
  static uint32_t lastPress;
  int32_t x, y;
  bool down = lcd.getTouch(&x, &y) > 0;
  if (down && !wasDown && millis() - lastPress > 150) {
    lastPress = millis();
    for (int i = 0; i < nBtn; i++) {
      const Btn &b = btns[i];
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
        if (b.id == B_SAVE) saveAll(); else onButton(b.id);
        break;
      }
    }
  }
  wasDown = down;
}

void uiInit() {
  lcd.init();
  lcd.setRotation(0);
  lcd.fillScreen(TFT_BLACK);
  fb.setColorDepth(16);
  fb.setPsram(true);
  if (!fb.createSprite(800, 480)) Serial.println("UI: gagal buat sprite (PSRAM?)");
}

void uiLoop() {
  static uint32_t lastFrame, lastDecay;
  pollTouch();
  uint32_t now = millis();
  if (now - lastFrame < 66) return;  // ~15 fps
  lastFrame = now;
  {
    Lock l;
    if (now - lastDecay >= 100) { lastDecay = now; app.knock.decay(); }
    nBtn = 0;
    fb.fillScreen(C_BG);
    drawTop();
    switch (page) {
      case P_LIVE: drawLive(); break;
      case P_MAP: drawMap(); break;
      case P_LOG: drawLog(); break;
      case P_CAN: drawCan(); break;
      case P_SET: drawSet(); break;
    }
    drawTabs();
  }
  fb.pushSprite(0, 0);
}
