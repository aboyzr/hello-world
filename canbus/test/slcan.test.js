// Jalankan: node --test canbus/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../can-core.js');
const { Slcan, encodeTx, parseRx, toTextFrame } = require('../slcan.js');

// Transport slcan palsu: strim bingkai + jawab permintaan OBD (ISO-TP)
class SlcanSim {
  constructor() { this.dataFns = []; this.closeFns = []; this.name = 'CANable (sim)'; this.open_ = false; this.writes = []; this.vin = 'PM2L9K1A0MS123456'; this.fcSeen = false; }
  open() { return Promise.resolve(); }
  onData(f) { this.dataFns.push(f); }
  onClose(f) { this.closeFns.push(f); }
  close() { this.open_ = false; if (this.mon) clearInterval(this.mon); }
  _emit(line) { setTimeout(() => this.dataFns.forEach(f => f(line + '\r')), 1); }
  _sf(id, payload) { this._emit(encodeTx(id, [payload.length, ...payload])); }
  write(s) {
    for (const cmd of s.split('\r').map(x => x.trim()).filter(Boolean)) this._cmd(cmd);
  }
  _cmd(cmd) {
    this.writes.push(cmd);
    if (cmd === 'O' || cmd === 'L') { this.open_ = true; this._startStream(); return; }
    if (cmd === 'C') { this.open_ = false; return; }
    const f = parseRx(cmd);
    if (!f) return;                       // S6, V, dll.
    if (f.id === '7DF' || /^7E0$/.test(f.id)) this._obd(f);
    if (f.id.match(/^7E[0-7]$/) && f.data[0] === 0x30) this.fcSeen = true;   // flow control
  }
  _startStream() {
    if (this.mon) return;
    let n = 0;
    this.mon = setInterval(() => {
      const rpm = (0x0CE8 + (n % 10)) & 0xffff;
      this._emit('t316' + '8' + [5, 0x20, rpm & 0xff, rpm >> 8, 0x20, 0x20, 0, 0x80].map(b => b.toString(16).padStart(2, '0')).join(''));
      this._emit('t4B0' + '8' + '01020102010201'.padEnd(16, '0'));
      n++;
    }, 10);
    if (this.mon.unref) this.mon.unref();
  }
  _obd(f) {
    const svc = f.data[1], pid = f.data[2];
    if (f.data[0] === 0x02 && svc === 0x01) {           // mod 01 single-frame
      const v = { 0x00: [0xBE, 0x3F, 0xA8, 0x13], 0x0C: [0x1A, 0xF8], 0x0D: [0x50] }[pid];
      if (v) { this._sf('7E8', [0x41, pid, ...v]); this._sf('7E9', [0x41, pid, ...v]); }
    } else if (f.data[0] === 0x02 && svc === 0x3E) {    // TesterPresent
      if (f.id === '7E0') this._sf('7E8', [0x7E, 0x00]);
    } else if (f.data[0] === 0x02 && svc === 0x09 && pid === 0x02) {  // VIN berbilang bingkai
      const ascii = [...this.vin].map(ch => ch.charCodeAt(0));
      const payload = [0x49, 0x02, 0x01, ...ascii];
      const total = payload.length;
      this._emit(encodeTx('7E8', [0x10 | (total >> 8), total & 0xff, ...payload.slice(0, 6)]));
      // tunggu FC kemudian hantar CF
      let idx = 6, sn = 1;
      const send = () => {
        if (!this.fcSeen) { setTimeout(send, 5); return; }
        while (idx < total) {
          const chunk = payload.slice(idx, idx + 7);
          this._emit(encodeTx('7E8', [0x20 | (sn & 0xf), ...chunk]));
          idx += 7; sn++;
        }
      };
      setTimeout(send, 5);
    }
  }
}

test('slcan encode / parse 11-bit dan 29-bit', () => {
  assert.strictEqual(encodeTx('316', [5, 0x20, 0xE8, 0x0C]), 't316405 20 E8 0C'.replace(/ /g, ''));
  assert.strictEqual(encodeTx('18FEF100', [1, 2]), 'T18FEF1002' + '0102');
  const f = parseRx('t31680520E80C202000 80'.replace(/ /g, ''));
  assert.deepStrictEqual(f, { id: '316', ext: false, data: [5, 0x20, 0xE8, 0x0C, 0x20, 0x20, 0, 0x80], rtr: false });
  assert.strictEqual(parseRx('T18DAF11083412340').id, '18DAF110');
  assert.strictEqual(parseRx('z'), null);
});

test('toTextFrame boleh dihurai oleh ObdCore', () => {
  const txt = toTextFrame({ id: '316', data: [5, 0x20, 0xE8, 0x0C] });
  const cf = C.parseCanFrame(txt);
  assert.strictEqual(cf.id, '316');
  assert.deepStrictEqual(cf.data, [5, 0x20, 0xE8, 0x0C]);
});

test('pemacu slcan: sniff, PID, VIN, imbas modul, hantar', async () => {
  const sim = new SlcanSim();
  const elm = new Slcan(sim);
  const info = await elm.init({ bitrate: '500' });
  assert.ok(info.protocol.can);
  assert.ok(info.ecus.includes('7E8'));
  assert.ok(sim.writes.includes('S6') && sim.writes.includes('O'));

  // sniff
  const seen = [];
  await elm.startMonitor(t => { const f = C.parseCanFrame(t); if (f) seen.push(f.id); });
  await new Promise(r => setTimeout(r, 120));
  await elm.stopMonitor();
  assert.ok(seen.includes('316') && seen.includes('4B0'));

  // PID
  const rpm = await elm.readPid(0x0C);
  assert.ok(rpm && Math.abs(rpm.value - 0x1AF8 / 4) < 5);
  const spd = await elm.readPid(0x0D);
  assert.strictEqual(spd.value, 0x50);

  // PID disokong
  const pids = await elm.supportedPids();
  assert.ok(pids.includes(0x0C) && pids.includes(0x0D));

  // VIN berbilang bingkai (perlu flow control)
  const vin = await elm.readVin();
  assert.strictEqual(vin, 'PM2L9K1A0MS123456');
  assert.ok(sim.fcSeen, 'flow control dihantar');

  // imbas modul
  const mods = await elm.scanModules();
  const ecus = mods.modules.map(m => m.ecu).sort();
  assert.ok(ecus.includes('7E8'));

  // hantar bingkai
  sim.writes = [];
  await elm.sendFrame('5A0', [1, 0]);
  assert.ok(sim.writes.includes('t5A02' + '0100'));
  sim.close();
});

test('tapis monitor mengikut ID', async () => {
  const sim = new SlcanSim();
  const elm = new Slcan(sim);
  await elm.init({ bitrate: '500' });
  const ids = new Set();
  await elm.startMonitor(t => ids.add(t.split(' ')[0]), { id: '316', mask: '7FF' });
  await new Promise(r => setTimeout(r, 120));
  await elm.stopMonitor();
  assert.ok(ids.has('316') && !ids.has('4B0'));
  sim.close();
});
