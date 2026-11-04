// Jalankan: node --test canbus/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../can-core.js');
const A = require('../analyze.js');
const D = require('../dbc.js');
const { Elm327, SimTransport } = require('../elm327.js');

test('label ID standard OBD dan J1939', () => {
  assert.match(A.standardLabel('7DF').name, /semua ECU/);
  assert.match(A.standardLabel('7E8').name, /Jawapan.*enjin/);
  assert.strictEqual(A.standardLabel('316'), null);
  assert.match(A.standardLabel('18DAF110', true).name, /Jawapan.*0x10/);
  const eec1 = A.standardLabel('0CF00400', true);
  assert.match(eec1.name, /EEC1/);
  const rpmSig = eec1.signals.find(s => s.name === 'SPN190');
  assert.strictEqual(rpmSig.label, 'RPM enjin');
  // RPM 1500 = 12000 * 0.125 => bait 3-4 = E0 2E
  assert.strictEqual(C.extractSignal([0xF0, 0x7D, 0x7D, 0xE0, 0x2E, 0, 0xF0, 0xFF], rpmSig), 1500);
  assert.match(A.standardLabel('18FEEE00', true).name, /ET1/);
});

test('baca dan tulis DBC', () => {
  const txt = [
    'VERSION ""', '',
    'BO_ 800 ENGINE_DATA: 8 ECM',
    ' SG_ TPS : 16|8@1+ (0.392157,0) [0|100] "%" XXX',
    ' SG_ RPM : 7|16@0+ (0.25,0) [0|8000] "rpm" XXX',
    ' SG_ MUXED m1 : 24|8@1+ (1,0) [0|0] "" XXX',
    '', 'BO_ 2364540158 J1939_X: 8 XXX',
    ' SG_ TEMP : 0|8@1- (1,-40) [-40|210] "degC" XXX',
    '', 'CM_ BO_ 800 "Data enjin";',
    'VAL_ 800 TPS 0 "tertutup" 255 "penuh" ;'
  ].join('\n');
  const db = D.parseDbc(txt);
  assert.strictEqual(db.count, 2);
  assert.strictEqual(db.skipped, 1);
  const m = db.messages['320'];
  assert.strictEqual(m.comment, 'Data enjin');
  assert.deepStrictEqual(m.signals.map(s => [s.name, s.order, s.start]), [['TPS', 'intel', 16], ['RPM', 'motorola', 7]]);
  assert.strictEqual(m.signals[0].values['255'], 'penuh');
  assert.ok(db.messages['0CF004FE'] || db.messages['8CF004FE'] === undefined);
  const ext = Object.keys(db.messages).find(k => k.length === 8);
  assert.strictEqual(ext, '0CF004FE');
  assert.strictEqual(db.messages[ext].signals[0].signed, true);
  // eksport dan baca semula
  const back = D.parseDbc(D.exportDbc({ '320': { name: 'Data enjin', signals: m.signals } }));
  assert.strictEqual(back.messages['320'].signals.length, 2);
  assert.strictEqual(back.messages['320'].signals[1].order, 'motorola');
});

test('tekaan corak: counter, kelajuan roda, data tetap', () => {
  const h = new A.History();
  for (let i = 0; i < 60; i++) {
    const v = 1000 + i * 20;
    h.add({ id: '4B0', data: [v >> 8, v & 0xff, v >> 8, (v + 3) & 0xff, v >> 8, v & 0xff, v >> 8, (v + 6) & 0xff], t: i * 20 });
    h.add({ id: '545', data: [0xD8, 0, 0, 0, 0, 0, 0, 0], t: i * 20 });
    h.add({ id: '320', data: [0, 0x1F, Math.round(50 + 40 * Math.sin(i / 5)), 0, 0x40, 0, 0, i & 0xff], t: i * 20 });
  }
  assert.match(A.guess(h.ids.get('4B0')).name, /kelajuan 4 roda/);
  assert.match(A.guess(h.ids.get('545')).name, /tetap/);
  const roles = A.byteRoles(h.ids.get('320').frames);
  assert.strictEqual(roles[2], 'analog');
  assert.strictEqual(roles[7], 'counter');
  assert.strictEqual(roles[0], 'tetap');
});

test('korelasi cari TPS dan RPM 16-bit', () => {
  const h = new A.History(1000); const tps = [], rpm = [];
  for (let i = 0; i < 80; i++) {
    const t = i * 100, p = Math.max(0, Math.sin(i / 6)), lag = Math.max(0, Math.sin((i - 4) / 6)) ** 2;
    const tv = 2 + p * 70, rv = 800 + lag * 3000; // RPM lengah & tak linear berbanding pedal
    const raw = Math.round(rv * 4);
    h.add({ id: '320', data: [0, 0x1F, Math.round(tv * 2.55), 0, 0x40, 0, 0, i & 0xff], t: t - 30 });
    h.add({ id: '316', data: [5, 0x20, raw & 0xff, raw >> 8, 0x20, 0x20, 0, (i * 37) & 0xff], t: t - 20 });
    tps.push({ t, v: tv }); rpm.push({ t, v: rv });
  }
  const a = A.correlate(tps, h);
  assert.strictEqual(a.results[0].id, '320');
  assert.strictEqual(a.results[0].label, 'bait 2');
  assert.ok(Math.abs(a.results[0].scale - 1 / 2.55) < 0.01);
  const b = A.correlate(rpm, h);
  assert.strictEqual(b.results[0].id, '316');
  assert.strictEqual(b.results[0].label, 'bait 2–3 LE');
  assert.ok(Math.abs(b.results[0].scale - 0.25) < 0.001);
  assert.match(A.correlate([{ t: 0, v: 1 }, { t: 1, v: 1 }], h).error || '', /tidak berubah/);
});

test('pembelajaran tindakan cari bit brek', () => {
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const on = Math.floor(i / 20) % 2 === 1;
    samples.push({ on, f: { id: '3B7', data: [on ? 0x20 : 0x00, i & 0x0f, 0, 0] } });
    samples.push({ on, f: { id: '545', data: [0xD8, 0, 0, 0] } });
  }
  const r = A.actionBits(samples);
  assert.strictEqual(r[0].id, '3B7');
  assert.strictEqual(r[0].byte, 0);
  assert.strictEqual(r[0].bit, 5);
  assert.strictEqual(r[0].activeHigh, true);
});

test('simulator: burst selang-seli PID + korelasi hujung ke hujung', async () => {
  const sim = new SimTransport({ latency: 1 });
  const elm = new Elm327(sim);
  await elm.init();
  const probe = await elm.probeSniff();
  assert.ok(probe.ok, probe.reason);
  const h = new A.History(2000); const ref = [];
  const t0 = Date.now();
  sim.t0 = Date.now() - 1000;
  while (Date.now() - t0 < 4000) {
    await elm.burst(120, l => { const f = C.parseCanFrame(l, Date.now()); if (f) h.add(f); });
    const r = await elm.readPid(0x11);
    if (r) ref.push({ t: Date.now(), v: r.value });
  }
  assert.ok(ref.length > 8, 'bacaan rujukan: ' + ref.length);
  const res = A.correlate(ref, h);
  assert.strictEqual(res.results[0].id, '320', JSON.stringify(res.results.slice(0, 2)));
  assert.strictEqual(res.results[0].label, 'bait 2');
});

test('asas: hanya bit baru berubah ditanda', () => {
  const b = new A.Baseline();
  b.start();
  for (let i = 0; i < 20; i++) {
    b.add({ id: '320', data: [0, 0x1F, 50 + (i % 3), 0, i & 0xff], t: i });   // bait 2 & 4 memang berubah
    b.add({ id: '3B7', data: [0x00, 0, 0, 0], t: i });
  }
  b.finish();
  assert.strictEqual(b.state, 'ready');
  assert.strictEqual(b.add({ id: '320', data: [0, 0x1F, 51, 0, 18], t: 30 }), null);   // bunyi biasa
  const c = b.add({ id: '3B7', data: [0x20, 0, 0, 0], t: 31 });                       // brek ditekan
  assert.ok(c && !c.isNew && c.mask[0] === 0x20);
  assert.ok(b.add({ id: '5A0', data: [1], t: 32 }).isNew);
  assert.deepStrictEqual([...b.changes.keys()].sort(), ['3B7', '5A0']);
});

test('cari nilai odometer 16/24-bit dan tapis', () => {
  const latest = new Map([
    ['420', [0x00, 0x01, 0xE2, 0x40, 0, 0, 0, 0]],      // 123456 km = 0x01E240 BE bait 1-3
    ['545', [0xD8, 0, 0, 0, 0, 0, 0, 0]],
    ['320', [0, 0x1F, 0x56, 0, 0x40, 0, 0, 0x10]]
  ]);
  const r = A.searchValue(latest, 123456, 0.0005);
  const hit = r.find(c => c.id === '420' && c.length === 24 && c.order === 'motorola' && c.scale === 1);
  assert.ok(hit, JSON.stringify(r.slice(0, 3)));
  assert.strictEqual(r[0].id, '420');
  latest.set('420', [0x00, 0x01, 0xE2, 0x41, 0, 0, 0, 0]);
  const r2 = A.searchValue(latest, 123457, 0.0005, r);
  assert.ok(r2.some(c => c.id === '420' && c.length === 24));
  assert.ok(r2.length <= r.length);
  // throttle 33.7% = 0x56 * 100/255
  const t = A.searchValue(latest, 33.7, 0.01);
  assert.ok(t.some(c => c.id === '320' && c.start === 16 && c.length === 8 && Math.abs(c.scale - 100 / 255) < 1e-4));
});

test('hantar bingkai: ELM327 set header dan data (simulator)', async () => {
  const sim = new (require('../elm327.js').SimTransport)({ latency: 1 });
  const elm = new (require('../elm327.js').Elm327)(sim);
  await elm.init();
  await elm.sendFrame('5A0', [1, 0, 0, 0, 0, 0, 0, 0]);
  await elm.endSend();
  assert.deepStrictEqual(sim.lastTx, { id: '5A0', data: '0100000000000000' });
});

test('imbas modul kenal pasti enjin, TCU, ABS (simulator)', async () => {
  const { Elm327, SimTransport } = require('../elm327.js');
  const elm = new Elm327(new SimTransport({ latency: 1 }));
  await elm.init();
  const r = await elm.scanModules();
  const ecus = r.modules.map(m => m.ecu).sort();
  assert.deepStrictEqual(ecus, ['7E8', '7E9', '7EA']);
  assert.ok(r.modules.find(m => m.ecu === '7E8').obd);
  assert.ok(r.modules.find(m => m.ecu === '7EA').uds);
});
