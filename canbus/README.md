# Aboy Canbus

App Android berasingan untuk membaca bas CAN kereta melalui port OBD2 dengan dongle Bluetooth
ELM327 (Classic atau BLE). Ia mengesan ID CAN, meneka atau mempelajari fungsi setiap ID, dan
memaparkan bacaan sensor dalam graf berserta ID, bait dan nilai hex mentah semasa.

Muat turun APK: https://github.com/aboyzr/hello-world/releases/download/canbus/AboyCanbus.apk
(terbit selepas kod digabung ke `master`).

## Bahasa
English (lalai) atau Bahasa Malaysia: tekan **EN / BM** di bahagian atas app. Pilihan disimpan, dan mesej
Bluetooth dari Android turut ikut bahasa dipilih. Teks ada dalam `i18n.js`.

## Tab
| Tab | Fungsi |
|---|---|
| **Graf** | Sehingga 4 sensor serentak, 30 saat terakhir. Isyarat CAN menunjukkan ID, bait, nilai mentah, formula dan Hz. PID standard OBD juga boleh dipilih. |
| **Sniff** | Semua bingkai di bas (`ATMA`): jadual ID, bait berubah diwarnakan, peranan bait (counter, checksum, analog, bit), tapis ID/mask, rakam dan eksport CSV. |
| **Kenal ID** | Label setiap ID dengan sumbernya: **Standard** (OBD/UDS 7DF/7E0–7EF, J1939), **DBC** (fail import), **Dipelajari**, **Sendiri**, **Tekaan** (dari corak data) atau **Belum dikenal**. Profil ikut kereta, import/eksport `.dbc`. |
| **Belajar** | *Banding dengan PID*: baca sensor melalui PID standard sambil rakam bingkai CAN, cari bait yang bergerak seiring (korelasi) dan kira skala/ofset. *Tindakan*: tekan "Saya sedang buat" semasa tekan brek / buka pintu; app cari bit yang berubah. |
| **Sambung** | Senarai dongle dipair, imbas BLE, Demo. Uji cip, protokol, VIN, voltan dan sama ada mod sniff disokong. Terminal arahan AT. |

## Had yang perlu tahu
- ID CAN mentah ditetapkan pengeluar dan tiada senarai rasmi. Label **Tekaan** hanya petunjuk; sahkan dengan tab Belajar.
- Banyak kereta baru ada gateway yang menyekat trafik dalaman dari port OBD2. App beritahu jika tiada trafik; graf PID masih berfungsi.
- Sesetengah klon ELM327 murah (terutama "v2.1") tidak sokong `ATMA` atau cepat `BUFFER FULL`. Guna tapis ID.
- ELM327 tidak boleh sniff dan bertanya PID serentak, jadi mod Belajar dan graf campuran berselang-seli (kira-kira 1–3 kitaran sesaat).
- ID dan formula dalam mod **Demo** direka untuk simulasi, bukan maksud ID kereta sebenar.

## Struktur kod
- `i18n.js`: kamus English dan Bahasa Malaysia
- `can-core.js`: huraian jawapan ELM327, ISO-TP, PID mod 01, DTC, VIN, bingkai CAN, ekstrak isyarat DBC
- `analyze.js`: label standard & J1939, tekaan corak, korelasi dengan PID, pembelajaran tindakan
- `dbc.js`: baca/tulis fail DBC
- `elm327.js`: pemacu ELM327 + transport Android, Web Bluetooth, Web Serial, simulator
- `app.js`, `index.html`, `app.css`: antara muka
- `../android-canbus/`: projek Android (WebView + `ObdBluetooth.java` untuk Classic SPP dan BLE)

## Ujian
```
node --test canbus/test/*.test.js
```
