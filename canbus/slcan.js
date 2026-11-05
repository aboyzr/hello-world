/*
 * Pemacu slcan / LAWICEL untuk adapter USB-to-CAN (cth CANable, CANUSB, CANtact).
 * Guna CAN mentah terus (bukan ELM327). Antara muka sama dengan Elm327 supaya app
 * boleh guna kedua-duanya: sniff, hantar (sekali/ulang/turutan), baca PID & imbas
 * modul melalui ISO-TP (ISO 15765-2) yang dibina di atas bingkai CAN mentah.
 *
 * Nota: CANable mesti guna firmware slcan (muncul sebagai port COM). Firmware
 * candleLight/gs_usb (USB natif) tidak boleh dicapai oleh Web Serial.
 */
(function (root) {
  'use strict';
  const Core = root.ObdCore || (typeof require !== 'undefined' ? require('./can-core.js') : null);
  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null ? v[k] : m));
  const tr = (k, fb, v) => (root.I18N ? root.I18N.t(k, v, fb) : fill(fb, v));
  const hx2 = Core.hex2;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Kadar bit CAN → arahan slcan S
  const BITRATE = { '10': 'S0', '20': 'S1', '50': 'S2', '100': 'S3', '125': 'S4', '250': 'S5', '500': 'S6', '800': 'S7', '1000': 'S8' };

  // Bina arahan hantar slcan: t<iii><L><data> (11-bit) atau T<iiiiiiii><L><data> (29-bit)
  function encodeTx(id, data) {
    const ext = id.length > 3;
    const idHex = ext ? id.toUpperCase().padStart(8, '0') : id.toUpperCase().padStart(3, '0');
    const d = data.slice(0, 8);
    return (ext ? 'T' : 't') + idHex + d.length + d.map(b => hx2(b & 0xff)).join('');
  }

  // Huraikan satu baris slcan masuk → { id, ext, data } atau null
  function parseRx(line) {
    line = line.trim();
    const c = line[0];
    if (c !== 't' && c !== 'T' && c !== 'r' && c !== 'R') return null;
    const ext = c === 'T' || c === 'R', rtr = c === 'r' || c === 'R';
    const idLen = ext ? 8 : 3;
    if (line.length < 1 + idLen + 1) return null;
    const id = line.slice(1, 1 + idLen).toUpperCase();
    if (!/^[0-9A-F]+$/.test(id)) return null;
    const dlc = parseInt(line[1 + idLen], 16);
    if (isNaN(dlc)) return null;
    const data = [];
    if (!rtr) {
      const hex = line.slice(2 + idLen, 2 + idLen + dlc * 2);
      for (let i = 0; i + 1 < hex.length; i += 2) data.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return { id, ext, data, rtr };
  }

  // Bingkai CAN → teks ruang-dipisah yang difahami ObdCore.parseCanFrame ("316 05 20 …")
  const toTextFrame = f => f.id + ' ' + f.data.map(hx2).join(' ');

  class Slcan {
    constructor(transport, log) {
      this.t = transport; this.log = log || (() => {});
      this.buf = ''; this.version = '';
      this.protocol = { id: '6', name: 'USB-CAN (slcan)', can: true, ext: false };
      this.monitor = null;          // { onLine } bila sniff aktif
      this.isoWaiters = [];         // pengumpul ISO-TP aktif
      this.txQueue = Promise.resolve();
      transport.onData(chunk => this._rx(chunk));
    }

    _rx(chunk) {
      this.buf += chunk;
      let i;
      // slcan tamat setiap balasan dengan CR (\r); ralat = BELL (0x07)
      while ((i = this.buf.search(/[\r\x07]/)) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const f = parseRx(line);
        if (!f) { this.log('rx', line); continue; }   // balasan arahan (V, N, dll.)
        // Hantar ke pengumpul ISO-TP dan ke monitor
        for (const w of this.isoWaiters) w.frame(f);
        if (this.monitor) this.monitor.onLine(toTextFrame(f));
      }
    }

    // Tulis arahan mentah slcan (tamat dengan CR)
    _write(cmd) { this.log('tx', cmd); this.t.write(cmd + '\r'); }

    async init(opts) {
      opts = opts || {};
      const bit = BITRATE[String(opts.bitrate || '500')] || 'S6';
      this._write('C');                 // tutup dulu (abai jika ralat)
      await sleep(60);
      this.buf = '';
      this._write(bit);                 // kadar bit
      await sleep(40);
      this._write(opts.listen ? 'L' : 'O');   // buka (L = dengar sahaja)
      await sleep(80);
      this.protocol = { id: '6', name: 'USB-CAN (slcan) ' + (opts.bitrate || '500') + 'k', can: true, ext: false, bitrate: opts.bitrate || '500' };
      // Cuba kenal pasti ECU OBD (pilihan, tak gagal jika senyap)
      let ecus = [];
      try { ecus = (await this.isoTp([0x01, 0x00], { timeout: 1500 })).map(m => m.ecu); } catch (e) { /* abaikan */ }
      this.version = 'slcan';
      return { version: this.version, protocol: this.protocol, ecus: [...new Set(ecus)] };
    }

    voltage() { return Promise.resolve(null); }   // slcan tiada bacaan voltan

    // ---------- Monitor / sniff ----------
    async startMonitor(onLine, filter, onOverflow, onUnsupported) {
      // slcan sentiasa menstrim selepas dibuka; tapis dalam perisian jika perlu
      const mask = filter && filter.id ? parseInt(filter.mask || (filter.id.length > 3 ? '1FFFFFFF' : '7FF'), 16) : 0;
      const want = filter && filter.id ? parseInt(filter.id, 16) : 0;
      this.monitor = {
        onLine: text => {
          if (mask) { const id = parseInt(text.split(' ')[0], 16); if ((id & mask) !== (want & mask)) return; }
          onLine(text);
        }
      };
    }
    async stopMonitor() { this.monitor = null; }

    async burst(ms, onLine) {
      const prev = this.monitor;
      this.monitor = { onLine };
      await sleep(ms);
      this.monitor = prev;
    }

    async probeSniff() {
      let n = 0;
      const prev = this.monitor;
      this.monitor = { onLine: () => n++ };
      await sleep(800);
      this.monitor = prev;
      if (!n) return { ok: false, reason: tr('slcan.noTraffic', 'Tiada trafik CAN. Semak kadar bit (250k/500k) dan pendawaian CAN-H/CAN-L.') };
      return { ok: true, frames: n };
    }

    // ---------- Hantar ----------
    async beginSend() { /* slcan tidak perlu persediaan */ }
    async txFrame(id, data) { this.txQueue = this.txQueue.then(() => this._write(encodeTx(id, data))); return this.txQueue; }
    async sendFrame(id, data) { await this.txFrame(id, data); }
    async endSend() { /* tiada */ }

    // ---------- ISO-TP (ISO 15765-2) ----------
    /*
     * Hantar permintaan diagnostik dan himpun jawapan dari semua ECU yang menjawab.
     * payload = bait perkhidmatan (cth [0x01, 0x0C]). reqId lalai 7DF (siaran).
     * Pulangkan [{ ecu, bytes }] (bytes = mesej penuh tanpa PCI).
     */
    isoTp(payload, opts) {
      opts = opts || {};
      const reqId = opts.reqId || '7DF';
      const timeout = opts.timeout || 2000;
      const expectSvc = (payload[0] + 0x40) & 0xff;   // jawapan positif yang dijangka
      return new Promise(resolve => {
        const resp = new Map();   // ecu -> { len, bytes, done }
        const waiter = {
          frame: f => {
            if (f.ext || f.id.length > 3) return;
            const id = parseInt(f.id, 16);
            if (opts.respId) { if (id !== parseInt(opts.respId, 16)) return; }
            else if (!(id >= 0x7E8 && id <= 0x7EF)) return;   // jawapan diagnostik 11-bit
            const pci = f.data[0] >> 4;
            let e = resp.get(f.id);
            // Tapis jawapan dari pertanyaan lain: SF/FF mesti padan perkhidmatan + sub-fungsi/PID
            if (pci === 0 || pci === 1) {
              const svc = pci === 0 ? f.data[1] : f.data[2];
              if (svc === 0x7F) { /* jawapan negatif: terima */ }
              else if (svc !== expectSvc) return;
              else if (payload.length >= 2) {
                const echo = pci === 0 ? f.data[2] : f.data[3];   // PID / sub-fungsi yang digemakan
                if (echo !== payload[1]) return;
              }
            }
            if (pci === 0) {                          // single frame
              const len = f.data[0] & 0x0f;
              resp.set(f.id, { bytes: f.data.slice(1, 1 + len), done: true });
            } else if (pci === 1) {                   // first frame
              const len = ((f.data[0] & 0x0f) << 8) | f.data[1];
              resp.set(f.id, { len, bytes: f.data.slice(2), done: false });
              // hantar Flow Control ke alamat fizikal ECU (id - 8)
              const fcId = (id - 8).toString(16).toUpperCase().padStart(3, '0');
              this._write(encodeTx(fcId, [0x30, 0x00, 0x00, 0, 0, 0, 0, 0]));
            } else if (pci === 2 && e && !e.done) {   // consecutive frame
              e.bytes.push(...f.data.slice(1));
              if (e.bytes.length >= e.len) { e.bytes = e.bytes.slice(0, e.len); e.done = true; }
            }
            // Selesai awal jika ada jawapan & semua yang bermula sudah lengkap
            if (resp.size && [...resp.values()].every(x => x.done)) finish();
          }
        };
        let done = false;
        const finish = () => {
          if (done) return; done = true;
          clearTimeout(timer);
          this.isoWaiters = this.isoWaiters.filter(w => w !== waiter);
          resolve([...resp.entries()].filter(([, v]) => v.done).map(([ecu, v]) => ({ ecu, bytes: v.bytes })));
        };
        const timer = setTimeout(finish, timeout);
        this.isoWaiters.push(waiter);
        // Hantar permintaan: single frame [len, ...payload] dipad ke 8 bait
        const sf = [payload.length, ...payload]; while (sf.length < 8) sf.push(0);
        this._write(encodeTx(reqId, sf));
      });
    }

    async readPid(pid) {
      const msgs = await this.isoTp([0x01, pid]);
      const m = msgs.find(x => x.bytes[0] === 0x41 && x.bytes[1] === pid);
      return m ? Core.decodePid(pid, m.bytes.slice(2)) : null;
    }

    async supportedPids() {
      const list = [];
      for (let base = 0; base < 0xE0; base += 0x20) {
        if (base && !list.includes(base)) break;
        const msgs = await this.isoTp([0x01, base]);
        const m = msgs.find(x => x.bytes[0] === 0x41 && x.bytes[1] === base);
        if (!m) break;
        for (const p of Core.decodeSupported(base, m.bytes.slice(2))) if (!list.includes(p)) list.push(p);
      }
      return list;
    }

    async readVin() {
      const msgs = await this.isoTp([0x09, 0x02], { timeout: 3000 });
      const m = msgs.find(x => x.bytes[0] === 0x49 && x.bytes[1] === 0x02);
      return m ? Core.decodeVin(m.bytes) : null;
    }

    async scanModules(onProgress) {
      const found = new Map();
      const add = (ecu, k) => { const v = found.get(ecu) || {}; v[k] = true; found.set(ecu, v); };
      for (const m of await this.isoTp([0x01, 0x00])) if (m.bytes[0] === 0x41) add(m.ecu, 'obd');
      for (let i = 0; i < 8; i++) {
        const reqId = (0x7E0 + i).toString(16).toUpperCase();
        const msgs = await this.isoTp([0x3E, 0x00], { reqId, respId: (0x7E8 + i).toString(16).toUpperCase(), timeout: 700 });
        for (const m of msgs) if (m.bytes[0] === 0x7E || (m.bytes[0] === 0x7F && m.bytes[1] === 0x3E)) add(m.ecu, 'uds');
        if (onProgress) onProgress(i + 1, 8);
      }
      return { ext: false, modules: [...found.entries()].map(([ecu, v]) => ({ ecu, obd: !!v.obd, uds: !!v.uds })) };
    }

    // Terminal: hantar arahan slcan mentah (cth V, N, F)
    async send(cmd) { this._write(cmd.trim()); await sleep(150); return ''; }
  }

  const api = { Slcan, encodeTx, parseRx, toTextFrame, BITRATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Slcan = Slcan, root.SlcanLib = api;
})(typeof self !== 'undefined' ? self : this);
