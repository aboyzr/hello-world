# Senarai komponen (BOM) dan anggaran harga

Harga dalam RM ialah **anggaran** (November 2026) untuk Shopee/Lazada, kedai elektronik tempatan atau LCSC. Harga sebenar berubah ikut penjual dan kos pos.

## A. Skrin

| # | Komponen | Kuantiti | Anggaran (RM) | Di mana | Nota |
|---|---|---|---|---|---|
| 1 | Waveshare ESP32-S3-Touch-LCD-4.3 (800×480, sentuh) | 1 | 180 – 260 | Waveshare / reseller / Shopee | Pastikan model **Touch-LCD-4.3** (ada CAN), bukan 4.3B/4.3C |
| 2 | Modul buck 12V→5V (MP1584 / LM2596) | 1 | 4 – 10 | Shopee | Kuasa skrin dari 12V IGN |

## B. Modul sensor (node)

| # | Komponen | Kuantiti | Anggaran (RM) | Di mana | Nota |
|---|---|---|---|---|---|
| 3 | ESP32-C3 SuperMini | 1 | 12 – 30 | Shopee / AliExpress | |
| 4 | TPIC8101DWR (SOIC-20) | 1 | 12 – 25 | LCSC C469861, Mouser, Digikey | Atau HIP9011 (serasi) |
| 5 | Papan adapter SOIC-20 ke DIP | 1 | 2 – 5 | Shopee | Untuk papan prototaip |
| 6 | 74HCT125 (DIP-14) | 1 | 2 – 4 | Shopee / LCSC | Mesti **HCT**, bukan HC |
| 7 | Modul SN65HVD230 (CAN 3.3V) | 1 | 8 – 15 | Shopee | |
| 8 | PC817 | 2 | 1 – 3 | Shopee | Satu untuk tacho, satu spare (atau untuk trigger COP) |
| 9 | 2N3904 | 1 | 0.20 – 1 | Shopee | Litar klip induktif |
| 10 | 1N4148 | 2 | 0.20 – 1 | Shopee | |
| 11 | Kristal 4 MHz (HC-49) | 1 | 1 – 2 | Shopee | |
| 12 | Kapasitor seramik 20 pF | 2 | Dalam kit | | Kristal |
| 13 | Kapasitor 22 nF | 1 | Dalam kit | | VMID |
| 14 | Kapasitor 3.3 nF (filem / C0G) | 2 | 1 – 2 | Shopee | Input sensor |
| 15 | Kapasitor 100 nF (nyahganding) | 5 | Dalam kit | | Satu pada setiap IC |
| 16 | Perintang: 47k ×4, 10k ×6, 1k ×1, 100k ×1, 1M ×1 | 13 | 10 – 20 (kit) | Shopee | Kit perintang 1/4W |
| 17 | Modul buck 12V→5V | 1 | 4 – 10 | Shopee | Kuasa node |
| 18 | Diod SS34 + TVS SMBJ24A + fius 1A dengan pemegang | 1 set | 5 – 10 | Shopee | Perlindungan kuasa (beli 2 set, untuk skrin juga) |
| 19 | Papan prototaip / perfboard + header pin | 1 | 5 – 10 | Shopee | |

## C. Sensor dan pendawaian enjin

| # | Komponen | Kuantiti | Anggaran (RM) | Di mana | Nota |
|---|---|---|---|---|---|
| 20 | Sensor knock piezo (Bosch 0261231xxx atau OEM) | 2 | 40 – 110 / unit | Kedai alat ganti / Shopee | Sensor terpakai dari kedai potong boleh dapat RM20–50 |
| 21 | Bolt / stud M8 untuk pasang sensor | 2 | 5 – 10 | Kedai hardware | |
| 22 | Klip induktif (pickup timing light) | 1 | 25 – 60 | Shopee | Tak perlu kalau enjin COP (guna PC817 pada trigger coil 1) |
| 23 | Kabel berperisai 2 teras (sensor), 5 m | 1 | 15 – 30 | Shopee | |
| 24 | Kabel twisted-pair untuk CAN, 3 m | 1 | 8 – 15 | Shopee | Boleh guna kabel CAT5 |
| 25 | Penyambung kalis air (Deutsch DT / GX16) | 2–3 set | 15 – 40 | Shopee | Supaya senang pindah antara kereta |
| 26 | Kotak ABS (node dan skrin) | 2 | 15 – 40 | Shopee | |
| 27 | Perintang 120 Ω (penamat CAN) | 1 | Dalam kit | | Hanya kalau bas belum ada 2 penamat |

## Jumlah anggaran

| Pilihan | Anggaran |
|---|---|
| Penuh (2 sensor baru, klip induktif, penyambung kalis air) | **RM 450 – 850** |
| Jimat (1 sensor terpakai, tanpa klip untuk COP, wayar biasa) | **RM 300 – 420** |
| Kos pos LCSC/Mouser (kalau beli TPIC8101 dari sana) | + RM 40 – 80 |

## Tips beli
- Beli TPIC8101 bersama 74HCT125, kristal, kapasitor dan perintang dalam satu pesanan LCSC supaya jimat kos pos.
- Beli 2 unit TPIC8101 dan ESP32-C3: satu untuk ganti kalau rosak semasa solder atau uji.
- Untuk Waveshare, elakkan listing "unbranded". Pastikan gambar papan menunjukkan terminal CAN dan RS485.
- Sensor knock OEM dari enjin yang selalu kau tune (contohnya Perodua/Proton/Honda) senang dicari dan dah sedia ada bracket.
