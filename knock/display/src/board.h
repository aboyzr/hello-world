// Waveshare ESP32-S3-Touch-LCD-4.3 (800x480, ST7262 RGB, sentuh GT911, pengembang IO CH422G)
// Pin diambil dari konfigurasi rasmi ESP32_Display_Panel (BOARD_WAVESHARE_ESP32_S3_TOUCH_LCD_4_3).
#pragma once
#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include <lgfx/v1/platforms/esp32s3/Panel_RGB.hpp>
#include <lgfx/v1/platforms/esp32s3/Bus_RGB.hpp>

namespace board {
constexpr int I2C_SDA = 8, I2C_SCL = 9;  // dikongsi: sentuh GT911 + CH422G
constexpr int TOUCH_INT = 4;
constexpr int CAN_TX = 20, CAN_RX = 19;  // transceiver CAN on-board (dikongsi dengan USB native)

// CH422G: alamat I2C 7-bit "arahan"
constexpr uint8_t CH422G_SET = 0x24;  // daftar sistem (bit0 = IO output enable)
constexpr uint8_t CH422G_OUT = 0x38;  // tulis IO0..IO7
// Bit EXIO
constexpr uint8_t EXIO_TP_RST = 1, EXIO_BL = 2, EXIO_LCD_RST = 3, EXIO_SD_CS = 4, EXIO_USB_SEL = 5;
// USB_SEL = 0: GPIO19/20 ke transceiver CAN (port USB native tidak berfungsi).
// Muat naik & log Serial melalui port USB "UART" (CH343).
constexpr int USB_SEL_FOR_CAN = 0;
}

class LGFX : public lgfx::LGFX_Device {
 public:
  lgfx::Bus_RGB _bus;
  lgfx::Panel_RGB _panel;
  lgfx::Touch_GT911 _touch;

  LGFX() {
    {
      auto cfg = _panel.config();
      cfg.memory_width = 800; cfg.memory_height = 480;
      cfg.panel_width = 800;  cfg.panel_height = 480;
      cfg.offset_x = 0; cfg.offset_y = 0;
      _panel.config(cfg);
    }
    {
      auto cfg = _panel.config_detail();
      cfg.use_psram = 1;
      _panel.config_detail(cfg);
    }
    {
      auto cfg = _bus.config();
      cfg.panel = &_panel;
      // B0..B4
      cfg.pin_d0 = GPIO_NUM_14; cfg.pin_d1 = GPIO_NUM_38; cfg.pin_d2 = GPIO_NUM_18; cfg.pin_d3 = GPIO_NUM_17; cfg.pin_d4 = GPIO_NUM_10;
      // G0..G5
      cfg.pin_d5 = GPIO_NUM_39; cfg.pin_d6 = GPIO_NUM_0; cfg.pin_d7 = GPIO_NUM_45; cfg.pin_d8 = GPIO_NUM_48; cfg.pin_d9 = GPIO_NUM_47; cfg.pin_d10 = GPIO_NUM_21;
      // R0..R4
      cfg.pin_d11 = GPIO_NUM_1; cfg.pin_d12 = GPIO_NUM_2; cfg.pin_d13 = GPIO_NUM_42; cfg.pin_d14 = GPIO_NUM_41; cfg.pin_d15 = GPIO_NUM_40;
      cfg.pin_henable = GPIO_NUM_5;
      cfg.pin_vsync = GPIO_NUM_3;
      cfg.pin_hsync = GPIO_NUM_46;
      cfg.pin_pclk = GPIO_NUM_7;
      cfg.freq_write = 16000000;
      cfg.hsync_polarity = 0; cfg.hsync_front_porch = 8; cfg.hsync_pulse_width = 4; cfg.hsync_back_porch = 8;
      cfg.vsync_polarity = 0; cfg.vsync_front_porch = 8; cfg.vsync_pulse_width = 4; cfg.vsync_back_porch = 8;
      cfg.pclk_active_neg = 1;
      cfg.de_idle_high = 0;
      cfg.pclk_idle_high = 0;
      _bus.config(cfg);
    }
    _panel.setBus(&_bus);
    {
      auto cfg = _touch.config();
      cfg.x_min = 0; cfg.x_max = 799; cfg.y_min = 0; cfg.y_max = 479;
      cfg.pin_int = board::TOUCH_INT;
      cfg.pin_rst = -1;  // reset melalui CH422G (lihat boardInit)
      cfg.bus_shared = false;
      cfg.offset_rotation = 0;
      cfg.i2c_port = 0;
      cfg.i2c_addr = 0x5D;
      cfg.pin_sda = board::I2C_SDA;
      cfg.pin_scl = board::I2C_SCL;
      cfg.freq = 400000;
      _touch.config(cfg);
      _panel.setTouch(&_touch);
    }
    setPanel(&_panel);
  }
};

// Mesti dipanggil SEBELUM lcd.init(): set CH422G, reset LCD & sentuh, hidupkan lampu latar, pilih CAN.
inline void boardInit() {
  using namespace board;
  lgfx::i2c::init(0, I2C_SDA, I2C_SCL);
  auto wr = [](uint8_t addr, uint8_t v) { lgfx::i2c::transactionWrite(0, addr, &v, 1, 400000); };
  auto out = [&](uint8_t bits) { wr(CH422G_OUT, bits); };
  wr(CH422G_SET, 0x01);  // IO0..7 sebagai output

  uint8_t base = (1 << EXIO_BL) | (1 << EXIO_SD_CS) | (USB_SEL_FOR_CAN << EXIO_USB_SEL);
  // INT sentuh rendah semasa reset -> alamat GT911 = 0x5D
  pinMode(TOUCH_INT, OUTPUT);
  digitalWrite(TOUCH_INT, LOW);
  out(base);                                          // LCD_RST & TP_RST rendah
  delay(20);
  out(base | (1 << EXIO_LCD_RST));                    // lepas reset LCD
  delay(100);
  out(base | (1 << EXIO_LCD_RST) | (1 << EXIO_TP_RST));  // lepas reset sentuh
  delay(200);
  pinMode(TOUCH_INT, INPUT);
}
