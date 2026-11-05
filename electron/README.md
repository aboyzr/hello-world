# Aboy Canbus — versi Windows (Electron)

Membungkus aplikasi web `../canbus/` sebagai app desktop Windows (.exe). Kod enjin dan
antara muka sama dengan versi Android; cuma port COM dan BLE dikendalikan oleh Electron.

## Sambungan di Windows
- **Dongle Bluetooth biasa (Classic):** pair di *Tetapan → Peranti Bluetooth* Windows. Ia jadi
  **port COM**. Dalam app tekan **Serial / COM port** dan pilih port itu.
- **Dongle BLE:** tekan **Web Bluetooth (BLE)** dan pilih dari senarai.
- **Demo:** cuba tanpa kereta.

Proses utama (`main.js`) menangkap `select-serial-port` dan `select-bluetooth-device`,
menghantar senarai ke halaman melalui `preload.js`, dan halaman memaparkannya untuk dipilih.

## Bina setempat
```
cd electron
npm install
# salin app web dulu:
mkdir canbus && cp ../canbus/*.html ../canbus/*.js ../canbus/*.css ../canbus/*.svg canbus/ && cp -r ../canbus/dbc canbus/
npm run start     # jalankan untuk uji
npm run dist      # hasilkan dist/AboyCanbus.exe (portable) + AboyCanbus-Setup.exe
```

CI (`.github/workflows/canbus-win.yml`) buat ini di `windows-latest` dan terbitkan ke release
bertag `canbus-win`.

## Nota
- `.exe` tidak ditandatangani kod. Windows SmartScreen mungkin papar amaran "penerbit tidak
  dikenali" — tekan *More info → Run anyway*. Untuk hilangkan amaran perlu sijil penandatangan
  kod (berbayar).
- Ikon lalai Electron digunakan; ikon tersuai boleh ditambah kemudian (`build.win.icon`).
