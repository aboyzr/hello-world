// Jalankan: node --test canbus/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const I18N = require('../i18n.js');

const ENGINE = /^(pid|an|j1939|elm|dtc|fuel|obdstd|mil)\.|^proto\.(name|unknown)/;

test('English lalai, tukar ke BM dan balik', () => {
  assert.strictEqual(I18N.lang, 'en');
  assert.strictEqual(I18N.t('tab.learn'), 'Learn');
  I18N.set('ms');
  assert.strictEqual(I18N.t('tab.learn'), 'Belajar');
  assert.strictEqual(I18N.t('sniff.stats', { f: 5, ids: 2, rate: 9 }), '5 bingkai · 2 ID · 9 bingkai/s');
  // teks enjin guna versi BM terbina
  assert.strictEqual(I18N.t('pid.0C', null, 'RPM enjin'), 'RPM enjin');
  I18N.set('en');
  assert.strictEqual(I18N.t('pid.0C', null, 'RPM enjin'), 'Engine RPM');
  assert.strictEqual(I18N.t('tiada.kunci', null, 'ganti'), 'ganti');
});

test('setiap kunci antara muka ada dalam kedua-dua bahasa', () => {
  const en = Object.keys(I18N.keys.en).filter(k => !ENGINE.test(k));
  const ms = Object.keys(I18N.keys.ms);
  assert.deepStrictEqual(en.filter(k => !ms.includes(k)), []);
  assert.deepStrictEqual(ms.filter(k => !en.includes(k)), []);
});

test('kunci data-i18n dalam index.html wujud', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-html|-ph)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.length > 50);
  assert.deepStrictEqual(keys.filter(k => !(k in I18N.keys.en)), []);
});

test('setiap PID ada nama English', () => {
  const C = require('../can-core.js');
  const missing = Object.keys(C.PIDS).map(Number).filter(p => !I18N.keys.en['pid.' + C.hex2(p)]);
  assert.deepStrictEqual(missing, []);
});
