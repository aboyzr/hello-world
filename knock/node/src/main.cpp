// Modul sensor knock: ESP32-C3 + TPIC8101/HIP9011
// - Baca pulse tacho (satu pulse setiap pembakaran) dan pulse silinder 1 (klip induktif / trigger coil 1)
// - Buka tetingkap integrasi cip knock selepas setiap spark
// - Baca voltan INTOUT dengan ADC, hantar hasil ke skrin melalui CAN
#include <Arduino.h>
#include <SPI.h>
#include <Preferences.h>
#include "driver/twai.h"
#include "knock_proto.h"

// ---------------- Pin (ESP32-C3 SuperMini) ----------------
namespace pin {
constexpr int CAN_TX  = 0;   // ke SN65HVD230 D
constexpr int CAN_RX  = 1;   // ke SN65HVD230 R
constexpr int INTOUT  = 3;   // ADC1_CH3, INTOUT cip melalui pembahagi 10k/10k
constexpr int SCK     = 4;   // -> 74HCT125 -> SCK cip
constexpr int TACHO   = 5;   // dari optocoupler tacho (aktif rendah)
constexpr int MOSI    = 6;   // -> 74HCT125 -> SI cip
constexpr int CS      = 7;   // -> 74HCT125 -> CS cip
constexpr int LED     = 8;   // LED biru on-board (aktif rendah)
constexpr int CYL1    = 10;  // dari pemprosesan klip induktif silinder 1 (aktif rendah)
constexpr int INTHOLD = 21;  // -> 74HCT125 -> INT/HOLD cip
}

constexpr float   INTOUT_DIVIDER = 2.0f;  // pembahagi 10k/10k
// Sisi pulse silinder 1 yang menandakan SPARK:
//   klip induktif + NPN  -> FALLING
//   trigger coil 1 (logik 5V) melalui PC817 -> RISING (spark = trigger jatuh, opto menyongsangkan)
constexpr int     CYL1_EDGE      = FALLING;
constexpr uint8_t PRESCALER_CMD  = 0x40 | (0b0000 << 1) | 1;  // kristal 4 MHz, SO high-Z (kita tak baca SO)
constexpr uint16_t TAU_US[32] = {40,  45,  50,  55,  60,  65,  70,  75,  80,  90,  100, 110, 120, 130, 140, 150,
                                 160, 180, 200, 220, 240, 260, 280, 300, 320, 360, 400, 440, 480, 520, 560, 600};

static kp::NodeConfig cfg;
static Preferences prefs;
static SPIClass spi(FSPI);
static hw_timer_t *winTimer;
static TaskHandle_t knockTask;

// Keadaan yang dikongsi dengan ISR
static volatile uint32_t lastTachoUs, tachoPeriodUs, lastCyl1Us;
static volatile uint8_t  firingIdx;              // indeks pembakaran semasa (0 = silinder 1)
static volatile uint8_t  firingsSinceCyl1 = 255; // berapa pembakaran sejak pulse silinder 1 terakhir
static volatile uint8_t  cyl1Gap;                // jarak (pembakaran) antara dua pulse silinder 1
static volatile uint8_t  winState;               // 0 rehat, 1 tunggu mula, 2 sedang integrasi
static volatile uint32_t winLenUs;
static volatile uint8_t  doneFiring, doneChannel;
static volatile uint8_t  curChannel;

static uint16_t lastMv;
static uint8_t  seq;

static bool syncOk() {
  uint8_t n = cfg.cylinders;
  return firingsSinceCyl1 <= 2 * n && (cyl1Gap == n || (n % 2 == 0 && cyl1Gap == n / 2));
}
static bool wasted() { return cfg.cylinders % 2 == 0 && cyl1Gap == cfg.cylinders / 2; }

static uint16_t rpmNow() {
  uint32_t p = tachoPeriodUs;
  if (!p || micros() - lastTachoUs > 500000) return 0;
  return (uint16_t)min<uint32_t>(65535, 120000000UL / (p * cfg.cylinders));
}

// ---------------- Cip knock (SPI, tulis sahaja) ----------------
static void chipWrite(uint8_t cmd) {
  spi.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE1));
  digitalWrite(pin::CS, LOW);
  spi.transfer(cmd);
  digitalWrite(pin::CS, HIGH);
  spi.endTransaction();
}

static uint8_t tauIdxFor(uint32_t windowUs) {
  uint32_t want = windowUs / 10;  // tc ~ tint/10: output tak tepu, masih cukup besar
  for (uint8_t i = 0; i < 32; i++) if (TAU_US[i] >= want) return i;
  return 31;
}

static void chipConfigure() {
  chipWrite(PRESCALER_CMD);
  chipWrite(0x00 | (cfg.freqIdx & 0x3F));  // bandpass
  chipWrite(0x80 | (cfg.gainIdx & 0x3F));  // gain
  chipWrite(0xC0 | 20);                    // integrator 240 us (dikemas kini setiap kitaran)
  chipWrite(0xE0 | 0);                     // channel 0
  curChannel = 0;
}

// ---------------- ISR ----------------
static void IRAM_ATTR onTacho() {
  uint32_t now = micros();
  uint32_t dt = now - lastTachoUs;
  if (dt < 1500) return;                                   // > 10000 rpm: hingar
  if (tachoPeriodUs && dt < tachoPeriodUs / 2) return;     // deringan / hingar
  lastTachoUs = now;
  tachoPeriodUs = dt > 400000 ? 0 : dt;                    // < ~75 rpm: anggap enjin baru hidup
  if (tachoPeriodUs && now - lastCyl1Us < tachoPeriodUs / 3) firingIdx = 0;
  else firingIdx = (firingIdx + 1) % cfg.cylinders;
  if (firingsSinceCyl1 < 255) firingsSinceCyl1++;
  if (!tachoPeriodUs) return;

  // darjah crank ke mikrosaat: satu pembakaran = 720/n darjah
  uint32_t perCycle = tachoPeriodUs * cfg.cylinders;       // us untuk 720 darjah
  uint32_t startUs = max<uint32_t>(30, perCycle * cfg.winStartDeg / 720);
  winLenUs = max<uint32_t>(100, perCycle * cfg.winLenDeg / 720);
  if (winState == 2) digitalWrite(pin::INTHOLD, LOW);
  winState = 1;
  timerWrite(winTimer, 0);
  timerAlarmWrite(winTimer, startUs, false);
  timerAlarmEnable(winTimer);
}

static void IRAM_ATTR onCyl1() {
  uint32_t now = micros();
  if (now - lastCyl1Us < 3000) return;  // deringan klip induktif
  if (firingsSinceCyl1 != 255) cyl1Gap = firingsSinceCyl1;
  lastCyl1Us = now;
  if (tachoPeriodUs && now - lastTachoUs < tachoPeriodUs / 3) firingIdx = 0;  // tacho datang dulu
  firingsSinceCyl1 = 0;
}

static void IRAM_ATTR onWinTimer() {
  if (winState == 1) {
    digitalWrite(pin::INTHOLD, HIGH);
    winState = 2;
    timerWrite(winTimer, 0);
    timerAlarmWrite(winTimer, winLenUs, false);
    timerAlarmEnable(winTimer);
  } else if (winState == 2) {
    digitalWrite(pin::INTHOLD, LOW);
    winState = 0;
    doneFiring = syncOk() ? firingIdx : kp::NO_SYNC;
    doneChannel = curChannel;
    BaseType_t hp = pdFALSE;
    vTaskNotifyGiveFromISR(knockTask, &hp);
    if (hp) { portYIELD_FROM_ISR(); }
  }
}

// ---------------- CAN ----------------
static void canInit() {
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT((gpio_num_t)pin::CAN_TX, (gpio_num_t)pin::CAN_RX, TWAI_MODE_NORMAL);
  g.tx_queue_len = 16;
  g.rx_queue_len = 16;
  twai_timing_config_t t500 = TWAI_TIMING_CONFIG_500KBITS();
  twai_timing_config_t t250 = TWAI_TIMING_CONFIG_250KBITS();
  twai_timing_config_t t1m  = TWAI_TIMING_CONFIG_1MBITS();
  twai_timing_config_t t = kp::CAN_KBPS == 1000 ? t1m : kp::CAN_KBPS == 250 ? t250 : t500;
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) == ESP_OK) twai_start();
  else Serial.println("CAN: gagal install driver");
}

static void canSend(uint32_t id, const uint8_t d[8]) {
  twai_message_t m = {};
  m.identifier = id;
  m.data_length_code = 8;
  memcpy(m.data, d, 8);
  twai_transmit(&m, 0);  // jangan tunggu: kalau penuh, buang
}

static uint8_t statusFlags() {
  uint8_t f = 0;
  if (syncOk()) f |= kp::ST_SYNC;
  if (wasted()) f |= kp::ST_WASTED;
  if (lastMv > 50) f |= kp::ST_CHIP;
  if (rpmNow()) f |= kp::ST_TACHO;
  return f;
}

static void canService() {
  twai_status_info_t st;
  if (twai_get_status_info(&st) == ESP_OK) {
    if (st.state == TWAI_STATE_BUS_OFF) twai_initiate_recovery();
    else if (st.state == TWAI_STATE_STOPPED) twai_start();
  }
  twai_message_t m;
  while (twai_receive(&m, 0) == ESP_OK) {
    if (m.identifier != kp::ID_CONFIG || m.data_length_code != 8) continue;
    kp::NodeConfig c;
    if (!kp::unpackConfig(m.data, c)) continue;
    if (memcmp(&c, &cfg, sizeof(c)) == 0) continue;
    cfg = c;
    firingIdx = 0;
    chipConfigure();
    prefs.putBytes("cfg", &cfg, sizeof(cfg));
    Serial.printf("Config baru: %d sil, freq %.2f kHz, gain %d, tetingkap %d+%d deg, ch2 0x%02X\n", cfg.cylinders,
                  kp::BANDPASS_KHZ[cfg.freqIdx], cfg.gainIdx, cfg.winStartDeg, cfg.winLenDeg, cfg.ch2Mask);
  }
}

// ---------------- Tugas knock: baca ADC selepas HOLD ----------------
static void knockLoop(void *) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    delayMicroseconds(25);  // datasheet: ~20 us sebelum cip masuk HOLD
    uint8_t firing = doneFiring, ch = doneChannel;
    uint32_t mv = (uint32_t)(analogReadMilliVolts(pin::INTOUT) * INTOUT_DIVIDER);
    lastMv = mv;

    kp::Event e;
    e.firing = firing; e.channel = ch; e.level = mv; e.rpm = rpmNow(); e.seq = seq++; e.flags = statusFlags();
    uint8_t d[8];
    kp::packEvent(e, d);
    canSend(kp::ID_EVENT, d);

    // Program cip semasa HOLD untuk pembakaran seterusnya
    uint8_t next = firing == kp::NO_SYNC ? 0 : (firing + 1) % cfg.cylinders;
    uint8_t nch = (cfg.ch2Mask >> next) & 1;
    if (firing == kp::NO_SYNC) nch = (cfg.ch2Mask != 0) ? (ch ^ 1) : 0;  // tiada sync: selang-seli channel
    chipWrite(0xE0 | nch);
    curChannel = nch;
    chipWrite(0xC0 | tauIdxFor(winLenUs));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(pin::LED, OUTPUT);
  digitalWrite(pin::LED, HIGH);
  pinMode(pin::INTHOLD, OUTPUT);
  digitalWrite(pin::INTHOLD, LOW);
  pinMode(pin::CS, OUTPUT);
  digitalWrite(pin::CS, HIGH);
  pinMode(pin::TACHO, INPUT_PULLUP);
  pinMode(pin::CYL1, INPUT_PULLUP);
  analogSetPinAttenuation(pin::INTOUT, ADC_11db);

  prefs.begin("knock", false);
  kp::NodeConfig saved;
  if (prefs.getBytes("cfg", &saved, sizeof(saved)) == sizeof(saved)) cfg = saved;

  spi.begin(pin::SCK, -1, pin::MOSI, -1);
  chipConfigure();
  canInit();

  xTaskCreate(knockLoop, "knock", 4096, nullptr, configMAX_PRIORITIES - 2, &knockTask);

  winTimer = timerBegin(0, 80, true);  // 1 tick = 1 us
  timerAttachInterrupt(winTimer, &onWinTimer, true);
  attachInterrupt(pin::TACHO, onTacho, cfg.tachoRising ? RISING : FALLING);
  attachInterrupt(pin::CYL1, onCyl1, CYL1_EDGE);
  Serial.println("Modul knock sedia");
}

void loop() {
  static uint32_t tStatus, tPrint;
  static uint8_t lastEdge = 0;
  canService();
  if (cfg.tachoRising != lastEdge) {  // tukar sisi pulse tacho bila config berubah
    lastEdge = cfg.tachoRising;
    attachInterrupt(pin::TACHO, onTacho, cfg.tachoRising ? RISING : FALLING);
  }
  uint32_t now = millis();
  if (now - tStatus >= 200) {
    tStatus = now;
    uint16_t rpm = rpmNow();
    uint8_t d[8] = {statusFlags(), cfg.cylinders, (uint8_t)(rpm & 0xFF), (uint8_t)(rpm >> 8),
                    cfg.freqIdx, cfg.gainIdx, cfg.winStartDeg, cfg.winLenDeg};
    canSend(kp::ID_STATUS, d);
    // LED: menyala tetap bila sync, berkelip bila ada tacho tanpa sync
    bool on = syncOk() || (rpm && (now / 200) % 2);
    digitalWrite(pin::LED, on ? LOW : HIGH);
  }
  if (now - tPrint >= 1000) {
    tPrint = now;
    Serial.printf("rpm %u  sync %d  gap %u  INTOUT %u mV\n", rpmNow(), syncOk(), cyl1Gap, lastMv);
  }
  delay(2);
}
