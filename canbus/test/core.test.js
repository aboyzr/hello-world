// Jalankan: node --test canbus/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../can-core.js');
const { Elm327, SimTransport } = require('../elm327.js');

test('PID tunggal CAN 11-bit (RPM, suhu)', () => {
  const r = C.parseResponse('7E8 04 41 0C 1A F8 \r\r>', '6');
  assert.deepStrictEqual(r.messages, [{ ecu: '7E8', bytes: [0x41, 0x0C, 0x1A, 0xF8] }]);
  assert.strictEqual(C.decodePid(0x0C, [0x1A, 0xF8]).value, 1726);
  assert.strictEqual(C.decodePid(0x05, [0x7B]).value, 83);
});

test('jawapan tanpa ruang (ATS0) dan beberapa ECU', () => {
  const r = C.parseResponse('7E8064100BE3FA813\r7E9064100983B8011\r', '6');
  assert.strictEqual(r.messages.length, 2);
  assert.deepStrictEqual(r.messages[1], { ecu: '7E9', bytes: [0x41, 0x00, 0x98, 0x3B, 0x80, 0x11] });
});

test('CAN 29-bit', () => {
  const r = C.parseResponse('18 DA F1 10 03 41 0D 3C', '7');
  assert.deepStrictEqual(r.messages, [{ ecu: '18DAF110', bytes: [0x41, 0x0D, 0x3C] }]);
});

test('ralat dan SEARCHING', () => {
  assert.strictEqual(C.parseResponse('SEARCHING...\rNO DATA\r\r>', '6').error, 'NO DATA');
  assert.strictEqual(C.parseResponse('SEARCHING...\r7E8 03 41 0D 32', '6').messages[0].bytes[2], 0x32);
});

test('VIN berbilang bingkai ISO-TP', () => {
  const raw = '7E8 10 14 49 02 01 31 47 31\r7E8 21 4A 43 35 34 34 34 52\r7E8 22 37 32 35 32 33 36 37\r';
  const m = C.parseResponse(raw, '6').messages[0];
  assert.strictEqual(m.bytes.length, 20);
  assert.strictEqual(C.decodeVin(m.bytes), '1G1JC5444R7252367');
});

test('DTC CAN dan protokol lama', () => {
  const can = C.parseResponse('7E8 06 43 02 03 01 04 20', '6').messages[0];
  assert.deepStrictEqual(C.decodeDtcs(can.bytes, true), ['P0301', 'P0420']);
  const old = C.parseResponse('48 6B 10 43 01 33 C1 23 00 00 E8\r', '3').messages[0];
  assert.deepStrictEqual(C.decodeDtcs(old.bytes, false), ['P0133', 'U0123']);
  assert.strictEqual(C.dtcFromBytes(0x41, 0x21), 'C0121');
  assert.match(C.describeDtc('P0420'), /catalyst/);
  assert.match(C.describeDtc('P1234'), /pengeluar/);
});

test('PID disokong', () => {
  const l = C.decodeSupported(0, [0xBE, 0x1F, 0xA8, 0x13]);
  assert.deepStrictEqual(l.slice(0, 6), [1, 3, 4, 5, 6, 7]);
  assert.ok(l.includes(0x20));
});

test('bingkai CAN mentah', () => {
  assert.deepStrictEqual(C.parseCanFrame('316 05 20 E8 0C 20 20 00 80'), { id: '316', ext: false, data: [5, 0x20, 0xE8, 0x0C, 0x20, 0x20, 0, 0x80], t: 0 });
  assert.strictEqual(C.parseCanFrame('18 FE F1 00 01 02').id, '18FEF100');
  assert.strictEqual(C.parseCanFrame('SEARCHING...'), null);
});

test('isyarat Intel dan Motorola', () => {
  const d = [0x05, 0x20, 0xE8, 0x0C, 0, 0, 0, 0];
  // RPM = bait 2-3 little endian / 4
  assert.strictEqual(C.extractSignal(d, { start: 16, length: 16, order: 'intel', scale: 0.25 }), 0x0CE8 / 4);
  // Motorola: MSB bit 23 (bait 2 bit 7), 16 bit => 0xE80C
  assert.strictEqual(C.extractSignal(d, { start: 23, length: 16, order: 'motorola' }), 0xE80C);
  assert.strictEqual(C.extractSignal([0xFF, 0xFF], { start: 0, length: 16, signed: true }), -1);
  assert.strictEqual(C.extractSignal([0x10], { start: 4, length: 4 }), 1);
});

test('pemacu ELM327 dengan simulator', async () => {
  const elm = new Elm327(new SimTransport({ latency: 1 }));
  const info = await elm.init();
  assert.ok(info.protocol.can);
  assert.deepStrictEqual(info.ecus, ['7E8']);
  const pids = await elm.supportedPids();
  assert.ok(pids.includes(0x0C) && pids.includes(0x42));
  const rpm = await elm.readPid(0x0C);
  assert.ok(rpm.value >= 700 && rpm.value <= 4100);
  assert.strictEqual(await elm.readVin(), 'PM2L9K1A0MS123456');
  const d = await elm.readDtcs('03');
  assert.deepStrictEqual(d.codes.map(c => c.code), ['P0301', 'P0420']);
  assert.ok(await elm.clearDtcs());
  assert.strictEqual((await elm.readDtcs('03')).codes.length, 0);
  const frames = [];
  await elm.startMonitor(l => { const f = C.parseCanFrame(l); if (f) frames.push(f); });
  await new Promise(r => setTimeout(r, 300));
  await elm.stopMonitor();
  assert.ok(frames.some(f => f.id === '316'));
  assert.ok((await elm.voltage()) > 12);
});
