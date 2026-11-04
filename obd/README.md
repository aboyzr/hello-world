# Diagnostik OBD2 (Bluetooth ELM327)

Modul dalam app **Aboy Workshop** untuk mengesan dan menyahkod data kereta melalui port OBD2
menggunakan dongle Bluetooth ELM327 (atau klon / Vgate / Veepeak / OBDLink).

## Fungsi
| Tab | Apa yang dibuat |
|---|---|
| **Sambung** | Senarai dongle Bluetooth Classic yang dipair, imbas dongle BLE, mod Demo. Auto-kesan protokol, baca VIN, voltan bateri, status lampu enjin, PID disokong |
| **Langsung** | Data enjin masa nyata (RPM, kelajuan, suhu, beban, throttle, MAF, MAP, fuel trim, voltan…) dengan graf kecil. Pilih PID sendiri |
| **Kod** | Baca kod kerosakan tersimpan (03), menunggu (07), kekal (0A) dengan penerangan Bahasa Melayu; padam kod (04) |
| **CAN** | Monitor bas CAN mentah (`ATMA`): jadual ID, kadar Hz, bait berubah diwarnakan, tapis ID/mask, rakam & eksport CSV, nyahkod isyarat gaya DBC (Intel/Motorola, skala, ofset) |
| **Terminal** | Hantar arahan AT / OBD sendiri, jawapan dinyahkod automatik |

## Cara guna
1. Cucuk dongle ke port OBD2 (bawah stereng), kunci **ON** atau hidupkan enjin.
2. Dongle Bluetooth biasa: pair di *Tetapan → Bluetooth* telefon (PIN `1234` / `0000`).
   Dongle BLE: tak perlu pair, tekan **Cari BLE** dalam app.
3. Buka app Aboy Workshop → **Diagnostik OBD2** → **Senarai dongle** → pilih dongle.

Tekan **Demo** untuk cuba semua fungsi tanpa kereta (simulator ELM327 terbina dalam).

Dalam pelayar (GitHub Pages) pada Chrome PC/Android: **Web Bluetooth** (dongle BLE) atau
**Port Serial / COM** (dongle Bluetooth Classic yang telah dipair sebagai port COM di PC).

## Protokol disokong
ISO 15765-4 CAN (11/29-bit, 250/500k), ISO 9141-2, KWP2000, J1850 PWM/VPW — iaitu
semua protokol yang disokong cip ELM327. Mesej berbilang bingkai (ISO-TP) dihimpun semula.
Monitor CAN mentah hanya untuk kereta protokol CAN.

## Struktur kod
- `obd-core.js` — penghurai & penyahkod (tiada DOM): jawapan ELM327, ISO-TP, PID mod 01, DTC, VIN, bingkai CAN, isyarat DBC
- `elm327.js` — pemacu ELM327 + transport: Android (Java), Web Bluetooth, Web Serial, simulator
- `app.js`, `index.html`, `app.css` — antara muka
- `../android/.../ObdBluetooth.java` — jambatan Bluetooth Classic (SPP/RFCOMM) & BLE untuk APK

## Ujian
```
node --test obd/test/*.test.js
```

## Amaran
- Padam kod tidak membaiki kerosakan — lampu akan menyala semula jika masalah masih ada.
- Jangan guna app sambil memandu. Dongle murah boleh menghabiskan bateri jika dibiarkan tercucuk lama.
