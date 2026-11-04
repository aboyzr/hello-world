'use strict';
/* global ObdCore, Analyze, Dbc, Elm327, AndroidTransport, WebBleTransport, WebSerialTransport, SimTransport */
const $ = id => document.getElementById(id);
const C = ObdCore, A = Analyze;
const NATIVE = window.AndroidBridge || null;
const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('canbus.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('canbus.' + k, JSON.stringify(v)); } catch (e) { /* storan penuh / disekat */ } }
};

let elm = null, transport = null, supported = [], busy = false, sniffOk = null;
const hist = new A.History(3000);
let frameCount = 0, frameT0 = now();

// ---------- Umum ----------
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}
function setStatus(msg, bad) { const s = $('status'); s.textContent = msg || ''; s.hidden = !msg; s.classList.toggle('bad', !!bad); }
function setPill(text, ok) { const p = $('pill'); p.textContent = text; p.classList.toggle('ok', !!ok); }
function fmt(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  const a = Math.abs(v);
  return a >= 1000 ? Math.round(v).toString() : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}
function needConn() { if (!elm) { toast('Sambung ke dongle dulu (atau tekan Demo)'); showTab('conn'); return true; } return false; }
function needCan() {
  if (needConn()) return true;
  if (!elm.protocol.can) { toast('Kereta ini bukan protokol CAN. Hanya graf PID boleh.'); return true; }
  return false;
}
function keepScreen(on) { if (NATIVE && NATIVE.keepScreenOn) NATIVE.keepScreenOn(!!on); }

// Dialog tanya (ganti confirm/prompt)
function ask(title, text, opts) {
  opts = opts || {};
  return new Promise(res => {
    const d = $('askDlg');
    $('askTitle').textContent = title; $('askText').textContent = text || '';
    const inp = $('askInput'); inp.hidden = !opts.input; inp.value = opts.value || ''; inp.placeholder = opts.placeholder || '';
    $('askOk').textContent = opts.ok || 'OK';
    d.onclose = () => res(d.returnValue === 'yes' ? (opts.input ? inp.value.trim() : true) : false);
    d.returnValue = ''; d.showModal();
    if (opts.input) setTimeout(() => inp.focus(), 50);
  });
}

let tab = 'conn';
function showTab(name) {
  tab = name;
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  render(true);
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Profil kereta & label ID ----------
let profiles = store.get('profiles', null) || { current: 'Kereta saya', list: { 'Kereta saya': { labels: {} } } };
const profile = () => profiles.list[profiles.current];
const saveProfiles = () => store.set('profiles', profiles);
function renderProfiles() {
  $('profileSel').innerHTML = Object.keys(profiles.list).map(n => `<option ${n === profiles.current ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
$('profileSel').onchange = e => { profiles.current = e.target.value; saveProfiles(); refreshGraphIndex(); render(true); };
$('btnNewProfile').onclick = async () => {
  const name = await ask('Profil kereta baru', 'Contoh: Myvi 2018 1.5, Saga VVT 2020. Label ID disimpan ikut profil.', { input: true, placeholder: 'Nama kereta', ok: 'Cipta' });
  if (!name) return;
  if (!profiles.list[name]) profiles.list[name] = { labels: {} };
  profiles.current = name; saveProfiles(); renderProfiles(); render(true);
};

function signalBytes(sig) {
  const set = new Set();
  if (sig.order === 'motorola') {
    let bit = sig.start;
    for (let i = 0; i < sig.length; i++) { set.add(bit >> 3); bit = (bit & 7) === 0 ? bit + 15 : bit - 1; }
  } else for (let b = sig.start; b < sig.start + sig.length; b++) set.add(b >> 3);
  return [...set].sort((a, b) => a - b);
}
function sigValueText(sig, data) {
  const v = C.extractSignal(data, sig);
  if (v == null) return '–';
  if (sig.values && sig.values[String(Math.round(v))] !== undefined) return sig.values[String(Math.round(v))];
  return fmt(v) + (sig.unit ? ' ' + sig.unit : '');
}

// Gabung semua sumber label: profil (dipelajari / DBC / sendiri) > standard > tekaan
const guessCache = new Map();
function labelFor(id) {
  const e = hist.ids.get(id);
  const p = profile().labels[id];
  const std = A.standardLabel(id, e ? e.ext : id.length > 3);
  if (p && (p.name || (p.signals && p.signals.length))) {
    return { name: p.name || (std && std.name) || 'ID ' + id, source: p.source || 'user', detail: p.detail || '', signals: (p.signals || []).concat(std && std.signals ? std.signals.filter(s => !(p.signals || []).some(x => x.name === s.name)) : []) };
  }
  if (std) return { name: std.name, source: 'std', detail: std.detail || 'ID standard', signals: std.signals || [] };
  const g = guessCache.get(id) || (e ? A.guess(e) : null);
  if (g && g.conf) return { name: g.name, source: 'guess', detail: 'Tekaan ' + Math.round(g.conf * 100) + '%' + (g.detail ? ' · ' + g.detail : ''), signals: [], roles: g.roles };
  return { name: g ? g.name : 'Belum dikenal', source: 'unk', detail: '', signals: [] };
}
const SRC = { std: 'Standard', dbc: 'DBC', learn: 'Dipelajari', guess: 'Tekaan', user: 'Sendiri', unk: 'Belum dikenal' };

// ---------- Sambungan ----------
if (!NATIVE && (WebBleTransport.available() || WebSerialTransport.available())) $('webBtns').hidden = false;
if (!NATIVE) { $('btnList').hidden = true; $('btnScanBle').hidden = true; }
$('protoSel').value = store.get('proto', '0');
$('protoSel').addEventListener('change', e => store.set('proto', e.target.value));

const termLog = [];
function logTerm(dir, text) {
  if (engine && (engine.kind !== 'term')) return; // jangan banjirkan terminal semasa tangkap
  termLog.push({ dir, text }); if (termLog.length > 300) termLog.shift();
  const out = $('termOut');
  out.innerHTML = termLog.map(l => l.dir === 'tx' ? '<span class="tx">&gt; ' + esc(l.text) + '</span>' : esc(l.text)).join('\n');
  out.scrollTop = out.scrollHeight;
}

async function listDevices(ble) {
  const ul = $('devList');
  ul.innerHTML = '<li class="sub">' + (ble ? 'Mencari dongle BLE (8 saat)…' : 'Membaca peranti yang telah dipair…') + '</li>';
  try {
    const list = await AndroidTransport.listDevices(ble);
    if (!list.length) { ul.innerHTML = '<li class="sub">Tiada peranti. ' + (ble ? 'Pastikan dongle dicucuk dan kunci ON.' : 'Pair dongle di Tetapan Bluetooth dulu, atau cuba Cari BLE.') + '</li>'; return; }
    const last = store.get('lastDev', null);
    const score = d => /obd|elm|dollar|vlink|v-link|icar|vgate|veepeak|konnwei|obdlink|scan|car|ios-vlink/i.test(d.name || '') ? 1 : 0;
    list.sort((a, b) => score(b) - score(a));
    ul.innerHTML = '';
    for (const d of list) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="dev"><span><b>${esc(d.name || '(tiada nama)')}</b><span class="sub mono">${esc(d.address)}</span></span><span class="tag">${d.type === 'ble' ? 'BLE' : 'Classic'}${last && last.address === d.address ? ' · terakhir' : ''}</span></button>`;
      li.querySelector('button').onclick = () => connect(new AndroidTransport(d), d);
      ul.appendChild(li);
    }
  } catch (e) { ul.innerHTML = '<li class="sub">' + esc(e.message) + '</li>'; }
}
$('btnList').onclick = () => listDevices(false);
$('btnScanBle').onclick = () => listDevices(true);
$('btnDemo').onclick = () => connect(new SimTransport());
$('btnWebBle').onclick = () => connect(new WebBleTransport());
$('btnSerial').onclick = () => connect(new WebSerialTransport());
$('btnDisconnect').onclick = () => disconnect();

async function connect(t, dev) {
  if (busy) return;
  if (elm) await disconnect();
  busy = true;
  setStatus('Menyambung ke ' + (t.name || 'dongle') + '…');
  try {
    await t.open();
    transport = t;
    t.onClose(msg => { if (transport === t) { disconnect(); setStatus(msg ? 'Terputus: ' + msg : 'Sambungan terputus', true); } });
    elm = new Elm327(t, logTerm);
    setStatus('Memulakan ELM327 dan mencari protokol kereta (boleh ambil 10 saat)…');
    const info = await elm.init($('protoSel').value);
    if (dev) store.set('lastDev', dev);
    setPill('● ' + (info.protocol.can ? 'CAN ' + (info.protocol.ext ? '29-bit' : '11-bit') : info.protocol.name), true);
    supported = await elm.supportedPids().catch(() => []);
    const vin = await elm.readVin().catch(() => null);
    const volt = await elm.voltage().catch(() => null);
    setStatus('Menguji mod sniff…');
    const probe = await elm.probeSniff().catch(e => ({ ok: false, reason: e.message }));
    sniffOk = probe.ok;
    setStatus('');
    $('infoList').innerHTML = [
      ['Dongle', esc(t.name)], ['Cip', esc(info.version || '-')], ['Protokol', esc(info.protocol.name)],
      ['ECU menjawab', esc(info.ecus.join(', ') || '-')], ['VIN', esc(vin || 'Tidak disokong')],
      ['Voltan bateri', volt ? volt.toFixed(1) + ' V' : '-'], ['PID disokong', supported.length],
      ['Mod sniff (ATMA)', probe.ok ? `<span class="ok">Disokong · ${probe.frames} bingkai dalam 0.8 s</span>` : `<span class="bad">${esc(probe.reason)}</span>`]
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('infoCard').hidden = false;
    $('btnDemoDbc').hidden = !(t instanceof SimTransport);
    fillLearnPids();
    toast(probe.ok ? 'Bersambung. Cuba tab Sniff atau Belajar.' : 'Bersambung. Sniff tidak tersedia, tapi graf PID boleh.');
  } catch (e) {
    setStatus('Gagal: ' + e.message, true);
    await disconnect(true);
  } finally { busy = false; }
}

async function disconnect(keepStatus) {
  await stopEngine();
  const t = transport; transport = null; elm = null; sniffOk = null;
  if (t) try { await t.close(); } catch (e) { /* abaikan */ }
  $('infoCard').hidden = true; $('btnDemoDbc').hidden = true;
  setPill('Belum bersambung');
  if (!keepStatus) setStatus('');
  updateButtons();
}

// ---------- Enjin tangkapan (satu mod pada satu masa) ----------
let engine = null;
async function stopEngine() {
  if (!engine) return;
  engine.stop = true;
  try { await engine.done; } catch (e) { /* abaikan */ }
}
function startEngine(kind, fn) {
  const eng = { kind, stop: false, t0: now() };
  engine = eng; keepScreen(true); updateButtons();
  eng.done = fn(eng).catch(e => { if (elm) toast(e.message); })
    .finally(async () => {
      if (elm && elm.monitor) await elm.stopMonitor().catch(() => {});
      if (engine === eng) engine = null;
      keepScreen(false); updateButtons();
      if (eng.after) eng.after();
    });
}
async function sniffUntilStop(eng, filter) {
  await elm.startMonitor(onLine, filter, () => toast('BUFFER FULL: terlalu banyak trafik. Guna tapis ID.'), () => { toast('Dongle tidak sokong ATMA'); eng.stop = true; });
  while (!eng.stop && elm) await sleep(100);
  if (elm) await elm.stopMonitor();
}

function onLine(line) {
  const f = C.parseCanFrame(line, now());
  if (!f) return;
  frameCount++;
  const e = hist.add(f);
  e.arr = e.arr || []; e.arr.push(f.t); while (e.arr.length && f.t - e.arr[0] > 2000) e.arr.shift();
  if (engine && !engine.burst) e.hz = e.arr.length / 2;
  if (recording) {
    recording.push([((f.t - recT0) / 1000).toFixed(3), f.id, f.data.length, f.data.map(C.hex2).join(' ')]);
    if (recording.length >= 200000) { toast('Had rakaman dicapai'); toggleRec(); }
  }
  if (act.running) act.samples.push({ on: act.on, f });
  const keys = graphIndex.get(f.id);
  if (keys) for (const k of keys) { const s = sigByKey(k); const v = s && C.extractSignal(f.data, s); if (v != null) pushSeries(k, f.t, v, f.data); }
}

function updateButtons() {
  const k = engine && engine.kind;
  $('btnSniff').textContent = k === 'sniff' ? '■ Henti' : '▶ Tangkap';
  $('btnGraf').textContent = k === 'graf' ? '■ Henti' : '▶ Mula';
  $('btnLearn').textContent = k === 'learn' ? '■ Henti & lihat hasil' : '▶ Mula belajar';
  $('btnAct').textContent = k === 'act' ? '■ Henti & lihat hasil' : '▶ Mula tangkap';
  $('btnActOn').disabled = k !== 'act';
  if (k !== 'act') { act.on = false; $('btnActOn').classList.remove('on'); $('btnActOn').textContent = 'Saya sedang buat'; }
}

// ---------- SNIFF ----------
let recording = null, lastRec = null, recT0 = 0;
$('btnSniff').onclick = async () => {
  if (engine && engine.kind === 'sniff') return stopEngine();
  if (needCan()) return;
  const id = $('filtId').value.trim().toUpperCase(), mask = $('filtMask').value.trim().toUpperCase();
  if ((id && !/^[0-9A-F]{1,8}$/.test(id)) || (mask && !/^[0-9A-F]{1,8}$/.test(mask))) { toast('ID dan mask mesti nombor hex'); return; }
  await stopEngine();
  frameCount = 0; frameT0 = now();
  startEngine('sniff', eng => sniffUntilStop(eng, id ? { id, mask } : null));
};
$('btnRec').onclick = toggleRec;
function toggleRec() {
  if (recording) { lastRec = recording; recording = null; $('btnRec').textContent = '● Rakam'; $('btnCsv').disabled = !lastRec.length; toast(lastRec.length + ' bingkai dirakam'); return; }
  recording = []; recT0 = now(); $('btnRec').textContent = '■ Henti rakam'; $('btnCsv').disabled = true;
  if (!engine) toast('Tekan Tangkap untuk mula menerima bingkai');
}
$('btnCsv').onclick = () => {
  if (!lastRec || !lastRec.length) return;
  const rows = lastRec.map(r => r.join(','));
  saveText('can-log-' + stamp() + '.csv', 'text/csv', 'masa_s,id,dlc,data\n' + rows.join('\n'));
};
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
function saveText(name, mime, text) {
  if (NATIVE && NATIVE.saveFile) { NATIVE.saveFile(name, mime, btoa(unescape(encodeURIComponent(text)))); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const sortIds = () => [...hist.ids.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
const prevData = new Map(), changedAt = new Map();
function renderSniff() {
  const t = now(), rows = sortIds();
  for (const e of rows) {
    const last = e.frames[e.frames.length - 1].data, prev = prevData.get(e.id) || [], ch = changedAt.get(e.id) || [];
    last.forEach((b, i) => { if (prev[i] !== undefined && prev[i] !== b) ch[i] = t; });
    prevData.set(e.id, last); changedAt.set(e.id, ch);
  }
  $('sniffTable').innerHTML = rows.length ? '<div class="srow head"><span>ID</span><span>Data (bait 0–7)</span><span class="hz">Hz</span></div>' + rows.map(e => {
    const d = e.frames[e.frames.length - 1].data, ch = changedAt.get(e.id) || [], g = guessCache.get(e.id), roles = (g && g.roles) || [];
    const lbl = labelFor(e.id);
    return `<button class="srow" data-id="${e.id}"><span class="id">${e.id}<small>${lbl.source === 'unk' || lbl.source === 'guess' ? '' : esc(lbl.name)}</small></span><span>${d.map((b, i) => `<span class="b${t - (ch[i] || 0) < 400 ? ' chg' : ''}${roles[i] ? ' r-' + roles[i] : ''}">${C.hex2(b)}</span>`).join(' ')}</span><span class="hz">${e.hz ? Math.round(e.hz) : '–'}</span></button>`;
  }).join('') : '';
  const secs = (t - frameT0) / 1000;
  if (engine && engine.kind === 'sniff') $('sniffStats').textContent = `${frameCount} bingkai · ${hist.ids.size} ID · ${(frameCount / Math.max(secs, 0.1)).toFixed(0)} bingkai/s` + (recording ? ` · merakam ${recording.length}` : '');
}
$('sniffTable').addEventListener('click', e => { const r = e.target.closest('.srow[data-id]'); if (r) openIdDialog(r.dataset.id); });

// ---------- KENAL ID ----------
function renderIds() {
  const rows = sortIds();
  const known = Object.keys(profile().labels).filter(id => !hist.ids.has(id));
  const counts = { std: 0, dbc: 0, learn: 0, user: 0, guess: 0, unk: 0 };
  const html = rows.map(e => {
    const l = labelFor(e.id); counts[l.source]++;
    const d = e.frames[e.frames.length - 1].data;
    const sv = l.signals.slice(0, 4).map(s => esc(s.name) + ': ' + esc(sigValueText(s, d))).join(' · ');
    return `<button class="idc" data-id="${e.id}"><span class="i">${e.id}</span><span class="f">${esc(l.name)}</span><span class="src s-${l.source}">${SRC[l.source]}</span>`
      + `<span class="d">${esc(l.detail || '')}${l.detail ? ' · ' : ''}${d.map(C.hex2).join(' ')}</span>${sv ? `<span class="sv">${sv}</span>` : ''}</button>`;
  }).join('');
  $('idList').innerHTML = html + (known.length ? `<h3 class="sec">Label dalam profil (belum dikesan sesi ini)</h3>` + known.sort().map(id => {
    const l = profile().labels[id];
    return `<button class="idc" data-id="${id}"><span class="i">${id}</span><span class="f">${esc(l.name || '(tanpa nama)')}</span><span class="src s-${l.source || 'user'}">${SRC[l.source || 'user']}</span><span class="d">${(l.signals || []).length} isyarat</span></button>`;
  }).join('') : '');
  $('idsStats').textContent = rows.length
    ? `${rows.length} ID dikesan · ${counts.std} standard · ${counts.dbc} DBC · ${counts.learn} dipelajari · ${counts.user} sendiri · ${counts.guess} tekaan · ${counts.unk} belum dikenal`
    : 'Belum ada ID. Mula Sniff atau Belajar untuk mengesan ID di bas CAN.';
}
$('idList').addEventListener('click', e => { const r = e.target.closest('.idc[data-id]'); if (r) openIdDialog(r.dataset.id); });

let dlgId = null, dlgSigs = [];
function openIdDialog(id) {
  dlgId = id;
  const p = profile().labels[id] || {};
  const l = labelFor(id);
  const e = hist.ids.get(id);
  dlgSigs = (p.signals || []).map(s => Object.assign({}, s));
  $('idDlgTitle').textContent = 'ID ' + id + ' · ' + SRC[l.source];
  $('idDlgRaw').textContent = e ? 'Data terkini: ' + e.frames[e.frames.length - 1].data.map(C.hex2).join(' ') + ' · ' + e.count + ' bingkai' : 'Belum dikesan sesi ini';
  $('idName').value = p.name || '';
  $('idName').placeholder = l.name;
  $('btnDelLabel').hidden = !profile().labels[id];
  renderDlgSigs(l);
  $('idDlg').showModal();
}
function renderDlgSigs(l) {
  const e = hist.ids.get(dlgId); const d = e ? e.frames[e.frames.length - 1].data : [];
  const std = (l && l.source === 'std' ? l.signals : (A.standardLabel(dlgId, dlgId.length > 3) || {}).signals) || [];
  $('idSigs').innerHTML = dlgSigs.map((s, i) => `<li class="sigrow"><span><b>${esc(s.name)}</b> = ${esc(sigValueText(s, d))}<br><span class="sub mono">bit ${s.start}/${s.length} ${s.order} ×${s.scale} ${s.offset >= 0 ? '+' : ''}${s.offset} · ${SRC[s.source] || 'Sendiri'}</span></span><button type="button" class="x" data-i="${i}" aria-label="Buang isyarat">×</button></li>`).join('')
    + std.map(s => `<li class="sigrow"><span><b>${esc(s.name)}</b> = ${esc(sigValueText(s, d))}<br><span class="sub mono">J1939 standard · bit ${s.start}/${s.length}</span></span></li>`).join('')
    || '<li class="sub">Tiada isyarat lagi. Guna tab Belajar, import DBC, atau tambah manual.</li>';
  $('idSigs').querySelectorAll('button.x').forEach(b => b.onclick = () => { dlgSigs.splice(+b.dataset.i, 1); renderDlgSigs(); });
}
$('btnAddSig').onclick = () => {
  const name = $('sgName').value.trim();
  if (!name) { toast('Isi nama isyarat'); return; }
  const s = { name, id: dlgId, start: +$('sgStart').value, length: +$('sgLen').value, order: $('sgOrder').value, signed: !!$('sgSigned').value, scale: +$('sgScale').value || 1, offset: +$('sgOffset').value || 0, unit: $('sgUnit').value.trim(), source: 'user' };
  if (!(s.length >= 1 && s.length <= 32 && s.start >= 0 && s.start <= 63)) { toast('Bit mula 0–63, panjang 1–32'); return; }
  dlgSigs.push(s); $('sgName').value = ''; renderDlgSigs();
};
$('btnDelLabel').onclick = async () => {
  const id = dlgId; $('idDlg').close('cancel');
  if (await ask('Padam label ID ' + id + '?', 'Nama dan isyarat untuk ID ini dalam profil "' + profiles.current + '" akan dibuang.', { ok: 'Padam' })) {
    delete profile().labels[id]; saveProfiles(); refreshGraphIndex(); render(true);
  }
};
$('idDlg').addEventListener('close', () => {
  if ($('idDlg').returnValue !== 'ok' || !dlgId) return;
  const name = $('idName').value.trim();
  const old = profile().labels[dlgId];
  if (!name && !dlgSigs.length) { delete profile().labels[dlgId]; }
  else profile().labels[dlgId] = { name, source: old && old.source && old.source !== 'user' ? old.source : 'user', detail: old ? old.detail : '', signals: dlgSigs };
  saveProfiles(); refreshGraphIndex(); render(true); toast('Disimpan dalam profil ' + profiles.current);
});

function importDbcText(text, fileName) {
  const db = Dbc.parseDbc(text, 'dbc');
  if (!db.count) { toast('Tiada mesej BO_ dalam fail ini. Pastikan fail .dbc yang betul.'); return; }
  const labels = profile().labels;
  for (const id in db.messages) {
    const m = db.messages[id];
    const cur = labels[id];
    if (cur && cur.source !== 'dbc') {
      for (const s of m.signals) if (!cur.signals.some(x => x.name === s.name)) cur.signals.push(s);
    } else labels[id] = { name: m.comment || m.name, source: 'dbc', detail: 'DBC: ' + fileName + (m.sender && m.sender !== 'Vector__XXX' ? ' · dari ' + m.sender : ''), signals: m.signals };
  }
  saveProfiles(); refreshGraphIndex(); render(true);
  toast(`${db.count} ID diimport dari ${fileName}` + (db.skipped ? ` (${db.skipped} isyarat multiplex dilangkau)` : ''));
}
$('dbcFile').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => importDbcText(r.result, f.name); r.readAsText(f); e.target.value = '';
};
$('btnDemoDbc').onclick = () => fetch('dbc/demo.dbc').then(r => r.text()).then(t => importDbcText(t, 'demo.dbc')).catch(() => toast('Gagal baca DBC demo'));
$('btnExportDbc').onclick = () => {
  const labels = profile().labels;
  if (!Object.keys(labels).length) { toast('Profil ini belum ada label'); return; }
  saveText(profiles.current.replace(/[^A-Za-z0-9_-]+/g, '_') + '.dbc', 'text/plain', Dbc.exportDbc(labels, profiles.current));
};

// ---------- GRAF ----------
let graphSel = store.get('graph', []);          // ['pid:12', 'can:320:TPS']
const series = new Map(); const lastRaw = new Map();
let graphIndex = new Map();                      // id CAN -> [key]
function allCanSignals() {
  const out = [];
  for (const id in profile().labels) for (const s of profile().labels[id].signals || []) out.push(Object.assign({ id }, s));
  for (const e of hist.ids.values()) { const st = A.standardLabel(e.id, e.ext); if (st && st.signals) out.push(...st.signals); }
  return out;
}
const sigCache = new Map();
function sigByKey(k) {
  if (sigCache.has(k)) return sigCache.get(k);
  const s = findSig(k);
  if (s) sigCache.set(k, s);
  return s;
}
function findSig(k) {
  if (k.startsWith('pid:')) { const pid = +k.slice(4); const d = C.PIDS[pid]; return d ? { name: d.name, unit: d.unit, pid } : null; }
  const [, id, ...rest] = k.split(':'); const name = rest.join(':');
  return allCanSignals().find(s => s.id === id && s.name === name) || null;
}
function refreshGraphIndex() {
  graphIndex = new Map(); sigCache.clear();
  for (const k of graphSel) if (k.startsWith('can:')) { const id = k.split(':')[1]; if (!graphIndex.has(id)) graphIndex.set(id, []); graphIndex.get(id).push(k); }
}
function pushSeries(k, t, v, raw) {
  let s = series.get(k); if (!s) { s = []; series.set(k, s); }
  s.push({ t, v }); while (s.length && t - s[0].t > 60000) s.shift();
  if (raw) lastRaw.set(k, raw);
}
refreshGraphIndex();

$('btnPickSig').onclick = () => {
  const can = allCanSignals(); const seen = new Set();
  const canHtml = can.filter(s => { const k = s.id + ':' + s.name; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(s => { const k = 'can:' + s.id + ':' + s.name; return `<label><input type="checkbox" value="${esc(k)}" ${graphSel.includes(k) ? 'checked' : ''}>${esc(s.name)}<code>ID ${s.id}</code></label>`; }).join('');
  const pids = (supported.length ? supported : Object.keys(C.PIDS).map(Number)).filter(p => C.PIDS[p] && p !== 0x01 && p !== 0x1C && p !== 0x51).sort((a, b) => a - b);
  const pidHtml = pids.map(p => `<label><input type="checkbox" value="pid:${p}" ${graphSel.includes('pid:' + p) ? 'checked' : ''}>${esc(C.PIDS[p].name)}<code>PID 01 ${C.hex2(p)}</code></label>`).join('');
  $('sigPick').innerHTML = `<h4>Isyarat CAN</h4>${canHtml || '<p class="sub">Belum ada. Guna tab Belajar atau import DBC.</p>'}<h4>PID standard OBD</h4>${pidHtml}`;
  $('sigPick').onchange = () => {
    const boxes = [...$('sigPick').querySelectorAll('input')];
    const on = boxes.filter(b => b.checked);
    boxes.forEach(b => { b.disabled = !b.checked && on.length >= 4; });
  };
  $('sigPick').onchange();
  $('sigDlg').showModal();
};
$('sigDlg').addEventListener('close', async () => {
  graphSel = [...$('sigPick').querySelectorAll('input:checked')].map(i => i.value).slice(0, 4);
  store.set('graph', graphSel); refreshGraphIndex(); buildCharts();
  if (engine && engine.kind === 'graf') { await stopEngine(); startGraf(); }
});

$('btnGraf').onclick = async () => { if (engine && engine.kind === 'graf') return stopEngine(); startGraf(); };
async function startGraf() {
  if (needConn()) return;
  if (!graphSel.length) { $('btnPickSig').click(); return; }
  const pids = graphSel.filter(k => k.startsWith('pid:')).map(k => +k.slice(4));
  const cans = graphSel.filter(k => k.startsWith('can:'));
  if (cans.length && (!elm.protocol.can || sniffOk === false)) { toast('Isyarat CAN perlukan sniff, yang tidak tersedia pada kereta/dongle ini. Hanya PID dipapar.'); }
  const useCan = cans.length && elm.protocol.can && sniffOk !== false;
  await stopEngine();
  startEngine('graf', async eng => {
    let n = 0, t0 = now();
    if (useCan && !pids.length) return sniffUntilStop(eng);
    while (!eng.stop && elm) {
      if (useCan) { eng.burst = true; await elm.burst(300, onLine); }
      for (const p of pids) {
        if (eng.stop || !elm) break;
        const r = await elm.readPid(p).catch(() => null);
        if (r && typeof r.value === 'number') { pushSeries('pid:' + p, now(), r.value); n++; }
      }
      const dt = (now() - t0) / 1000;
      if (dt > 2) { $('grafRate').textContent = (n / dt).toFixed(1) + ' bacaan PID/s'; n = 0; t0 = now(); }
    }
  });
}

function buildCharts() {
  const box = $('charts'); box.innerHTML = '';
  $('grafEmpty').hidden = graphSel.length > 0;
  graphSel.forEach((k, i) => {
    const el = document.createElement('div'); el.className = 'chart'; el.dataset.k = k;
    el.innerHTML = `<div class="head"><div><div class="nm"></div><div class="val">–</div></div><button class="x" aria-label="Buang">×</button></div>`
      + `<div class="idline"><span class="src-id"></span><span class="raw"></span></div><canvas></canvas><div class="hexrow"></div><div class="idline"><span class="formula"></span><span class="hz"></span></div>`;
    el.querySelector('.x').onclick = () => { graphSel.splice(i, 1); store.set('graph', graphSel); refreshGraphIndex(); buildCharts(); };
    box.appendChild(el);
  });
  renderCharts();
}
function renderCharts() {
  document.querySelectorAll('.chart').forEach(el => {
    const k = el.dataset.k, sig = sigByKey(k), data = series.get(k) || [];
    if (!sig) { el.querySelector('.nm').textContent = 'Isyarat tiada dalam profil ini'; return; }
    el.querySelector('.nm').textContent = sig.name;
    const last = data[data.length - 1];
    let valTxt = '–';
    if (last) valTxt = sig.values && sig.values[String(Math.round(last.v))] !== undefined ? sig.values[String(Math.round(last.v))] : fmt(last.v);
    el.querySelector('.val').innerHTML = esc(valTxt) + `<small>${esc(sig.unit || '')}</small>`;
    if (sig.pid !== undefined) {
      el.querySelector('.src-id').innerHTML = `PID standard <b>01 ${C.hex2(sig.pid)}</b>`;
      el.querySelector('.raw').textContent = 'soal-jawab OBD';
      el.querySelector('.formula').textContent = '';
      el.querySelector('.hexrow').innerHTML = '';
    } else {
      const bytes = signalBytes(sig), raw = lastRaw.get(k);
      el.querySelector('.src-id').innerHTML = `ID <b>0x${esc(sig.id)}</b> · bait ${bytes.length > 1 ? bytes[0] + '–' + bytes[bytes.length - 1] : bytes[0]}${sig.length < 8 ? ' bit ' + (sig.start & 7) : ''}`;
      el.querySelector('.raw').innerHTML = raw ? 'mentah <b>0x' + bytes.map(b => C.hex2(raw[b] || 0)).join('') + '</b>' : '';
      el.querySelector('.hexrow').innerHTML = raw ? `<i class="id">${esc(sig.id)}</i>` + raw.map((b, i) => `<i class="${bytes.includes(i) ? 'sel' : ''}">${C.hex2(b)}</i>`).join('') : '';
      el.querySelector('.formula').textContent = `nilai = mentah × ${sig.scale} ${sig.offset < 0 ? '−' : '+'} ${Math.abs(sig.offset)}`;
      const e = hist.ids.get(sig.id);
      el.querySelector('.hz').textContent = e && e.hz ? Math.round(e.hz) + ' Hz' : '';
    }
    drawChart(el.querySelector('canvas'), data);
  });
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function niceTicks(min, max, n) {
  const span = max - min || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
function drawChart(cv, data) {
  const r = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== Math.round(w * r)) { cv.width = Math.round(w * r); cv.height = Math.round(h * r); }
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
  const win = 30000, tn = now(), vis = data.filter(p => tn - p.t <= win);
  const padL = 40, padB = 16, padT = 6, plotH = h - padT - padB;
  let min = Infinity, max = -Infinity; for (const p of vis) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  if (!vis.length) { min = 0; max = 1; } else if (min === max) { min -= 1; max += 1; }
  const ticks = niceTicks(min, max, 3), lo = ticks[0], hi = ticks[ticks.length - 1];
  const X = t => padL + (w - padL) * (1 - (tn - t) / win), Y = v => padT + plotH * (1 - (v - lo) / (hi - lo || 1));
  g.font = '10px ui-monospace, Menlo, monospace'; g.fillStyle = cssVar('--muted'); g.strokeStyle = cssVar('--line'); g.lineWidth = 1;
  for (const v of ticks) { const y = Y(v); g.beginPath(); g.moveTo(padL, y); g.lineTo(w, y); g.stroke(); g.fillText(fmt(v), 0, y + 3); }
  g.fillText('−30 s', padL, h - 3); g.textAlign = 'right'; g.fillText('sekarang', w, h - 3); g.textAlign = 'left';
  if (vis.length < 2) return;
  const tr = cssVar('--amber');
  g.beginPath(); vis.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v)));
  g.lineTo(X(vis[vis.length - 1].t), padT + plotH); g.lineTo(X(vis[0].t), padT + plotH); g.closePath();
  g.globalAlpha = 0.15; g.fillStyle = tr; g.fill(); g.globalAlpha = 1;
  g.beginPath(); vis.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v)));
  g.strokeStyle = tr; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  const lp = vis[vis.length - 1]; g.beginPath(); g.arc(X(lp.t), Y(lp.v), 3.5, 0, 7); g.fillStyle = tr; g.fill();
}

// ---------- BELAJAR: banding dengan PID ----------
const LEARN_PIDS = [
  [0x11, 'Enjin MATI, kunci ON. Tekan pedal minyak perlahan-lahan sampai habis, kemudian lepas. Ulang 3–4 kali dalam 20 saat.'],
  [0x0C, 'Enjin hidup, gear P/N, brek tangan. Naikkan RPM perlahan ke 3000 dan turun semula, beberapa kali.'],
  [0x0D, 'Kereta perlu bergerak: minta orang lain memandu, atau angkat roda pemacu di atas jack dengan selamat.'],
  [0x05, 'Hidupkan enjin sejuk dan rakam 5–10 minit semasa suhu naik. Biar telefon di atas dashboard.'],
  [0x04, 'Enjin hidup. Naikkan dan turunkan RPM beberapa kali.'],
  [0x0B, 'Enjin hidup. Naikkan dan turunkan RPM beberapa kali.'],
  [0x10, 'Enjin hidup. Naikkan dan turunkan RPM beberapa kali.'],
  [0x0F, 'Rakam lama sedikit (5 minit) semasa enjin panas. Nilai ini berubah perlahan.'],
  [0x2F, 'Paras minyak berubah sangat perlahan, sukar dipelajari dalam satu sesi.'],
  [0x42, 'Hidupkan dan matikan lampu besar / aircond untuk ubah voltan.'],
  [0x5C, 'Rakam beberapa minit semasa enjin panas.'],
  [0x46, 'Berubah perlahan. Sukar dipelajari dalam satu sesi.']
];
function fillLearnPids() {
  const list = LEARN_PIDS.filter(([p]) => !supported.length || supported.includes(p));
  const cur = $('learnPid').value;
  $('learnPid').innerHTML = list.map(([p]) => `<option value="${p}">${esc(C.PIDS[p].name)} (PID 01 ${C.hex2(p)})</option>`).join('');
  if (cur && list.some(([p]) => String(p) === cur)) $('learnPid').value = cur;
  $('learnPid').onchange();
}
$('learnPid').onchange = () => { const e = LEARN_PIDS.find(([p]) => String(p) === $('learnPid').value); $('learnHint').textContent = e ? e[1] : ''; };
fillLearnPids();

let learn = { ref: [], pid: null, results: [] };
$('btnLearn').onclick = async () => {
  if (engine && engine.kind === 'learn') return stopEngine();
  if (needCan()) return;
  if (sniffOk === false) { toast('Dongle/kereta ini tidak beri trafik sniff, jadi tidak boleh belajar ID.'); return; }
  await stopEngine();
  const pid = +$('learnPid').value;
  learn = { ref: [], pid, results: [], t0: now() };
  hist.clear(); guessCache.clear();
  $('learnRef').hidden = false; $('learnResults').innerHTML = '';
  startEngine('learn', async eng => {
    eng.burst = true;
    let lastCalc = now();
    while (!eng.stop && elm) {
      await elm.burst(250, onLine);
      const r = await elm.readPid(pid).catch(() => null);
      if (r && typeof r.value === 'number') learn.ref.push({ t: now(), v: r.value });
      if (now() - lastCalc > 3000) { lastCalc = now(); learn.results = A.correlate(learn.ref, hist).results; renderLearn(); }
    }
  });
  engine.after = () => { const res = A.correlate(learn.ref, hist); learn.results = res.results; learn.error = res.error; renderLearn(true); };
};
function renderLearn(final) {
  if (!learn.pid) return;
  const d = C.PIDS[learn.pid], last = learn.ref[learn.ref.length - 1];
  const secs = ((engine && engine.kind === 'learn' ? now() : (learn.tEnd || now())) - learn.t0) / 1000;
  if (!(engine && engine.kind === 'learn') && !learn.tEnd) learn.tEnd = now();
  $('learnRef').innerHTML = `${last ? fmt(last.v) : '–'}<small> ${esc(d.unit)} · ${esc(d.name)} dari PID</small>`;
  $('learnInfo').textContent = `${secs.toFixed(0)} s · ${learn.ref.length} bacaan rujukan · ${hist.ids.size} ID`;
  if (final && learn.error) { $('learnResults').innerHTML = `<p class="hint">${esc(learn.error)}</p>`; return; }
  if (!learn.results.length) { $('learnResults').innerHTML = learn.ref.length > 6 ? '<p class="sub">Belum ada bait yang sepadan. Teruskan ubah keadaan sensor.</p>' : ''; return; }
  $('learnResults').innerHTML = `<h3 class="sec">${final ? 'Calon terbaik' : 'Calon setakat ini'}</h3>` + learn.results.map((c, i) => {
    const e = hist.ids.get(c.id), raw = e ? e.frames[e.frames.length - 1].data : null;
    const v = raw ? C.extractSignal(raw, c) : null;
    const pct = Math.round(c.score * 100);
    return `<div class="cand"><span class="m">ID ${c.id} · ${c.label}</span><span class="m">${pct}%</span><div class="meter"><span style="width:${pct}%"></span></div>`
      + `<span class="d">nilai = mentah × ${c.scale} ${c.offset < 0 ? '−' : '+'} ${Math.abs(c.offset)}${v != null ? ' → kini ' + fmt(v) + ' ' + esc(d.unit) : ''}${c.r < 0 ? ' · arah terbalik' : ''}</span>`
      + (final ? `<button class="btn small" data-i="${i}">Simpan sebagai ${esc(d.name)}</button>` : '') + '</div>';
  }).join('') + (final ? '<p class="sub">Peratus = sejauh mana bait itu bergerak seiring PID (korelasi). 90% ke atas biasanya tepat. Beberapa ID mungkin bawa isyarat yang sama.</p>' : '');
  $('learnResults').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => saveLearned(learn.results[+b.dataset.i]));
}
function saveLearned(c) {
  const d = C.PIDS[learn.pid];
  const labels = profile().labels;
  const l = labels[c.id] || (labels[c.id] = { name: '', source: 'learn', detail: '', signals: [] });
  if (l.source === 'user' && !l.name) l.source = 'learn';
  l.signals = (l.signals || []).filter(s => s.name !== d.name);
  l.signals.push({ name: d.name, id: c.id, start: c.start, length: c.length, order: c.order, signed: false, scale: c.scale, offset: c.offset, unit: d.unit, source: 'learn', min: 0, max: 0 });
  if (!l.name) l.name = 'Mengandungi ' + d.name;
  l.detail = 'padan PID 01 ' + C.hex2(learn.pid) + ' ' + Math.round(c.score * 100) + '%';
  saveProfiles();
  const k = 'can:' + c.id + ':' + d.name;
  if (!graphSel.includes(k) && graphSel.length < 4) { graphSel.push(k); store.set('graph', graphSel); }
  refreshGraphIndex(); buildCharts();
  toast(`Disimpan: ID ${c.id} ${c.label} = ${d.name}. Lihat di tab Graf.`);
}

// ---------- BELAJAR: tindakan ----------
const act = { running: false, on: false, samples: [], marks: 0, results: [] };
$('btnAct').onclick = async () => {
  if (engine && engine.kind === 'act') return stopEngine();
  if (needCan()) return;
  if (sniffOk === false) { toast('Dongle/kereta ini tidak beri trafik sniff.'); return; }
  await stopEngine();
  Object.assign(act, { running: true, on: false, samples: [], marks: 0, results: [] });
  $('actResults').innerHTML = '';
  if (transport instanceof SimTransport) transport.brake = false;
  startEngine('act', eng => sniffUntilStop(eng));
  engine.after = () => {
    act.running = false;
    if (transport instanceof SimTransport) transport.brake = null;
    act.results = A.actionBits(act.samples);
    renderAct(true);
  };
};
$('btnActOn').onclick = () => {
  act.on = !act.on; if (act.on) act.marks++;
  $('btnActOn').classList.toggle('on', act.on);
  $('btnActOn').textContent = act.on ? 'Berhenti (sudah lepas)' : 'Saya sedang buat';
  if (transport instanceof SimTransport) transport.brake = act.on;
};
function renderAct(final) {
  const on = act.samples.filter(s => s.on).length;
  if (act.running) $('actInfo').textContent = `${act.samples.length} bingkai · ${act.marks} kali tindakan · ${on} bingkai semasa tindakan`;
  if (!final) return;
  if (act.marks < 1 || on < 3) { $('actResults').innerHTML = '<p class="hint">Tiada tindakan direkod. Tekan "Saya sedang buat" semasa anda buat tindakan itu.</p>'; return; }
  if (!act.results.length) { $('actResults').innerHTML = '<p class="hint">Tiada bit yang ikut tindakan. Cuba ulang dengan tempoh lebih jelas (tahan 2–3 saat setiap kali).</p>'; return; }
  const name = $('actName').value.trim() || 'Tindakan';
  $('actResults').innerHTML = '<h3 class="sec">Bit yang ikut tindakan</h3>' + act.results.map((r, i) => {
    const pct = Math.round(r.score * 100);
    return `<div class="cand"><span class="m">ID ${r.id} · bait ${r.byte} bit ${r.bit}</span><span class="m">${pct}%</span><div class="meter"><span style="width:${pct}%"></span></div>`
      + `<span class="d">${r.activeHigh ? 'bit = 1 semasa tindakan' : 'bit = 0 semasa tindakan'} · bit mula DBC ${r.start}</span><button class="btn small" data-i="${i}">Simpan sebagai ${esc(name)}</button></div>`;
  }).join('');
  $('actResults').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => {
    const r = act.results[+b.dataset.i];
    const labels = profile().labels;
    const l = labels[r.id] || (labels[r.id] = { name: '', source: 'learn', detail: '', signals: [] });
    l.signals = (l.signals || []).filter(s => s.name !== name);
    l.signals.push({ name, id: r.id, start: r.start, length: 1, order: 'intel', signed: false, scale: 1, offset: 0, unit: '', source: 'learn', values: r.activeHigh ? { 1: 'AKTIF', 0: 'tidak' } : { 0: 'AKTIF', 1: 'tidak' } });
    if (!l.name) l.name = 'Mengandungi ' + name;
    if (!l.detail) l.detail = 'dari tindakan ' + Math.round(r.score * 100) + '%';
    saveProfiles(); refreshGraphIndex(); toast(`Disimpan: ID ${r.id} bait ${r.byte} bit ${r.bit} = ${name}`);
  });
}

// ---------- Terminal ----------
$('termForm').addEventListener('submit', async e => {
  e.preventDefault();
  const cmd = $('termIn').value.trim().toUpperCase();
  if (!cmd || needConn()) return;
  if (engine) { toast('Hentikan tangkapan dulu'); return; }
  $('termIn').value = '';
  engine = { kind: 'term' };
  try {
    const raw = await elm.send(cmd, 8000);
    if (/^[0-9A-F]{2,}$/.test(cmd)) {
      for (const m of C.parseResponse(raw, elm.protocol).messages) {
        const b = m.bytes; let note = `[${m.ecu}] ${b.map(C.hex2).join(' ')}`;
        if (b[0] === 0x41) { const d = C.decodePid(b[1], b.slice(2)); if (d) note += `  → ${d.name}: ${d.value} ${d.unit}`; }
        logTerm('rx', '  ' + note);
      }
    }
  } catch (err) { logTerm('rx', '! ' + err.message); } finally { engine = null; }
});

// ---------- Paparan berkala ----------
let lastGuess = 0, lastIds = 0;
function render(force) {
  const t = now();
  if (t - lastGuess > 1000 || force) { lastGuess = t; for (const e of hist.ids.values()) guessCache.set(e.id, A.guess(e)); }
  if (tab === 'sniff') renderSniff();
  if (tab === 'graf') renderCharts();
  if (tab === 'ids' && (force || t - lastIds > 1000)) { lastIds = t; renderIds(); }
  if (tab === 'learn') { if (engine && engine.kind === 'learn') renderLearn(); if (act.running) renderAct(); }
}
setInterval(() => { if (!document.hidden) render(); }, 250);

window.nativeBack = () => {
  const d = document.querySelector('dialog[open]');
  if (d) { d.close(); return true; }
  if (tab !== 'conn') { showTab('conn'); return true; }
  return false;
};
addEventListener('resize', () => renderCharts());

renderProfiles();
buildCharts();
showTab('conn');
