/*
 * Pemacu ELM327 + pengangkutan (transport) Bluetooth.
 * Transport = { name, open(), write(text), close(), onData(fn), onClose(fn) }
 */
(function (root) {
  'use strict';
  const Core = root.ObdCore || (typeof require !== 'undefined' ? require('./can-core.js') : null);
  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null ? v[k] : m));
  const tr = (k, fb, v) => (root.I18N ? root.I18N.t(k, v, fb) : fill(fb, v));

  class Elm327 {
    constructor(transport, log) {
      this.t = transport; this.log = log || (() => {});
      this.buf = ''; this.waiter = null; this.queue = Promise.resolve();
      this.monitor = null; this.protocol = Core.protocolInfo('6'); this.version = '';
      transport.onData(chunk => this._onData(chunk));
    }

    _onData(chunk) {
      this.buf += chunk;
      if (this.monitor) {
        // Mod monitor CAN: hantar setiap baris lengkap
        let i;
        while ((i = this.buf.search(/[\r\n]/)) >= 0) {
          const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          if (/BUFFER FULL/i.test(line)) { this.monitor.onOverflow && this.monitor.onOverflow(); continue; }
          if (line === '>' || /^STOPPED/i.test(line)) continue;
          if (line === '?' && this.monitor.onUnsupported) { this.monitor.onUnsupported(); continue; }
          this.monitor.onLine(line.replace(/^>/, ''));
        }
        if (this.buf.includes('>')) { const w = this.monitor.stopWaiter; this.buf = ''; if (w) w(); }
        return;
      }
      if (this.buf.includes('>') && this.waiter) {
        const out = this.buf.slice(0, this.buf.lastIndexOf('>')); this.buf = '';
        const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(out);
      }
    }

    // Hantar arahan dan tunggu prompt '>'. Arahan dibariskan satu demi satu.
    send(cmd, timeout) {
      const run = () => new Promise((resolve, reject) => {
        if (this.monitor) return reject(new Error(tr('elm.busy', 'Mod monitor sedang berjalan')));
        this.buf = '';
        this.waiter = {
          resolve: out => { this.log('rx', out.trim()); resolve(out); },
          timer: setTimeout(() => { this.waiter = null; reject(new Error(tr('elm.noReply', 'Tiada jawapan: {cmd}', { cmd }))); }, timeout || 4000)
        };
        this.log('tx', cmd);
        this.t.write(cmd + '\r');
      });
      const p = this.queue.then(run, run);
      this.queue = p.catch(() => {});
      return p;
    }

    async init(protocol) {
      try { await this.send('ATZ', 3000); } catch (e) { await this.send('ATZ', 3000); }
      await this.send('ATE0');
      const id = await this.send('ATI');
      this.version = Core.cleanLines(id).filter(l => l !== 'ATI').join(' ');
      for (const c of ['ATL0', 'ATS1', 'ATH1', 'ATAT1', 'ATSP' + (protocol || '0')]) await this.send(c);
      // Pertanyaan pertama — ELM327 cari protokol kereta (boleh ambil masa)
      const first = await this.send('0100', 15000);
      const dpn = Core.cleanLines(await this.send('ATDPN')).join('');
      this.protocol = Core.protocolInfo(dpn);
      const parsed = Core.parseResponse(first, this.protocol);
      if (parsed.error) throw new Error(tr('elm.carSilent', 'Kereta tidak menjawab ({err}). Pastikan suis kunci ON.', { err: parsed.error }));
      return { version: this.version, protocol: this.protocol, ecus: [...new Set(parsed.messages.map(m => m.ecu))] };
    }

    async query(cmd, timeout) {
      const raw = await this.send(cmd, timeout);
      return Core.parseResponse(raw, this.protocol);
    }

    async voltage() {
      const v = Core.cleanLines(await this.send('ATRV')).join('');
      const n = parseFloat(v); return isNaN(n) ? null : n;
    }

    async supportedPids() {
      const list = [];
      for (let base = 0; base < 0xE0; base += 0x20) {
        if (base && !list.includes(base)) break;
        const r = await this.query('01' + Core.hex2(base));
        const m = r.messages.find(x => x.bytes[0] === 0x41 && x.bytes[1] === base);
        if (!m) break;
        for (const p of Core.decodeSupported(base, m.bytes.slice(2))) if (!list.includes(p)) list.push(p);
      }
      return list;
    }

    async readPid(pid) {
      const r = await this.query('01' + Core.hex2(pid));
      const m = r.messages.find(x => x.bytes[0] === 0x41 && x.bytes[1] === pid);
      return m ? Core.decodePid(pid, m.bytes.slice(2)) : null;
    }

    async readDtcs(mode) {
      const r = await this.query(mode || '03', 6000);
      const resp = parseInt(mode || '03', 16) + 0x40;
      const out = [];
      for (const m of r.messages) {
        if (m.bytes[0] !== resp) continue;
        for (const code of Core.decodeDtcs(m.bytes, this.protocol.can)) out.push({ code, ecu: m.ecu, text: Core.describeDtc(code) });
      }
      return { error: r.error === 'NO DATA' ? null : r.error, codes: out };
    }

    async clearDtcs() { const r = await this.query('04', 6000); return !r.error; }

    async readVin() {
      const r = await this.query('0902', 6000);
      const m = r.messages.find(x => x.bytes[0] === 0x49 && x.bytes[1] === 0x02);
      return m ? Core.decodeVin(m.bytes) : null;
    }

    // Mula tangkap semua trafik bas CAN. filter = { id: '7E8', mask: '7FF' } (pilihan)
    async startMonitor(onLine, filter, onOverflow, onUnsupported) {
      if (!this.protocol.can) throw new Error(tr('elm.canOnly', 'Sniff CAN hanya untuk kereta protokol CAN'));
      await this.send('ATCAF0'); // papar bait PCI (data mentah)
      if (filter && filter.id) {
        await this.send(this.protocol.ext ? 'ATCF' + filter.id.padStart(8, '0') : 'ATCF' + filter.id.padStart(3, '0'));
        await this.send(this.protocol.ext ? 'ATCM' + (filter.mask || '1FFFFFFF') : 'ATCM' + (filter.mask || '7FF'));
      } else await this.send('ATCRA');
      this._beginMa(onLine, onOverflow, onUnsupported);
    }

    _beginMa(onLine, onOverflow, onUnsupported) {
      this.monitor = { onLine, onOverflow, onUnsupported };
      this.buf = '';
      this.log('tx', 'ATMA');
      this.t.write('ATMA\r');
    }

    async _endMa() {
      if (!this.monitor) return;
      await new Promise(res => {
        const done = () => { clearTimeout(timer); res(); };
        const timer = setTimeout(done, 1500);
        this.monitor.stopWaiter = done;
        this.t.write('\r'); // mana-mana aksara hentikan ATMA
      });
      this.monitor = null; this.buf = '';
    }

    async stopMonitor() {
      if (!this.monitor) return;
      await this._endMa();
      await this.send('ATCRA').catch(() => {});
      await this.send('ATCAF1').catch(() => {});
    }

    // Tangkap trafik selama ms milisaat, kemudian kembali ke mod soal-jawab (untuk selang-seli dengan PID)
    async burst(ms, onLine) {
      await this.send('ATCAF0');
      this._beginMa(onLine);
      await new Promise(r => setTimeout(r, ms));
      await this._endMa();
      await this.send('ATCAF1');
    }

    // Uji sama ada dongle sokong ATMA dan ada trafik di port OBD
    async probeSniff() {
      if (!this.protocol.can) return { ok: false, reason: tr('elm.notCan', 'Kereta bukan protokol CAN') };
      let frames = 0, unsupported = false;
      await this.send('ATCAF0');
      this._beginMa(l => { if (Core.parseCanFrame(l)) frames++; }, null, () => { unsupported = true; });
      await new Promise(r => setTimeout(r, 800));
      await this._endMa();
      await this.send('ATCAF1').catch(() => {});
      if (unsupported) return { ok: false, reason: tr('elm.noAtma', 'Dongle tidak sokong mod sniff (ATMA)') };
      if (!frames) return { ok: false, reason: tr('elm.noTraffic', 'Tiada trafik CAN di port OBD (mungkin ada gateway). Graf PID masih boleh.') };
      return { ok: true, frames };
    }
  }

  // ---------- Transport: Android (Bluetooth Classic SPP / BLE melalui Java) ----------
  class AndroidTransport {
    constructor(device) { this.device = device; this.name = device.name || device.address; this.dataFns = []; this.closeFns = []; }
    static available() { return !!root.ObdBridge; }
    static listDevices(scanBle) {
      return new Promise((resolve, reject) => {
        root.obdNative.onDevices = list => resolve(JSON.parse(list));
        root.obdNative.onPermission = ok => { if (!ok) reject(new Error(tr('elm.perm', 'Kebenaran Bluetooth ditolak'))); };
        root.obdNative.onError = msg => reject(new Error(msg));
        root.ObdBridge.listDevices(!!scanBle);
      });
    }
    open() {
      return new Promise((resolve, reject) => {
        const n = root.obdNative;
        n.onConnect = () => resolve();
        n.onError = msg => { reject(new Error(msg)); if (this.opened) this.closeFns.forEach(f => f(msg)); };
        n.onData = s => this.dataFns.forEach(f => f(s));
        n.onClose = () => this.closeFns.forEach(f => f());
        root.ObdBridge.connect(this.device.address, this.device.type || 'classic');
      }).then(() => { this.opened = true; });
    }
    write(s) { root.ObdBridge.write(s); }
    close() { root.ObdBridge.disconnect(); }
    onData(f) { this.dataFns.push(f); }
    onClose(f) { this.closeFns.push(f); }
  }
  // Panggilan balik dari Java
  root.obdNative = root.obdNative || {};

  // ---------- Transport: Web Bluetooth (BLE, Chrome) ----------
  const BLE_SERVICES = [0xfff0, 0xffe0, 0x18f0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', 0xbeef, 0xfee7];
  class WebBleTransport {
    constructor() { this.dataFns = []; this.closeFns = []; this.name = 'BLE'; }
    static available() { return !!(root.navigator && navigator.bluetooth); }
    async open() {
      const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      this.name = dev.name || 'BLE';
      dev.addEventListener('gattserverdisconnected', () => this.closeFns.forEach(f => f()));
      const gatt = await dev.gatt.connect(); this.dev = dev;
      let rx = null, tx = null;
      for (const s of await gatt.getPrimaryServices()) {
        let chars; try { chars = await s.getCharacteristics(); } catch (e) { continue; }
        for (const c of chars) {
          if (!rx && (c.properties.notify || c.properties.indicate)) rx = c;
          if (!tx && (c.properties.write || c.properties.writeWithoutResponse)) tx = c;
        }
        if (rx && tx) break;
      }
      if (!rx || !tx) throw new Error(tr('elm.noUart', 'Dongle BLE ini tidak ada servis UART dikenali'));
      this.tx = tx; const dec = new TextDecoder();
      rx.addEventListener('characteristicvaluechanged', e => { const s = dec.decode(e.target.value); this.dataFns.forEach(f => f(s)); });
      await rx.startNotifications();
      this.chain = Promise.resolve();
    }
    write(s) {
      const bytes = new TextEncoder().encode(s);
      for (let i = 0; i < bytes.length; i += 20) {
        const part = bytes.slice(i, i + 20);
        this.chain = this.chain.then(() => this.tx.properties.writeWithoutResponse ? this.tx.writeValueWithoutResponse(part) : this.tx.writeValue(part));
      }
    }
    close() { if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); }
    onData(f) { this.dataFns.push(f); }
    onClose(f) { this.closeFns.push(f); }
  }

  // ---------- Transport: Web Serial (PC: dongle Bluetooth Classic dipasang sebagai port COM) ----------
  class WebSerialTransport {
    constructor() { this.dataFns = []; this.closeFns = []; this.name = 'Serial'; }
    static available() { return !!(root.navigator && navigator.serial); }
    async open() {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 38400 });
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      const dec = new TextDecoder();
      (async () => {
        try { for (;;) { const { value, done } = await this.reader.read(); if (done) break; const s = dec.decode(value); this.dataFns.forEach(f => f(s)); } }
        catch (e) { /* port ditutup */ }
        this.closeFns.forEach(f => f());
      })();
    }
    write(s) { this.writer.write(new TextEncoder().encode(s)); }
    async close() { try { await this.reader.cancel(); this.reader.releaseLock(); this.writer.releaseLock(); await this.port.close(); } catch (e) { /* abaikan */ } }
    onData(f) { this.dataFns.push(f); }
    onClose(f) { this.closeFns.push(f); }
  }

  // ---------- Transport: Simulator (demo tanpa kereta) ----------
  // Bas CAN contoh: ID & formula direka untuk demo sahaja, bukan maksud ID kereta sebenar.
  class SimTransport {
    constructor(opts) {
      this.name = 'Demo (simulator)'; this.dataFns = []; this.closeFns = [];
      this.o = Object.assign({ dtcs: ['P0301', 'P0420'], vin: 'PM2L9K1A0MS123456', latency: 15 }, opts);
      this.echo = true; this.headers = false; this.spaces = true; this.caf = true;
      this.t0 = Date.now(); this.mon = null; this.dtcs = this.o.dtcs.slice(); this.n = 0;
      this.brake = null; // null = automatik; true/false = dikawal app (mod Belajar tindakan)
    }
    open() { return Promise.resolve(); }
    onData(f) { this.dataFns.push(f); }
    onClose(f) { this.closeFns.push(f); }
    close() { this._stopMon(); this.closeFns.forEach(f => f()); }
    _emit(s) { setTimeout(() => this.dataFns.forEach(f => f(s)), this.o.latency); }
    write(s) {
      if (this.mon) { this._stopMon(); this._emit('\r\r>'); return; }
      for (const cmd of s.split('\r').map(x => x.trim().toUpperCase().replace(/\s+/g, '')).filter(Boolean)) {
        const r = this._reply(cmd);
        if (r === null) { if (this.echo) this._emit(cmd + '\r'); continue; }
        this._emit((this.echo ? cmd + '\r' : '') + r + '\r\r>');
      }
    }
    _stopMon() { if (this.mon) { clearInterval(this.mon); this.mon = null; } }
    _state() {
      const t = (Date.now() - this.t0) / 1000;
      const pedal = Math.pow(Math.max(0, Math.sin(t / 1.6)), 1.5);
      // RPM & kelajuan ikut pedal dengan lengah (macam enjin sebenar), bukan salinan tepat TPS
      const dt = Math.min(0.5, t - (this._lt || t)); this._lt = t;
      this._rpmF = (this._rpmF == null ? pedal : this._rpmF + (pedal - this._rpmF) * Math.min(1, dt * 2.5));
      this._spdF = (this._spdF == null ? 0.3 : this._spdF + (pedal - this._spdF) * Math.min(1, dt * 0.35));
      const rpm = 780 + Math.pow(this._rpmF, 0.8) * 3200 + Math.sin(t * 3) * 15;
      const brake = this.brake === null ? (Math.sin(t / 2.3 + 2) > 0.85) : this.brake;
      return { t, pedal, rpm, tps: 2 + pedal * 70, speed: Math.max(0, 20 + this._spdF * 60), cool: Math.min(88, 62 + t * 0.4), load: 15 + this._rpmF * 60, steer: Math.sin(t / 2) * 300, brake };
    }
    _fmt(header, bytes) {
      const b = bytes.map(x => x.toString(16).toUpperCase().padStart(2, '0'));
      const parts = this.headers ? [header].concat(b) : b;
      return this.spaces ? parts.join(' ') : parts.join('');
    }
    _frames(payload) {
      // Bentuk bingkai ISO-TP dari ECU 7E8
      if (payload.length <= 7) return [this._fmt('7E8', [payload.length].concat(payload, Array(7 - payload.length).fill(0x55)))];
      const out = [this._fmt('7E8', [0x10 | (payload.length >> 8), payload.length & 0xff].concat(payload.slice(0, 6)))];
      for (let i = 6, sn = 1; i < payload.length; i += 7, sn++) {
        const chunk = payload.slice(i, i + 7);
        out.push(this._fmt('7E8', [0x20 | (sn & 0xf)].concat(chunk, Array(7 - chunk.length).fill(0x55))));
      }
      return out.join('\r');
    }
    _reply(c) {
      if (c === 'ATZ') { this.echo = true; this.headers = false; this.caf = true; return '\r\rELM327 v1.5'; }
      if (c === 'ATI') return 'ELM327 v1.5';
      if (c === 'ATE0') { this.echo = false; return 'OK'; }
      if (c === 'ATE1') { this.echo = true; return 'OK'; }
      if (/^ATH[01]$/.test(c)) { this.headers = c[3] === '1'; return 'OK'; }
      if (/^ATS[01]$/.test(c)) { this.spaces = c[3] === '1'; return 'OK'; }
      if (/^ATCAF[01]$/.test(c)) { this.caf = c[5] === '1'; return 'OK'; }
      if (c === 'ATRV') return (12.4 + Math.random() * 0.3).toFixed(1) + 'V';
      if (c === 'ATDPN') return 'A6';
      if (c === 'ATDP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
      if (c === 'ATMA') { this._startMon(); return null; }
      if (c.startsWith('AT')) return 'OK';
      if (!/^[0-9A-F]+$/.test(c)) return '?';
      if (!this.caf) return 'NO DATA'; // tanpa format ISO-TP, ECU tidak faham
      const s = this._state(); const mode = c.slice(0, 2), pid = parseInt(c.slice(2, 4), 16);
      const w16 = v => [(Math.round(v) >> 8) & 0xff, Math.round(v) & 0xff];
      if (mode === '01') {
        const sup = { 0x00: [0xBE, 0x3F, 0xA8, 0x13], 0x20: [0x90, 0x05, 0xB0, 0x15], 0x40: [0x7A, 0x1C, 0x00, 0x00] };
        const v = {
          0x01: [0x80 | this.dtcs.length, 0x07, 0xE5, 0x00], 0x04: [Math.round(s.load * 2.55)], 0x05: [Math.round(s.cool + 40)],
          0x06: [128 + Math.round(Math.sin(s.t) * 5)], 0x07: [131], 0x0B: [Math.round(30 + s.load / 2)],
          0x0C: w16(s.rpm * 4), 0x0D: [Math.round(s.speed)], 0x0E: [140], 0x0F: [72], 0x10: w16(s.rpm * 0.6),
          0x11: [Math.round(s.tps * 2.55)], 0x1C: [6], 0x1F: w16(s.t), 0x21: [0, 42], 0x2F: [150], 0x31: [0x01, 0xF4],
          0x33: [101], 0x42: [0x30, 0xD4], 0x46: [70], 0x51: [1], 0x5C: [Math.round(s.cool + 35)]
        };
        if (sup[pid]) return this._frames([0x41, pid].concat(sup[pid]));
        if (v[pid]) return this._frames([0x41, pid].concat(v[pid]));
        return 'NO DATA';
      }
      if (mode === '03' || mode === '07') {
        const codes = mode === '03' ? this.dtcs : [];
        const bytes = [];
        for (const d of codes) { bytes.push(('PCBU'.indexOf(d[0]) << 6) | (parseInt(d[1], 16) << 4) | parseInt(d[2], 16), parseInt(d.slice(3), 16)); }
        return this._frames([parseInt(mode, 16) + 0x40, codes.length].concat(bytes));
      }
      if (mode === '04') { this.dtcs = []; return this._frames([0x44]); }
      if (c === '0902') return this._frames([0x49, 0x02, 0x01].concat([...this.o.vin].map(ch => ch.charCodeAt(0))));
      return 'NO DATA';
    }
    _busFrames() {
      const s = this._state(), n = this.n++, out = [];
      const rpm = Math.round(s.rpm * 4) & 0xffff;
      const f316 = [0x05, 0x20, rpm & 0xff, rpm >> 8, 0x20, 0x20, 0x00];
      f316.push(f316.reduce((a, b) => a + b, 0x316 & 0xff) & 0xff); // checksum
      out.push(['316', f316]);
      out.push(['320', [0x00, 0x1F, Math.round(s.tps * 2.55), 0x00, 0x40, 0x00, 0x00, n & 0xff]]);
      const ws = Math.round(s.speed * 100);
      const wheel = k => ws + k * 3;
      out.push(['4B0', [0, 1, 2, 3].flatMap(k => [(wheel(k) >> 8) & 0xff, wheel(k) & 0xff])]);
      if (n % 2 === 0) { const ang = Math.round(s.steer * 10) & 0xffff; out.push(['2B0', [ang & 0xff, ang >> 8, 0x00, 0x07, ((n >> 1) & 0xf) << 4]]); }
      if (n % 5 === 0) out.push(['329', [0x40, Math.round((s.cool + 48) / 0.75), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]]);
      if (n % 4 === 0) out.push(['3B7', [s.brake ? 0x20 : 0x00, 0x00, 0x00, 0x00]]);
      if (n % 20 === 0) out.push(['545', [0xD8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]]);
      if (n % 10 === 0) { const odo = 123456 + Math.floor(s.t / 30); out.push(['420', [0x00, (odo >> 16) & 0xff, (odo >> 8) & 0xff, odo & 0xff, 0x00, 0x00, 0x00, 0x00]]); }
      return out;
    }
    _startMon() {
      this.mon = setInterval(() => {
        const lines = this._busFrames().map(([id, b]) => this._fmt(id, b));
        this.dataFns.forEach(f => f(lines.join('\r') + '\r'));
      }, 20);
    }
  }

  const api = { Elm327, AndroidTransport, WebBleTransport, WebSerialTransport, SimTransport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this);
