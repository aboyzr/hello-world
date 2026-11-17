// Skrin knock: Waveshare ESP32-S3-Touch-LCD-4.3
// - Terima hasil modul sensor knock + data ECU (MyEFI) dari bas CAN yang sama
// - Kesan knock setiap silinder, peta RPM x MAP, log, sniff CAN
// - Konsol Serial (port UART, 115200) untuk set ID CAN ECU
#include <Arduino.h>
#include <Preferences.h>
#include "driver/twai.h"
#include "app.h"
#include "board.h"

App app;
static Preferences prefs;

// ---------------- Simpan / muat ----------------
void saveAll() {
  Lock l;
  for (int i = 0; i < NUM_PROFILES; i++) {
    char k[4] = {'p', char('0' + i), 0};
    prefs.putBytes(k, &app.prof[i], sizeof(Profile));
  }
  prefs.putUChar("act", app.active);
  prefs.putBytes("sig", app.sig, sizeof(app.sig));
  prefs.putBool("demo", app.demo);
  app.dirty = false;
}

static void loadAll() {
  for (int i = 0; i < NUM_PROFILES; i++) {
    char k[4] = {'p', char('0' + i), 0};
    Profile p;
    if (prefs.getBytes(k, &p, sizeof(p)) == sizeof(p) && profileValid(p)) app.prof[i] = p;
    else app.prof[i] = defaultProfile(i < NUM_PRESETS ? i : 2);
  }
  app.active = prefs.getUChar("act", 2) % NUM_PROFILES;
  memset(app.sig, 0, sizeof(app.sig));
  if (prefs.getBytes("sig", app.sig, sizeof(app.sig)) != sizeof(app.sig)) memset(app.sig, 0, sizeof(app.sig));
  app.demo = prefs.getBool("demo", true);
}

// ---------------- CAN ----------------
static bool canInit() {
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT((gpio_num_t)board::CAN_TX, (gpio_num_t)board::CAN_RX, TWAI_MODE_NORMAL);
  g.rx_queue_len = 64;
  g.tx_queue_len = 8;
  twai_timing_config_t t500 = TWAI_TIMING_CONFIG_500KBITS();
  twai_timing_config_t t250 = TWAI_TIMING_CONFIG_250KBITS();
  twai_timing_config_t t1m  = TWAI_TIMING_CONFIG_1MBITS();
  twai_timing_config_t t = kp::CAN_KBPS == 1000 ? t1m : kp::CAN_KBPS == 250 ? t250 : t500;
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  return twai_driver_install(&g, &t, &f) == ESP_OK && twai_start() == ESP_OK;
}

void sendNodeConfig() { app.configPending = true; }

static void doSendConfig() {
  kp::NodeConfig c;
  { Lock l; c = profileToNode(app.cur()); }
  twai_message_t m = {};
  m.identifier = kp::ID_CONFIG;
  m.data_length_code = 8;
  kp::packConfig(c, m.data);
  twai_transmit(&m, 0);
}

// Node lapor config berbeza dari profil aktif? (cth node baru dihidupkan)
static bool nodeConfigMismatch() {
  kp::NodeConfig c = profileToNode(app.cur());
  const NodeStatus &n = app.node;
  return n.online() && (n.cyl != c.cylinders || n.freqIdx != c.freqIdx || n.gainIdx != c.gainIdx ||
                        n.winStart != c.winStartDeg || n.winLen != c.winLenDeg);
}

static void sniffUpdate(const twai_message_t &m, uint32_t now) {
  int i = 0;
  while (i < app.sniffN && app.sniff[i].id != m.identifier) i++;
  if (i == app.sniffN) {
    if (app.sniffN >= SNIFF_N) return;
    // simpan tersusun ikut ID
    i = 0;
    while (i < app.sniffN && app.sniff[i].id < m.identifier) i++;
    memmove(&app.sniff[i + 1], &app.sniff[i], (app.sniffN - i) * sizeof(SniffEntry));
    app.sniffN++;
    memset(&app.sniff[i], 0, sizeof(SniffEntry));
    app.sniff[i].id = m.identifier;
    app.sniff[i].winStart = now;
  }
  SniffEntry &e = app.sniff[i];
  e.dlc = m.data_length_code;
  e.ext = m.extd;
  memcpy(e.data, m.data, 8);
  e.count++;
  e.winCount++;
  if (now - e.winStart >= 1000) {
    e.hz = e.winCount * 1000.0f / (now - e.winStart);
    e.winCount = 0;
    e.winStart = now;
  }
}

static void handleFrame(const twai_message_t &m) {
  uint32_t now = millis();
  Lock l;
  app.canRx++;
  sniffUpdate(m, now);
  if (m.rtr) return;
  if (m.identifier == kp::ID_STATUS && m.data_length_code == 8) {
    NodeStatus &n = app.node;
    n.lastMs = now; n.flags = m.data[0]; n.cyl = m.data[1]; n.rpm = m.data[2] | (m.data[3] << 8);
    n.freqIdx = m.data[4]; n.gainIdx = m.data[5]; n.winStart = m.data[6]; n.winLen = m.data[7];
    return;
  }
  if (m.identifier == kp::ID_EVENT && m.data_length_code == 8) {
    kp::Event e = kp::unpackEvent(m.data);
    NodeStatus &n = app.node;
    if (n.events) n.lost += (uint8_t)(e.seq - n.lastSeq - 1);
    n.lastSeq = e.seq;
    n.events++;
    n.flags = e.flags;
    n.rpm = e.rpm;
    bool k = app.knock.onEvent(app.cur(), e.firing, e.flags & kp::ST_WASTED, e.level, e.rpm,
                               app.sigVal[SIG_MAP], app.sigOk(SIG_MAP), app.sigVal[SIG_ADV], app.sigOk(SIG_ADV), now);
    if (k) app.lastKnockMs = now;
    return;
  }
  for (int i = 0; i < SIG_N; i++) {
    float v;
    if (!m.extd && decodeSig(app.sig[i], m.identifier, m.data_length_code, m.data, v)) {
      app.sigVal[i] = v;
      app.sigMs[i] = now;
    }
  }
}

static void canTask(void *) {
  uint32_t lastCfg = 0;
  for (;;) {
    twai_message_t m;
    while (twai_receive(&m, pdMS_TO_TICKS(10)) == ESP_OK) handleFrame(m);
    twai_status_info_t st;
    if (twai_get_status_info(&st) == ESP_OK) {
      if (st.state == TWAI_STATE_BUS_OFF) { app.canErr++; twai_initiate_recovery(); }
      else if (st.state == TWAI_STATE_STOPPED) twai_start();
    }
    uint32_t now = millis();
    bool mismatch;
    { Lock l; mismatch = nodeConfigMismatch(); }
    if ((app.configPending || mismatch) && now - lastCfg > 300) {
      lastCfg = now;
      app.configPending = false;
      doSendConfig();
    }
  }
}

// ---------------- Mod demo (tiada node disambung) ----------------
static void demoTick() {
  static uint32_t last;
  static float t;
  static uint8_t fi;
  uint32_t now = millis();
  if (!app.demo || app.node.online() || now - last < 8) return;
  last = now;
  t += 0.004f;
  Lock l;
  Profile &p = app.cur();
  uint16_t rpm = 3500 + 2800 * sinf(t);
  float map = 100 + 90 * sinf(t * 0.7f);
  app.sigVal[SIG_RPM] = rpm; app.sigMs[SIG_RPM] = now;
  app.sigVal[SIG_MAP] = map; app.sigMs[SIG_MAP] = now;
  app.sigVal[SIG_ADV] = 30 - map / 10; app.sigMs[SIG_ADV] = now;
  fi = (fi + 1) % p.cyl;
  uint16_t mv = 400 + random(0, 90) + rpm / 40;
  // silinder di kedudukan pembakaran ke-2 knock bila beban & rpm tinggi
  if (fi == 1 % p.cyl && map > 170 && rpm > 4000 && random(0, 100) < 25) mv *= 2.6f;
  if (app.knock.onEvent(p, fi, false, mv, rpm, map, true, app.sigVal[SIG_ADV], true, now)) app.lastKnockMs = now;
}

// ---------------- Konsol Serial ----------------
static void printSigs() {
  for (int i = 0; i < SIG_N; i++) {
    const CanSig &s = app.sig[i];
    if (!s.en) Serial.printf("  %-4s off\n", SIG_NAME[i]);
    else Serial.printf("  %-4s id 0x%03X bait %u len %u %s %s skala %g offset %g  -> %.2f %s\n", SIG_NAME[i], s.id, s.start,
                       s.len, s.be ? "be" : "le", s.sgn ? "s" : "u", s.scale, s.offset, app.sigVal[i], SIG_UNIT[i]);
  }
}

static void console(char *line) {
  char *argv[10];
  int argc = 0;
  for (char *tok = strtok(line, " \t"); tok && argc < 10; tok = strtok(nullptr, " \t")) argv[argc++] = tok;
  if (!argc) return;
  String cmd = argv[0];
  if (cmd == "help") {
    Serial.println("Arahan:\n"
                   "  sig                                  senarai isyarat ECU\n"
                   "  sig <nama> <id> <bait> <len> <be|le> <u|s> <skala> <offset>\n"
                   "      cth: sig map 0x5F0 2 2 be u 0.1 0\n"
                   "  sig <nama> off                       nama: rpm map adv afr clt tps\n"
                   "  sniff                                senarai ID CAN yang dilihat\n"
                   "  demo on|off                          mod demo bila tiada node\n"
                   "  reset                                kosongkan kiraan knock\n"
                   "  save                                 simpan ke memori");
  } else if (cmd == "sig") {
    if (argc == 1) { printSigs(); return; }
    int i = 0;
    while (i < SIG_N && strcmp(argv[1], SIG_NAME[i])) i++;
    if (i == SIG_N) { Serial.println("Nama isyarat tidak dikenali"); return; }
    Lock l;
    CanSig &s = app.sig[i];
    if (argc == 3 && !strcmp(argv[2], "off")) { s.en = 0; app.dirty = true; Serial.println("OK (jangan lupa save)"); return; }
    if (argc != 9) { Serial.println("Format: sig <nama> <id> <bait> <len> <be|le> <u|s> <skala> <offset>"); return; }
    CanSig n;
    n.id = strtoul(argv[2], nullptr, 0); n.start = atoi(argv[3]); n.len = atoi(argv[4]);
    n.be = !strcmp(argv[5], "be"); n.sgn = !strcmp(argv[6], "s"); n.scale = atof(argv[7]); n.offset = atof(argv[8]); n.en = 1;
    if (n.id > 0x7FF || n.len < 1 || n.len > 2 || n.start + n.len > 8) { Serial.println("Nilai tidak sah"); return; }
    s = n;
    app.dirty = true;
    Serial.println("OK (jangan lupa save)");
  } else if (cmd == "sniff") {
    Lock l;
    for (int i = 0; i < app.sniffN; i++) {
      const SniffEntry &e = app.sniff[i];
      Serial.printf("  %03X [%u] ", e.id, e.dlc);
      for (int b = 0; b < e.dlc; b++) Serial.printf("%02X ", e.data[b]);
      Serial.printf(" %.1f Hz\n", e.hz);
    }
  } else if (cmd == "demo" && argc == 2) {
    app.demo = !strcmp(argv[1], "on");
    app.dirty = true;
    Serial.println(app.demo ? "Demo ON" : "Demo OFF");
  } else if (cmd == "reset") {
    Lock l;
    app.knock.reset();
    Serial.println("Kiraan dikosongkan");
  } else if (cmd == "save") {
    saveAll();
    Serial.println("Disimpan");
  } else Serial.println("Arahan tidak dikenali. Taip help");
}

static void serialPoll() {
  static char buf[128];
  static int n;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { buf[n] = 0; console(buf); n = 0; }
    else if (n < (int)sizeof(buf) - 1) buf[n++] = c;
  }
}

void setup() {
  Serial.begin(115200);
  app.lock = xSemaphoreCreateMutex();
  prefs.begin("knockdisp", false);
  loadAll();

  boardInit();
  uiInit();

  if (canInit()) xTaskCreatePinnedToCore(canTask, "can", 6144, nullptr, 5, nullptr, 0);
  else Serial.println("CAN: gagal mula");
  Serial.println("Skrin knock sedia. Taip help");
}

void loop() {
  serialPoll();
  demoTick();
  uiLoop();
}
