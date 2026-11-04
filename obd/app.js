'use strict';
/* global ObdCore, Elm327, AndroidTransport, WebBleTransport, WebSerialTransport, SimTransport */
const $ = id => document.getElementById(id);
const C = ObdCore;
const NATIVE = window.AndroidBridge || null;
const store = {
  get(k, d) { try { const v = localStorage.getItem('obd.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('obd.' + k, JSON.stringify(v)); } catch (e) { /* abaikan */ } }
};

let elm = null, transport = null, supported = [], busy = false;
const termLog = [];

// ---------- Umum ----------
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}
function setStatus(msg, cls) { const s = $('status'); s.textContent = msg; s.className = 'sub ' + (cls || ''); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function needConn() { if (!elm) { toast('Sambung ke dongle dulu'); showTab('conn'); return true; } return false; }

let tab = 'conn';
function showTab(name) {
  tab = name;
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'term') renderTerm();
  if (name === 'can') renderCan();
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

function logTerm(dir, text) {
  termLog.push({ dir, text });
  if (termLog.length > 400) termLog.shift();
  if (tab === 'term') renderTerm();
}
function renderTerm() {
  const out = $('termOut');
  out.innerHTML = termLog.map(l => l.dir === 'tx' ? '<span class="tx">&gt; ' + esc(l.text) + '</span>' : esc(l.text)).join('\n');
  out.scrollTop = out.scrollHeight;
}

// ---------- Sambungan ----------
if (!NATIVE && (WebBleTransport.available() || WebSerialTransport.available())) $('webBtns').hidden = false;
if (!NATIVE) { $('btnList').hidden = true; $('btnScanBle').hidden = true; }
if (!NATIVE && !document.referrer.includes('/kedai/')) $('backLink').hidden = true;
$('protoSel').value = store.get('proto', '0');
$('protoSel').addEventListener('change', e => store.set('proto', e.target.value));

async function listDevices(ble) {
  const ul = $('devList');
  ul.innerHTML = '<li class="sub">' + (ble ? 'Mencari dongle BLE (8 saat)…' : 'Membaca peranti yang telah dipair…') + '</li>';
  try {
    const list = await AndroidTransport.listDevices(ble);
    if (!list.length) { ul.innerHTML = '<li class="sub">Tiada peranti. ' + (ble ? 'Pastikan dongle dicucuk & kunci ON.' : 'Pair dongle di Tetapan Bluetooth dulu, atau cuba "Cari BLE".') + '</li>'; return; }
    const last = store.get('lastDev', null);
    list.sort((a, b) => score(b) - score(a));
    ul.innerHTML = '';
    for (const d of list) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="dev"><span><b>${esc(d.name || '(tiada nama)')}</b><span class="sub">${esc(d.address)}</span></span><span class="tag">${d.type === 'ble' ? 'BLE' : 'Classic'}${last && last.address === d.address ? ' · terakhir' : ''}</span></button>`;
      li.querySelector('button').onclick = () => connect(new AndroidTransport(d), d);
      ul.appendChild(li);
    }
  } catch (e) { ul.innerHTML = '<li class="sub">' + esc(e.message) + '</li>'; }
  function score(d) { return /obd|elm|vlink|v-link|icar|vgate|veepeak|konnwei|obdlink|scan|car/i.test(d.name || '') ? 1 : 0; }
}
$('btnList').onclick = () => listDevices(false);
$('btnScanBle').onclick = () => listDevices(true);
$('btnDemo').onclick = () => connect(new SimTransport());
$('btnWebBle').onclick = () => connect(new WebBleTransport());
$('btnSerial').onclick = () => connect(new WebSerialTransport());
$('btnDisconnect').onclick = () => disconnect('Diputuskan');

async function connect(t, dev) {
  if (busy) return;
  if (elm) await disconnect();
  busy = true;
  setStatus('Menyambung ke ' + (t.name || 'dongle') + '…');
  try {
    await t.open();
    transport = t;
    t.onClose(msg => { if (transport === t) disconnect(msg ? 'Terputus: ' + msg : 'Sambungan terputus'); });
    elm = new Elm327(t, logTerm);
    setStatus('Bersambung. Memulakan ELM327 & mencari protokol kereta…');
    const info = await elm.init($('protoSel').value);
    if (dev) store.set('lastDev', dev);
    setStatus(t.name + ' · ' + info.protocol.name, 'ok');
    supported = await elm.supportedPids().catch(() => []);
    const vin = await elm.readVin().catch(() => null);
    const volt = await elm.voltage().catch(() => null);
    const mil = await elm.readPid(0x01).catch(() => null);
    const std = supported.includes(0x1C) ? await elm.readPid(0x1C).catch(() => null) : null;
    const fuel = supported.includes(0x51) ? await elm.readPid(0x51).catch(() => null) : null;
    $('infoList').innerHTML = [
      ['Dongle', info.version], ['Protokol', info.protocol.name], ['ECU menjawab', info.ecus.join(', ') || '-'],
      ['VIN', vin || 'Tidak disokong'], ['Standard', std ? std.value : '-'], ['Jenis minyak', fuel ? fuel.value : '-'],
      ['Status', mil ? mil.value : '-'], ['Voltan bateri', volt ? volt.toFixed(1) + ' V' : '-'], ['PID disokong', supported.length]
    ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    $('infoCard').hidden = false;
    showVolt(volt);
    initGauges();
  } catch (e) {
    setStatus('Gagal: ' + e.message, 'bad');
    toast(e.message);
    await disconnect(null, true);
  } finally { busy = false; }
}

async function disconnect(msg, keepStatus) {
  stopLive();
  if (elm && elm.monitor) await elm.stopMonitor().catch(() => {});
  monStopUi();
  const t = transport; transport = null; elm = null;
  if (t) try { await t.close(); } catch (e) { /* abaikan */ }
  $('infoCard').hidden = true; $('voltPill').hidden = true;
  if (!keepStatus) setStatus(msg || 'Belum bersambung');
}
function showVolt(v) { if (v) { $('voltPill').textContent = v.toFixed(1) + ' V'; $('voltPill').hidden = false; } }

// ---------- Data langsung ----------
const DEFAULT_PIDS = [0x0C, 0x0D, 0x05, 0x04, 0x11, 0x0F, 0x10, 0x0B, 0x42, 0x2F, 0x06, 0x07];
let livePids = store.get('pids', null);
let liveOn = false; const history = {};

function initGauges() {
  if (!livePids) livePids = DEFAULT_PIDS.filter(p => supported.includes(p));
  else if (supported.length) livePids = livePids.filter(p => supported.includes(p));
  renderGauges();
}
function renderGauges() {
  const g = $('gauges'); g.innerHTML = '';
  $('liveEmpty').hidden = !!(livePids && livePids.length);
  for (const p of livePids || []) {
    const d = C.PIDS[p]; if (!d) continue;
    const el = document.createElement('div'); el.className = 'gauge'; el.id = 'g' + p;
    el.innerHTML = `<button class="x" aria-label="Buang">×</button><div class="n">${esc(d.name)}</div><div class="v">–<span class="u">${esc(d.unit)}</span></div><svg viewBox="0 0 60 20" preserveAspectRatio="none"><polyline points=""/></svg>`;
    el.querySelector('.x').onclick = () => { livePids = livePids.filter(x => x !== p); store.set('pids', livePids); renderGauges(); };
    g.appendChild(el);
  }
}
function updateGauge(r) {
  const el = $('g' + r.pid); if (!el) return;
  el.querySelector('.v').innerHTML = esc(typeof r.value === 'number' ? fmtNum(r.value) : r.value) + `<span class="u">${esc(r.unit)}</span>`;
  if (typeof r.value !== 'number') return;
  const h = history[r.pid] = (history[r.pid] || []).concat(r.value).slice(-60);
  const min = Math.min(...h), max = Math.max(...h), span = max - min || 1;
  el.querySelector('polyline').setAttribute('points', h.map((v, i) => `${i},${(19 - (v - min) / span * 18).toFixed(1)}`).join(' '));
}
const fmtNum = v => Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(Math.abs(v) >= 10 ? 1 : 2);

$('btnLive').onclick = () => { if (liveOn) stopLive(); else startLive(); };
function stopLive() { liveOn = false; $('btnLive').textContent = '▶ Mula'; $('liveRate').textContent = ''; }
async function startLive() {
  if (needConn()) return;
  if (elm.monitor) { toast('Hentikan monitor CAN dulu'); return; }
  if (!livePids || !livePids.length) { openPidPicker(); return; }
  liveOn = true; $('btnLive').textContent = '■ Henti';
  let n = 0, t0 = performance.now(), cycle = 0;
  while (liveOn && elm) {
    for (const p of livePids.slice()) {
      if (!liveOn || !elm) break;
      try { const r = await elm.readPid(p); if (r) updateGauge(r); n++; }
      catch (e) { if (!elm) break; }
    }
    if (++cycle % 10 === 0 && elm) showVolt(await elm.voltage().catch(() => null));
    const dt = (performance.now() - t0) / 1000;
    if (dt > 2) { $('liveRate').textContent = (n / dt).toFixed(1) + ' bacaan/s'; n = 0; t0 = performance.now(); }
    if (!livePids.length) break;
  }
  stopLive();
}

$('btnPickPid').onclick = openPidPicker;
function openPidPicker() {
  const list = (supported.length ? supported : Object.keys(C.PIDS).map(Number)).filter(p => C.PIDS[p]).sort((a, b) => a - b);
  $('pidPick').innerHTML = list.map(p => `<label><input type="checkbox" value="${p}" ${livePids && livePids.includes(p) ? 'checked' : ''}>${esc(C.PIDS[p].name)}<code>01${C.hex2(p)}</code></label>`).join('') || '<p class="sub">Sambung ke kereta dulu.</p>';
  $('pidDlg').showModal();
}
$('pidDlg').addEventListener('close', () => {
  livePids = [...$('pidPick').querySelectorAll('input:checked')].map(i => +i.value);
  store.set('pids', livePids); renderGauges();
});

// ---------- Kod kerosakan ----------
$('btnReadDtc').onclick = readDtcs;
async function readDtcs() {
  if (needConn()) return;
  const wasLive = liveOn; stopLive();
  if (elm.monitor) { toast('Hentikan monitor CAN dulu'); return; }
  $('btnReadDtc').disabled = true;
  try {
    const mil = await elm.readPid(0x01).catch(() => null);
    const on = mil && /HIDUP/.test(mil.value);
    $('milBox').innerHTML = mil ? `<div class="mil ${on ? 'on' : ''}"><i></i><span>Lampu enjin (MIL): <b>${on ? 'HIDUP' : 'padam'}</b> · ${esc(mil.value.split(', ')[1])}</span></div>` : '';
    for (const [mode, ul] of [['03', 'dtcStored'], ['07', 'dtcPending'], ['0A', 'dtcPerm']]) {
      const r = await elm.readDtcs(mode).catch(e => ({ error: e.message, codes: [] }));
      renderDtcs($(ul), r);
    }
  } finally { $('btnReadDtc').disabled = false; if (wasLive) startLive(); }
}
function renderDtcs(ul, r) {
  if (r.error) { ul.innerHTML = `<li class="sub">Tidak disokong / ${esc(r.error)}</li>`; return; }
  if (!r.codes.length) { ul.innerHTML = '<li class="sub">✓ Tiada kod</li>'; return; }
  ul.innerHTML = r.codes.map(c => `<li class="dtc"><code>${c.code}</code><span>${esc(c.text)}</span><span class="ecu">${esc(c.ecu)}</span></li>`).join('');
}
$('btnClearDtc').onclick = async () => {
  if (needConn()) return;
  if (!confirm('Padam semua kod kerosakan dan matikan lampu enjin?\n\nData freeze-frame & status monitor emisi juga akan dikosongkan. Enjin sebaiknya MATI (kunci ON).')) return;
  stopLive();
  const ok = await elm.clearDtcs().catch(() => false);
  toast(ok ? 'Kod dipadam' : 'Gagal padam kod');
  if (ok) readDtcs();
};

// ---------- Monitor CAN ----------
const ids = new Map(); let frameCount = 0, monT0 = 0, recording = null, renderPending = false;
let signals = store.get('signals', [
  { name: 'Contoh: RPM (ID 316)', id: '316', start: 16, length: 16, order: 'intel', signed: false, scale: 0.25, offset: 0, unit: 'rpm' }
]);

$('btnMon').onclick = async () => {
  if (elm && elm.monitor) { await elm.stopMonitor().catch(() => {}); monStopUi(); return; }
  if (needConn()) return;
  stopLive();
  const id = $('filtId').value.trim().toUpperCase(), mask = $('filtMask').value.trim().toUpperCase();
  if ((id && !/^[0-9A-F]{1,8}$/.test(id)) || (mask && !/^[0-9A-F]{1,8}$/.test(mask))) { toast('ID / mask mesti hex'); return; }
  ids.clear(); frameCount = 0; monT0 = performance.now(); $('canTable').innerHTML = '';
  try {
    await elm.startMonitor(onCanLine, id ? { id, mask } : null, () => { $('canStats').textContent = 'BUFFER FULL — terlalu banyak trafik, guna tapis ID.'; });
    $('btnMon').textContent = '■ Henti';
  } catch (e) { toast(e.message); }
};
function monStopUi() { $('btnMon').textContent = '▶ Tangkap'; }

function onCanLine(line) {
  const now = performance.now();
  const f = C.parseCanFrame(line, now);
  if (!f) return;
  frameCount++;
  let e = ids.get(f.id);
  if (!e) { e = { id: f.id, count: 0, data: [], prev: [], changed: [], times: [] }; ids.set(f.id, e); }
  e.count++;
  e.changed = f.data.map((b, i) => (e.data[i] !== undefined && e.data[i] !== b) ? now : (e.changed[i] || 0));
  e.prev = e.data; e.data = f.data;
  e.times.push(now); while (e.times.length && now - e.times[0] > 2000) e.times.shift();
  if (recording) {
    recording.push([((now - monT0) / 1000).toFixed(3), f.id, f.data.length, f.data.map(C.hex2).join(' ')]);
    if (recording.length >= 200000) { toast('Had rakaman dicapai'); toggleRec(); }
  }
  if (!renderPending) { renderPending = true; requestAnimationFrame(renderCan); }
}

function renderCan() {
  renderPending = false;
  if (tab !== 'can') return;
  const now = performance.now();
  const rows = [...ids.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  $('canTable').innerHTML = '<div class="can-row head"><span>ID</span><span>Data (bait 0–7)</span><span class="hz">Hz</span></div>' +
    rows.map(e => `<div class="can-row"><span class="id">${e.id}</span><span>${e.data.map((b, i) => `<span class="b${now - e.changed[i] < 400 ? ' chg' : ''}">${C.hex2(b)}</span>`).join(' ')}</span><span class="hz">${(e.times.length / 2).toFixed(0)}</span></div>`).join('');
  const secs = (now - monT0) / 1000;
  $('canStats').textContent = `${frameCount} bingkai · ${ids.size} ID · ${(frameCount / Math.max(secs, 0.1)).toFixed(0)} bingkai/s` + (recording ? ` · merakam ${recording.length}` : '');
  renderSignalValues();
}

function renderSignals() {
  $('sigList').innerHTML = signals.map((s, i) => `<li class="sig"><span><b>${esc(s.name)}</b><br><span class="sub">ID ${esc(s.id)} · bit ${s.start}/${s.length} · ${s.order} · ×${s.scale} ${s.offset >= 0 ? '+' : ''}${s.offset}</span></span><span class="val" id="sv${i}">–</span><button data-i="${i}" aria-label="Buang">×</button></li>`).join('')
    || '<li class="sub">Tiada isyarat. Tekan "＋ Isyarat" untuk nyahkod bait CAN kepada nilai sebenar.</li>';
  $('sigList').querySelectorAll('button').forEach(b => b.onclick = () => { signals.splice(+b.dataset.i, 1); store.set('signals', signals); renderSignals(); });
  renderSignalValues();
}
function renderSignalValues() {
  signals.forEach((s, i) => {
    const e = ids.get(s.id.toUpperCase()); const el = $('sv' + i);
    if (!el || !e) return;
    const v = C.extractSignal(e.data, s);
    el.textContent = v == null ? 'luar julat' : fmtNum(v) + ' ' + (s.unit || '');
  });
}
$('btnAddSig').onclick = () => { $('sigForm').reset(); $('sigDlg').showModal(); };
$('sigDlg').addEventListener('close', () => {
  if ($('sigDlg').returnValue !== 'ok') return;
  const f = new FormData($('sigForm'));
  const id = String(f.get('id')).trim().toUpperCase();
  if (!/^[0-9A-F]{1,8}$/.test(id)) { toast('ID CAN mesti hex'); return; }
  signals.push({ name: f.get('name'), id, start: +f.get('start'), length: +f.get('length'), order: f.get('order'), signed: !!f.get('signed'), scale: +f.get('scale') || 1, offset: +f.get('offset') || 0, unit: f.get('unit') });
  store.set('signals', signals); renderSignals();
});

$('btnRec').onclick = toggleRec;
function toggleRec() {
  if (recording) { $('btnRec').textContent = '● Rakam'; $('btnExport').disabled = !recording.length; lastRec = recording; recording = null; return; }
  recording = []; $('btnRec').textContent = '■ Henti rakam'; $('btnExport').disabled = true;
}
let lastRec = null;
$('btnExport').onclick = () => {
  if (!lastRec || !lastRec.length) return;
  const csv = 'masa_s,id,dlc,data\n' + lastRec.map(r => r.join(',')).join('\n');
  const name = 'can-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
  if (NATIVE && NATIVE.saveFile) NATIVE.saveFile(name, 'text/csv', btoa(unescape(encodeURIComponent(csv))));
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
};

// ---------- Terminal ----------
const CHIPS = ['ATI', 'ATDP', 'ATRV', '0100', '010C', '010D', '0105', '03', '07', '0902', 'ATSH7E0', 'ATCRA'];
$('termChips').innerHTML = CHIPS.map(c => `<button type="button">${c}</button>`).join('');
$('termChips').querySelectorAll('button').forEach(b => b.onclick = () => { $('termIn').value = b.textContent; $('termForm').requestSubmit(); });
$('termForm').addEventListener('submit', async e => {
  e.preventDefault();
  const cmd = $('termIn').value.trim().toUpperCase();
  if (!cmd || needConn()) return;
  if (elm.monitor) { toast('Hentikan monitor CAN dulu'); return; }
  $('termIn').value = '';
  try {
    const raw = await elm.send(cmd, 8000);
    if (/^[0-9A-F]{2,}$/.test(cmd.replace(/\s/g, ''))) {
      const r = C.parseResponse(raw, elm.protocol);
      for (const m of r.messages) {
        const b = m.bytes;
        let note = `[${m.ecu}] ${b.map(C.hex2).join(' ')}`;
        if (b[0] === 0x41) { const d = C.decodePid(b[1], b.slice(2)); if (d) note += `  → ${d.name}: ${d.value} ${d.unit}`; }
        if (b[0] === 0x43 || b[0] === 0x47 || b[0] === 0x4A) note += '  → ' + (C.decodeDtcs(b, elm.protocol.can).join(', ') || 'tiada kod');
        if (b[0] === 0x49 && b[1] === 0x02) note += '  → VIN ' + C.decodeVin(b);
        logTerm('rx', '  ' + note);
      }
    }
  } catch (err) { logTerm('rx', '! ' + err.message); }
});

// ---------- Mula ----------
window.nativeBack = () => {
  const d = document.querySelector('dialog[open]');
  if (d) { d.close(); return true; }
  if (tab !== 'conn') { showTab('conn'); return true; }
  location.href = '../kedai/index.html';
  return true;
};
renderSignals();
renderGauges();
