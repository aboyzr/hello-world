'use strict';
/* global I18N, ObdCore, Analyze, Dbc, Elm327, AndroidTransport, WebBleTransport, WebSerialTransport, SimTransport */
const $ = id => document.getElementById(id);
const C = ObdCore, A = Analyze, t = I18N.t;
const NATIVE = window.AndroidBridge || null;
const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('canbus.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('canbus.' + k, JSON.stringify(v)); } catch (e) { /* storan penuh / disekat */ } }
};

let elm = null, transport = null, supported = [], busy = false, sniffOk = null, connInfo = null;
const hist = new A.History(3000);
let frameCount = 0, frameT0 = now();

// ---------- Umum ----------
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}
function setStatus(msg, bad) { const s = $('status'); s.textContent = msg || ''; s.hidden = !msg; s.classList.toggle('bad', !!bad); }
function updatePill() {
  const p = $('pill');
  if (!elm) { p.textContent = t('pill.off'); p.classList.remove('ok'); return; }
  const pr = elm.protocol;
  p.textContent = '● ' + (pr.can ? 'CAN ' + (pr.ext ? '29-bit' : '11-bit') : C.protocolName(pr.id));
  p.classList.add('ok');
}
function fmt(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  const a = Math.abs(v);
  return a >= 1000 ? Math.round(v).toString() : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}
function needConn() { if (!elm) { toast(t('msg.needConn')); showTab('conn'); return true; } return false; }
function needCan() {
  if (needConn()) return true;
  if (!elm.protocol.can) { toast(t('msg.notCan')); return true; }
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

// ---------- Bahasa ----------
function applyLanguage() {
  I18N.apply(document);
  document.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === I18N.lang)));
  if (NATIVE && window.ObdBridge && window.ObdBridge.setLanguage) window.ObdBridge.setLanguage(I18N.lang);
  if (!$('actName').value || $('actName').dataset.auto === '1') { $('actName').value = t('act.default'); $('actName').dataset.auto = '1'; }
  updatePill(); updateButtons(); updateBase(); renderResume(); renderProfiles(); fillLearnPids(); renderInfo(); refreshGraphIndex(); buildCharts();
  if (findCands) renderFind();
  renderSend(); updateAuto();
  renderLearn(learn.final); renderAct(act.final);
  render(true);
}
document.querySelectorAll('.lang button').forEach(b => b.addEventListener('click', () => { I18N.set(b.dataset.lang); applyLanguage(); }));
$('actName').addEventListener('input', () => { $('actName').dataset.auto = '0'; });

// ---------- Profil kereta & label ID ----------
let profiles = store.get('profiles', null) || { current: 'My car', list: { 'My car': { labels: {} } } };
const profile = () => profiles.list[profiles.current];
const saveProfiles = () => store.set('profiles', profiles);
function renderProfiles() {
  $('profileSel').innerHTML = Object.keys(profiles.list).map(n => `<option ${n === profiles.current ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
$('profileSel').onchange = e => { profiles.current = e.target.value; saveProfiles(); refreshGraphIndex(); render(true); };
$('btnNewProfile').onclick = async () => {
  const name = await ask(t('ids.newProfileTitle'), t('ids.newProfileText'), { input: true, placeholder: t('ids.newProfilePh'), ok: t('common.create') });
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
// Nama/nilai isyarat yang dipelajari dari PID ikut bahasa semasa
const sigName = s => (s.pid != null ? C.pidName(s.pid) : (s.label || s.name));
function valueText(sig, v) {
  if (v == null) return '–';
  const key = String(Math.round(v));
  if (sig.active != null) return Math.round(v) === sig.active ? t('act.active') : t('act.inactive');
  if (sig.values && sig.values[key] !== undefined) return sig.values[key];
  return fmt(v) + (sig.unit ? ' ' + sig.unit : '');
}
const sigValueText = (sig, data) => valueText(sig, C.extractSignal(data, sig));

// Gabung semua sumber label: profil (dipelajari / DBC / sendiri) > standard > tekaan
const guessCache = new Map();
function labelFor(id) {
  const e = hist.ids.get(id);
  const p = profile().labels[id];
  const std = A.standardLabel(id, e ? e.ext : id.length > 3);
  if (p && (p.name || (p.signals && p.signals.length))) {
    const own = p.signals || [];
    const name = p.name || (own.length ? t('ids.contains', { name: own.map(sigName).join(', ') }) : (std && std.name) || 'ID ' + id);
    return { name, source: p.source || 'user', detail: detailText(p), signals: own.concat(std && std.signals ? std.signals.filter(s => !own.some(x => x.name === s.name)) : []) };
  }
  if (std) return { name: std.name, source: 'std', detail: std.detail || t('ids.stdId'), signals: std.signals || [] };
  const g = guessCache.get(id) || (e ? A.guess(e) : null);
  if (g && g.conf) return { name: g.name, source: 'guess', detail: t('ids.guessPct', { n: Math.round(g.conf * 100) }) + (g.detail ? ' · ' + g.detail : ''), signals: [], roles: g.roles };
  return { name: g ? g.name : t('src.unk'), source: 'unk', detail: '', signals: [] };
}
function noteText(id) { const p = profile().labels[id]; return p && p.note ? p.note : ''; }
function detailText(p) {
  if (p.learnPid != null) return t('learn.matchDetail', { pid: C.hex2(p.learnPid), n: p.learnScore });
  if (p.actScore != null) return t('act.detail', { n: p.actScore });
  if (p.dbcFile) return 'DBC: ' + p.dbcFile + (p.dbcSender ? ' · ' + t('ids.from') + ' ' + p.dbcSender : '');
  return p.detail || '';
}
const SRC = s => t('src.' + s);

// ---------- Sambungan ----------
if (!NATIVE && (WebBleTransport.available() || WebSerialTransport.available())) $('webBtns').hidden = false;
if (!NATIVE) { $('btnList').hidden = true; $('btnScanBle').hidden = true; }
$('protoSel').value = store.get('proto', '0');
$('protoSel').addEventListener('change', e => store.set('proto', e.target.value));

const termLog = [];
function logTerm(dir, text) {
  if (engine && engine.kind !== 'term') return; // jangan banjirkan terminal semasa tangkap
  termLog.push({ dir, text }); if (termLog.length > 300) termLog.shift();
  const out = $('termOut');
  out.innerHTML = termLog.map(l => l.dir === 'tx' ? '<span class="tx">&gt; ' + esc(l.text) + '</span>' : esc(l.text)).join('\n');
  out.scrollTop = out.scrollHeight;
}

async function listDevices(ble) {
  const ul = $('devList');
  ul.innerHTML = '<li class="sub">' + esc(ble ? t('conn.scanning') : t('conn.reading')) + '</li>';
  try {
    const list = await AndroidTransport.listDevices(ble);
    if (!list.length) { ul.innerHTML = '<li class="sub">' + esc(ble ? t('conn.noneBle') : t('conn.nonePaired')) + '</li>'; return; }
    const last = store.get('lastDev', null);
    const score = d => /obd|elm|dollar|vlink|v-link|icar|vgate|veepeak|konnwei|obdlink|scan|car/i.test(d.name || '') ? 1 : 0;
    list.sort((a, b) => score(b) - score(a));
    ul.innerHTML = '';
    for (const d of list) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="dev"><span><b>${esc(d.name || t('conn.noName'))}</b><span class="sub mono">${esc(d.address)}</span></span><span class="tag">${d.type === 'ble' ? 'BLE' : 'Classic'}${last && last.address === d.address ? ' · ' + esc(t('conn.last')) : ''}</span></button>`;
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

// Sambung semula automatik bila Bluetooth terputus, kemudian teruskan kerja yang sedang berjalan
let lastConn = null, reconnecting = false;
async function onLost(msg) {
  const kind = engine && engine.kind;
  interrupted = true;
  await disconnect(true);
  setStatus(msg ? t('conn.lostMsg', { msg }) : t('conn.lost'), true);
  if (!lastConn || reconnecting) return;
  reconnecting = true;
  try {
    for (let i = 1; i <= 3 && !elm; i++) {
      setStatus(t('conn.retry', { n: i }), true);
      await sleep(1500 * i);
      await connect(lastConn.make(), lastConn.dev);
    }
  } finally { reconnecting = false; }
  if (!elm) { setStatus(t('conn.retryFail'), true); return; }
  toast(t('conn.back'));
  const s = await kv.get('session');
  if (kind === 'learn' && s && s.kind === 'learn') startLearn(s);
  else if (kind === 'act' && s && s.kind === 'act') startAct(s);
  else if (kind === 'sniff') $('btnSniff').click();
  else if (kind === 'graf') startGraf();
}
async function connect(tr, dev) {
  if (busy) return;
  lastConn = tr instanceof AndroidTransport ? { make: () => new AndroidTransport(dev), dev } : tr instanceof SimTransport ? { make: () => new SimTransport(), dev: null } : null;
  if (elm) await disconnect();
  busy = true;
  setStatus(t('conn.connecting', { name: tr.name === 'Demo (simulator)' ? t('conn.demo') : (tr.name || 'dongle') }));
  try {
    await tr.open();
    transport = tr;
    tr.onClose(msg => { if (transport === tr) onLost(msg); });
    elm = new Elm327(tr, logTerm);
    setStatus(t('conn.init'));
    const info = await elm.init($('protoSel').value);
    if (dev) store.set('lastDev', dev);
    updatePill();
    supported = await elm.supportedPids().catch(() => []);
    const vin = await elm.readVin().catch(() => null);
    const volt = await elm.voltage().catch(() => null);
    setStatus(t('conn.probing'));
    const probe = await elm.probeSniff().catch(e => ({ ok: false, reason: e.message }));
    sniffOk = probe.ok;
    setStatus('');
    connInfo = { name: tr instanceof SimTransport ? null : tr.name, info, vin, volt, probe };
    renderInfo();
    $('infoCard').hidden = false;
    $('btnDemoDbc').hidden = !(tr instanceof SimTransport);
    fillLearnPids();
    toast(probe.ok ? t('conn.okSniff') : t('conn.okNoSniff'));
  } catch (e) {
    setStatus(t('conn.failed', { msg: e.message }), true);
    await disconnect(true);
  } finally { busy = false; }
}
function renderInfo() {
  if (!connInfo) return;
  const { name, info, vin, volt, probe } = connInfo;
  $('infoList').innerHTML = [
    [t('info.dongle'), esc(name || t('conn.demo'))], [t('info.chip'), esc(info.version || '-')], [t('info.protocol'), esc(C.protocolName(info.protocol.id))],
    [t('info.ecus'), esc(info.ecus.join(', ') || '-')], ['VIN', esc(vin || t('info.notSupported'))],
    [t('info.battery'), volt ? volt.toFixed(1) + ' V' : '-'], [t('info.pids'), supported.length],
    [t('info.sniff'), probe.ok ? `<span class="ok">${esc(t('info.sniffOk', { n: probe.frames }))}</span>` : `<span class="bad">${esc(probe.reason)}</span>`]
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
}

async function disconnect(keepStatus) {
  sending = null; auto.on = false;
  await stopEngine();
  const tr = transport; transport = null; elm = null; sniffOk = null; connInfo = null;
  if (tr) try { await tr.close(); } catch (e) { /* abaikan */ }
  $('infoCard').hidden = true; $('btnDemoDbc').hidden = true;
  updatePill();
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
  await elm.startMonitor(onLine, filter, () => toast(t('msg.bufferFull')), () => { toast(t('msg.noAtma')); eng.stop = true; });
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
    if (recording.length >= 200000) { toast(t('sniff.recLimit')); toggleRec(); }
  }
  if (act.running) act.samples.push({ on: act.on, f });
  if (base.state !== 'idle') base.add(f);
  const keys = graphIndex.get(f.id);
  if (keys) for (const k of keys) { const s = sigByKey(k); const v = s && C.extractSignal(f.data, s); if (v != null) pushSeries(k, f.t, v, f.data); }
}

function updateButtons() {
  const k = engine && engine.kind;
  $('btnSniff').textContent = k === 'sniff' ? t('common.stop') : t('sniff.capture');
  $('btnGraf').textContent = k === 'graf' ? t('common.stop') : t('common.start');
  $('btnLearn').textContent = k === 'learn' ? t('learn.stop') : t('learn.start');
  $('btnAct').textContent = k === 'act' ? t('learn.stop') : t('act.start');
  $('btnRec').textContent = recording ? t('sniff.recStop') : t('sniff.rec');
  $('btnActOn').disabled = k !== 'act';
  if (k !== 'act') { act.on = false; $('btnActOn').classList.remove('on'); }
  $('btnActOn').textContent = act.on ? t('act.off') : t('act.on');
}

// ---------- SNIFF ----------
let recording = null, lastRec = null, recT0 = 0;
const base = new A.Baseline(); let onlyChanged = false, baseTimer = null;
$('btnBase').onclick = async () => {
  if (base.state === 'collect') return;
  if (base.state === 'ready') { base.reset(); onlyChanged = false; updateBase(); render(true); return; }
  if (!(engine && engine.kind === 'sniff')) { $('btnSniff').click(); await sleep(300); if (!(engine && engine.kind === 'sniff')) return; }
  base.start(); updateBase();
  let left = 3;
  baseTimer = setInterval(() => {
    left--; updateBase(left);
    if (left <= 0) { clearInterval(baseTimer); base.finish(); onlyChanged = true; updateBase(); render(true); toast(t('base.ready')); }
  }, 1000);
};
$('btnOnlyChg').onclick = () => { if (base.state !== 'ready') { toast(t('base.needBase')); return; } onlyChanged = !onlyChanged; updateBase(); render(true); };
function updateBase(left) {
  $('btnBase').textContent = base.state === 'collect' ? t('base.collecting', { s: left == null ? 3 : left }) : base.state === 'ready' ? t('base.reset') : t('base.take');
  $('btnOnlyChg').setAttribute('aria-pressed', String(onlyChanged));
  $('baseInfo').textContent = base.state === 'ready' ? t('base.info', { n: base.ids.size, c: base.changes.size }) : base.state === 'collect' ? t('base.hold') : t('base.intro');
}
$('btnSniff').onclick = async () => {
  if (engine && engine.kind === 'sniff') return stopEngine();
  if (needCan()) return;
  const id = $('filtId').value.trim().toUpperCase(), mask = $('filtMask').value.trim().toUpperCase();
  if ((id && !/^[0-9A-F]{1,8}$/.test(id)) || (mask && !/^[0-9A-F]{1,8}$/.test(mask))) { toast(t('msg.hexOnly')); return; }
  await stopEngine();
  frameCount = 0; frameT0 = now();
  startEngine('sniff', eng => sniffUntilStop(eng, id ? { id, mask } : null));
};
$('btnRec').onclick = toggleRec;
function toggleRec() {
  if (recording) { lastRec = recording; recording = null; $('btnCsv').disabled = !lastRec.length; updateButtons(); kv.set('lastRec', lastRec); toast(t('sniff.recorded', { n: lastRec.length })); return; }
  recording = []; recT0 = now(); $('btnCsv').disabled = true; updateButtons();
  if (!engine) toast(t('sniff.recHint'));
}
$('btnCsv').onclick = () => {
  if (!lastRec || !lastRec.length) return;
  saveText('can-log-' + stamp() + '.csv', 'text/csv', 'time_s,id,dlc,data\n' + lastRec.map(r => r.join(',')).join('\n'));
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
  const tn = now();
  let rows = sortIds();
  if (onlyChanged && base.state === 'ready') rows = rows.filter(e => base.changes.has(e.id));
  for (const e of rows) {
    const last = e.frames[e.frames.length - 1].data, prev = prevData.get(e.id) || [], ch = changedAt.get(e.id) || [];
    last.forEach((b, i) => { if (prev[i] !== undefined && prev[i] !== b) ch[i] = tn; });
    prevData.set(e.id, last); changedAt.set(e.id, ch);
  }
  $('sniffTable').innerHTML = rows.length ? `<div class="srow head"><span>ID</span><span>${esc(t('sniff.data'))}</span><span class="hz">Hz</span></div>` + rows.map(e => {
    const d = e.frames[e.frames.length - 1].data, ch = changedAt.get(e.id) || [], g = guessCache.get(e.id), roles = (g && g.roles) || [];
    const lbl = labelFor(e.id), bc = base.state === 'ready' ? base.changes.get(e.id) : null;
    const badge = bc ? `<span class="badge">${esc(bc.isNew ? t('base.new') : t('base.changed'))}</span>` : '';
    return `<button class="srow${bc ? ' changed' : ''}" data-id="${e.id}"><span class="id">${e.id}${badge}<small>${lbl.source === 'unk' || lbl.source === 'guess' ? '' : esc(lbl.name)}</small></span><span>${d.map((b, i) => `<span class="b${tn - (ch[i] || 0) < 400 ? ' chg' : ''}${roles[i] ? ' r-' + roles[i] : ''}${bc && bc.mask[i] ? ' hit' : ''}">${C.hex2(b)}</span>`).join(' ')}</span><span class="hz">${e.hz ? Math.round(e.hz) : '–'}</span></button>`;
  }).join('') : '';
  const secs = (tn - frameT0) / 1000;
  if (base.state === 'ready') updateBase();
  if (engine && engine.kind === 'sniff') $('sniffStats').textContent = t('sniff.stats', { f: frameCount, ids: hist.ids.size, rate: (frameCount / Math.max(secs, 0.1)).toFixed(0) }) + (recording ? ' · ' + t('sniff.recording', { n: recording.length }) : '');
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
    const sv = l.signals.slice(0, 4).map(s => esc(sigName(s)) + ': ' + esc(sigValueText(s, d))).join(' · ');
    const note = noteText(e.id);
    return `<button class="idc" data-id="${e.id}"><span class="i">${e.id}</span><span class="f">${esc(l.name)}${note ? ' 📝' : ''}</span><span class="src s-${l.source}">${esc(SRC(l.source))}</span>`
      + `<span class="d">${esc(l.detail || '')}${l.detail ? ' · ' : ''}${d.map(C.hex2).join(' ')}</span>${note ? `<span class="sv">${esc(note)}</span>` : ''}${sv ? `<span class="sv">${sv}</span>` : ''}</button>`;
  }).join('');
  $('idList').innerHTML = html + (known.length ? `<h3 class="sec">${esc(t('ids.notSeen'))}</h3>` + known.sort().map(id => {
    const l = labelFor(id);
    return `<button class="idc" data-id="${id}"><span class="i">${id}</span><span class="f">${esc(l.name)}</span><span class="src s-${l.source}">${esc(SRC(l.source))}</span><span class="d">${esc(t('ids.nSignals', { n: (profile().labels[id].signals || []).length }))}</span></button>`;
  }).join('') : '');
  $('idsStats').textContent = rows.length ? t('ids.stats', Object.assign({ n: rows.length }, counts)) : t('ids.empty');
}
$('idList').addEventListener('click', e => { const r = e.target.closest('.idc[data-id]'); if (r) openIdDialog(r.dataset.id); });

let dlgId = null, dlgSigs = [];
function openIdDialog(id) {
  dlgId = id;
  const p = profile().labels[id] || {};
  const l = labelFor(id);
  const e = hist.ids.get(id);
  dlgSigs = (p.signals || []).map(s => Object.assign({}, s));
  $('idDlgTitle').textContent = 'ID ' + id + ' · ' + SRC(l.source);
  $('idDlgRaw').textContent = e ? t('dlg.latest', { data: e.frames[e.frames.length - 1].data.map(C.hex2).join(' '), n: e.count }) : t('dlg.notSeen');
  $('idName').value = p.name || '';
  $('idNote').value = p.note || '';
  $('idName').placeholder = l.name;
  $('btnDelLabel').hidden = !profile().labels[id];
  renderDlgSigs(l);
  $('idBytes').innerHTML = '';
  $('idDlg').showModal();
  renderIdBytes();
}
function renderIdBytes() {
  const e = hist.ids.get(dlgId), box = $('idBytes');
  if (!e) { box.innerHTML = ''; return; }
  const fr = e.frames.filter(f => now() - f.t < 10000), last = e.frames[e.frames.length - 1].data, prev = e.frames.length > 1 ? e.frames[e.frames.length - 2].data : last;
  if (box.children.length !== last.length) {
    box.innerHTML = last.map((_, i) => `<div class="bcell"><div class="top"><span>B${i}</span><b></b></div><canvas></canvas><div class="bits">${'<i></i>'.repeat(8)}</div><button type="button" data-b="${i}">${esc(t('bytes.graph'))}</button></div>`).join('');
    box.querySelectorAll('button[data-b]').forEach(b => b.onclick = () => {
      const k = 'raw:' + dlgId + ':' + b.dataset.b;
      if (graphSel.includes(k)) { toast(t('bytes.already')); return; }
      if (graphSel.length >= 4) { toast(t('bytes.full')); return; }
      graphSel.push(k); store.set('graph', graphSel); refreshGraphIndex(); buildCharts(); toast(t('bytes.added', { id: dlgId, b: b.dataset.b }));
    });
  }
  const ever = last.map((_, i) => fr.reduce((m, f, k) => k ? m | ((f.data[i] ^ fr[k - 1].data[i]) & 0xff) : m, 0));
  [...box.children].forEach((cell, i) => {
    cell.querySelector('b').textContent = C.hex2(last[i]);
    cell.querySelectorAll('.bits i').forEach((el, k) => {
      const bit = 7 - k; // MSB di kiri
      el.className = ((last[i] >> bit) & 1 ? 'on' : '') + (((last[i] ^ prev[i]) >> bit) & 1 || (ever[i] >> bit) & 1 ? ' flip' : '');
      el.title = 'bit ' + bit;
    });
    const cv = cell.querySelector('canvas'), w = cv.clientWidth, h = cv.clientHeight, r = window.devicePixelRatio || 1;
    if (!w) return;
    if (cv.width !== Math.round(w * r)) { cv.width = Math.round(w * r); cv.height = Math.round(h * r); }
    const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, h);
    if (fr.length < 2) return;
    const t0 = now() - 10000;
    g.beginPath(); fr.forEach((f, k) => { const x = (f.t - t0) / 10000 * w, y = h - 1 - f.data[i] / 255 * (h - 2); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = cssVar('--amber'); g.lineWidth = 1.5; g.stroke();
  });
}
function renderDlgSigs(l) {
  const e = hist.ids.get(dlgId); const d = e ? e.frames[e.frames.length - 1].data : [];
  const std = (l && l.source === 'std' ? l.signals : (A.standardLabel(dlgId, dlgId.length > 3) || {}).signals) || [];
  $('idSigs').innerHTML = dlgSigs.map((s, i) => `<li class="sigrow"><span><b>${esc(sigName(s))}</b> = ${esc(sigValueText(s, d))}<br><span class="sub mono">bit ${s.start}/${s.length} ${s.order} ×${s.scale} ${s.offset >= 0 ? '+' : ''}${s.offset} · ${esc(SRC(s.source || 'user'))}</span></span><button type="button" class="x" data-i="${i}" aria-label="${esc(t('common.remove'))}">×</button></li>`).join('')
    + std.map(s => `<li class="sigrow"><span><b>${esc(s.name)}</b> = ${esc(sigValueText(s, d))}<br><span class="sub mono">${esc(t('dlg.j1939'))} · bit ${s.start}/${s.length}</span></span></li>`).join('')
    || `<li class="sub">${esc(t('dlg.noSignals'))}</li>`;
  $('idSigs').querySelectorAll('button.x').forEach(b => b.onclick = () => { dlgSigs.splice(+b.dataset.i, 1); renderDlgSigs(); });
}
$('btnAddSig').onclick = () => {
  const name = $('sgName').value.trim();
  if (!name) { toast(t('dlg.needName')); return; }
  const s = { name, id: dlgId, start: +$('sgStart').value, length: +$('sgLen').value, order: $('sgOrder').value, signed: !!$('sgSigned').value, scale: +$('sgScale').value || 1, offset: +$('sgOffset').value || 0, unit: $('sgUnit').value.trim(), source: 'user' };
  if (!(s.length >= 1 && s.length <= 32 && s.start >= 0 && s.start <= 63)) { toast(t('dlg.badBits')); return; }
  dlgSigs.push(s); $('sgName').value = ''; renderDlgSigs();
};
$('btnDelLabel').onclick = async () => {
  const id = dlgId; $('idDlg').close('cancel');
  if (await ask(t('dlg.delTitle', { id }), t('dlg.delText', { p: profiles.current }), { ok: t('dlg.delete') })) {
    delete profile().labels[id]; saveProfiles(); refreshGraphIndex(); render(true);
  }
};
$('idDlg').addEventListener('close', () => {
  if ($('idDlg').returnValue !== 'ok' || !dlgId) return;
  const name = $('idName').value.trim();
  const old = profile().labels[dlgId];
  const note = $('idNote').value.trim();
  if (!name && !dlgSigs.length && !note) delete profile().labels[dlgId];
  else profile().labels[dlgId] = Object.assign({}, old || {}, { name, note, source: old && old.source && old.source !== 'user' ? old.source : 'user', signals: dlgSigs });
  saveProfiles(); refreshGraphIndex(); render(true); toast(t('msg.savedProfile', { p: profiles.current }));
});

function importDbcText(text, fileName) {
  const db = Dbc.parseDbc(text, 'dbc');
  if (!db.count) { toast(t('ids.dbcEmpty')); return; }
  const labels = profile().labels;
  for (const id in db.messages) {
    const m = db.messages[id];
    const cur = labels[id];
    if (cur && cur.source !== 'dbc') {
      for (const s of m.signals) if (!cur.signals.some(x => x.name === s.name)) cur.signals.push(s);
    } else labels[id] = { name: m.comment || m.name, source: 'dbc', dbcFile: fileName, dbcSender: m.sender && m.sender !== 'Vector__XXX' ? m.sender : '', signals: m.signals };
  }
  saveProfiles(); refreshGraphIndex(); render(true);
  toast(t('ids.dbcImported', { n: db.count, f: fileName }) + (db.skipped ? ' ' + t('ids.dbcSkipped', { n: db.skipped }) : ''));
}
$('dbcFile').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => importDbcText(r.result, f.name); r.readAsText(f); e.target.value = '';
};
$('btnDemoDbc').onclick = () => fetch('dbc/demo.dbc').then(r => r.text()).then(x => importDbcText(x, 'demo.dbc')).catch(() => toast(t('ids.demoFail')));
$('btnExportDbc').onclick = () => {
  const labels = profile().labels;
  if (!Object.keys(labels).length) { toast(t('ids.noLabels')); return; }
  const out = {};
  for (const id in labels) out[id] = { name: labelFor(id).name, signals: (labels[id].signals || []).map(s => Object.assign({}, s, { name: sigName(s) })) };
  saveText(profiles.current.replace(/[^A-Za-z0-9_-]+/g, '_') + '.dbc', 'text/plain', Dbc.exportDbc(out, profiles.current));
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
  if (k.startsWith('raw:')) { const [, id, b] = k.split(':'); return { id, name: 'B' + b, label: t('bytes.label', { id, b }), start: +b * 8, length: 8, order: 'intel', signed: false, scale: 1, offset: 0, unit: '' }; }
  if (k.startsWith('pid:')) { const pid = +k.slice(4); const d = C.PIDS[pid]; return d ? { pid, unit: d.unit, isPid: true } : null; }
  const [, id, ...rest] = k.split(':'); const name = rest.join(':');
  return allCanSignals().find(s => s.id === id && s.name === name) || null;
}
function refreshGraphIndex() {
  graphIndex = new Map(); sigCache.clear();
  for (const k of graphSel) if (k.startsWith('can:')) { const id = k.split(':')[1]; if (!graphIndex.has(id)) graphIndex.set(id, []); graphIndex.get(id).push(k); }
}
function pushSeries(k, tm, v, raw) {
  let s = series.get(k); if (!s) { s = []; series.set(k, s); }
  s.push({ t: tm, v }); while (s.length && tm - s[0].t > 60000) s.shift();
  if (raw) lastRaw.set(k, raw);
}
refreshGraphIndex();

$('btnPickSig').onclick = () => {
  const can = allCanSignals(); const seen = new Set();
  const canHtml = can.filter(s => { const k = s.id + ':' + s.name; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(s => { const k = 'can:' + s.id + ':' + s.name; return `<label><input type="checkbox" value="${esc(k)}" ${graphSel.includes(k) ? 'checked' : ''}>${esc(sigName(s))}<code>ID ${s.id}</code></label>`; }).join('');
  const pids = (supported.length ? supported : Object.keys(C.PIDS).map(Number)).filter(p => C.PIDS[p] && p !== 0x01 && p !== 0x1C && p !== 0x51).sort((a, b) => a - b);
  const pidHtml = pids.map(p => `<label><input type="checkbox" value="pid:${p}" ${graphSel.includes('pid:' + p) ? 'checked' : ''}>${esc(C.pidName(p))}<code>PID 01 ${C.hex2(p)}</code></label>`).join('');
  const rawHtml = graphSel.filter(k => k.startsWith('raw:')).map(k => `<label><input type="checkbox" value="${esc(k)}" checked>${esc(sigByKey(k).label)}<code>${esc(t('bytes.rawTag'))}</code></label>`).join('');
  $('sigPick').innerHTML = `<h4>${esc(t('pick.can'))}</h4>${canHtml || `<p class="sub">${esc(t('pick.noCan'))}</p>`}${rawHtml ? `<h4>${esc(t('bytes.rawHead'))}</h4>${rawHtml}` : ''}<h4>${esc(t('pick.pid'))}</h4>${pidHtml}`;
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
  if (cans.length && (!elm.protocol.can || sniffOk === false)) toast(t('graph.noSniff'));
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
      if (dt > 2) { $('grafRate').textContent = t('graph.rate', { n: (n / dt).toFixed(1) }); n = 0; t0 = now(); }
    }
  });
}

function buildCharts() {
  const box = $('charts'); box.innerHTML = '';
  $('grafEmpty').hidden = graphSel.length > 0;
  graphSel.forEach((k, i) => {
    const el = document.createElement('div'); el.className = 'chart'; el.dataset.k = k;
    el.innerHTML = `<div class="head"><div><div class="nm"></div><div class="val">–</div></div><button class="x" aria-label="${esc(t('common.remove'))}">×</button></div>`
      + `<div class="idline"><span class="src-id"></span><span class="raw"></span></div><canvas></canvas><div class="hexrow"></div><div class="idline"><span class="formula"></span><span class="hz"></span></div>`;
    el.querySelector('.x').onclick = () => { graphSel.splice(i, 1); store.set('graph', graphSel); refreshGraphIndex(); buildCharts(); };
    box.appendChild(el);
  });
  renderCharts();
}
function renderCharts() {
  document.querySelectorAll('.chart').forEach(el => {
    const k = el.dataset.k, sig = sigByKey(k), data = series.get(k) || [];
    if (!sig) { el.querySelector('.nm').textContent = t('graph.missing'); return; }
    el.querySelector('.nm').textContent = sigName(sig);
    const last = data[data.length - 1];
    el.querySelector('.val').innerHTML = esc(last ? (sig.active != null || sig.values ? valueText(sig, last.v) : fmt(last.v)) : '–') + `<small>${esc(sig.active != null || sig.values ? '' : sig.unit || '')}</small>`;
    if (sig.isPid) {
      el.querySelector('.src-id').innerHTML = `${esc(t('graph.stdPid'))} <b>01 ${C.hex2(sig.pid)}</b>`;
      el.querySelector('.raw').textContent = t('graph.obdQuery');
      el.querySelector('.formula').textContent = '';
      el.querySelector('.hexrow').innerHTML = '';
    } else {
      const bytes = signalBytes(sig), raw = lastRaw.get(k);
      el.querySelector('.src-id').innerHTML = `ID <b>0x${esc(sig.id)}</b> · ${esc(t('graph.byte'))} ${bytes.length > 1 ? bytes[0] + '–' + bytes[bytes.length - 1] : bytes[0]}${sig.length < 8 ? ' bit ' + (sig.start & 7) : ''}`;
      el.querySelector('.raw').innerHTML = raw ? esc(t('graph.raw')) + ' <b>0x' + bytes.map(b => C.hex2(raw[b] || 0)).join('') + '</b>' : '';
      el.querySelector('.hexrow').innerHTML = raw ? `<i class="id">${esc(sig.id)}</i>` + raw.map((b, i) => `<i class="${bytes.includes(i) ? 'sel' : ''}">${C.hex2(b)}</i>`).join('') : '';
      el.querySelector('.formula').textContent = `${t('graph.value')} = ${t('graph.raw')} × ${sig.scale} ${sig.offset < 0 ? '−' : '+'} ${Math.abs(sig.offset)}`;
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
  const X = tm => padL + (w - padL) * (1 - (tn - tm) / win), Y = v => padT + plotH * (1 - (v - lo) / (hi - lo || 1));
  g.font = '10px ui-monospace, Menlo, monospace'; g.fillStyle = cssVar('--muted'); g.strokeStyle = cssVar('--line'); g.lineWidth = 1;
  for (const v of ticks) { const y = Y(v); g.beginPath(); g.moveTo(padL, y); g.lineTo(w, y); g.stroke(); g.fillText(fmt(v), 0, y + 3); }
  g.fillText('−30 s', padL, h - 3); g.textAlign = 'right'; g.fillText(t('graph.now'), w, h - 3); g.textAlign = 'left';
  if (vis.length < 2) return;
  const tr = cssVar('--amber');
  g.beginPath(); vis.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v)));
  g.lineTo(X(vis[vis.length - 1].t), padT + plotH); g.lineTo(X(vis[0].t), padT + plotH); g.closePath();
  g.globalAlpha = 0.15; g.fillStyle = tr; g.fill(); g.globalAlpha = 1;
  g.beginPath(); vis.forEach((p, i) => i ? g.lineTo(X(p.t), Y(p.v)) : g.moveTo(X(p.t), Y(p.v)));
  g.strokeStyle = tr; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
  const lp = vis[vis.length - 1]; g.beginPath(); g.arc(X(lp.t), Y(lp.v), 3.5, 0, 7); g.fillStyle = tr; g.fill();
}

// ---------- Storan sesi (IndexedDB, jatuh balik ke localStorage) ----------
const kv = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('aboy-canbus', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const q = fn(db.transaction('kv', mode).objectStore('kv')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  }));
  return {
    get: k => tx('readonly', st => st.get(k)).catch(() => store.get('kv.' + k, null)),
    set: (k, v) => tx('readwrite', st => st.put(v, k)).catch(() => store.set('kv.' + k, v)),
    del: k => tx('readwrite', st => st.delete(k)).catch(() => store.set('kv.' + k, null))
  };
})();
const toHex = d => d.map(C.hex2).join('');
const fromHex = h => { const o = []; for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16)); return o; };
let pendingSession = null, interrupted = false, lastSave = 0;

// ---------- BELAJAR: banding dengan PID ----------
const LEARN_PIDS = [0x11, 0x0C, 0x0D, 0x05, 0x04, 0x0B, 0x10, 0x0F, 0x2F, 0x42, 0x5C, 0x46];
function fillLearnPids() {
  const list = LEARN_PIDS.filter(p => !supported.length || supported.includes(p));
  const cur = $('learnPid').value;
  $('learnPid').innerHTML = list.map(p => `<option value="${p}">${esc(C.pidName(p))} (PID 01 ${C.hex2(p)})</option>`).join('');
  if (cur && list.some(p => String(p) === cur)) $('learnPid').value = cur;
  updateLearnHint();
}
function updateLearnHint() { const p = +$('learnPid').value; $('learnHint').textContent = p ? t('hint.' + C.hex2(p), null, t('hint.default')) : ''; }
$('learnPid').onchange = updateLearnHint;

// Setiap bacaan PID disimpan bersama bingkai terkini setiap ID ("snap") — jimat memori dan boleh disambung semula
let learn = { pid: null, snaps: [], base: 0, results: [] };
const learnTime = () => learn.base + (learn.t0 != null ? (learn.tStop || now()) - learn.t0 : 0);
function learnCorrelate() {
  const h = new A.History(1e7);
  for (const sn of learn.snaps) for (const id in sn.d) h.add({ id, data: sn.d[id], t: sn.t });
  return A.correlate(learn.snaps.map(sn => ({ t: sn.t, v: sn.v })), h);
}
function snapLatest(id) {
  const e = hist.ids.get(id);
  if (e) return e.frames[e.frames.length - 1].data;
  for (let i = learn.snaps.length - 1; i >= 0; i--) if (learn.snaps[i].d[id]) return learn.snaps[i].d[id];
  return null;
}
function saveLearnSession(done) {
  lastSave = now();
  return kv.set('session', {
    kind: 'learn', pid: learn.pid, elapsed: learn.elapsed != null ? learn.elapsed : learnTime(), profile: profiles.current, savedAt: Date.now(), done: !!done,
    snaps: learn.snaps.map(sn => ({ t: sn.t, v: sn.v, f: Object.fromEntries(Object.entries(sn.d).map(([id, d]) => [id, toHex(d)])) }))
  });
}
$('btnLearn').onclick = async () => {
  if (engine && engine.kind === 'learn') return stopEngine();
  startLearn(null);
};
async function startLearn(resume) {
  if (needCan()) return;
  if (sniffOk === false) { toast(t('learn.noSniff')); return; }
  await stopEngine();
  if (resume) $('learnPid').value = String(resume.pid);
  const pid = +$('learnPid').value;
  learn = resume
    ? { pid, snaps: resume.snaps.map(sn => ({ t: sn.t, v: sn.v, d: Object.fromEntries(Object.entries(sn.f).map(([id, h]) => [id, fromHex(h)])) })), base: resume.elapsed, results: [] }
    : { pid, snaps: [], base: 0, results: [] };
  pendingSession = null; renderResume();
  hist.clear(); guessCache.clear();
  $('learnRef').hidden = false; $('learnResults').innerHTML = '';
  interrupted = false;
  startEngine('learn', async eng => {
    eng.burst = true;
    learn.t0 = now();
    let lastCalc = now();
    while (!eng.stop && elm) {
      const b0 = now();
      await elm.burst(250, onLine);
      const r = await elm.readPid(pid).catch(() => null);
      if (r && typeof r.value === 'number') {
        const d = {};
        for (const e of hist.ids.values()) { const f = e.frames[e.frames.length - 1]; if (f.t >= b0) d[e.id] = f.data; }
        learn.snaps.push({ t: learnTime(), v: r.value, d });
      }
      if (now() - lastCalc > 3000) { lastCalc = now(); learn.results = learnCorrelate().results; renderLearn(); }
      if (now() - lastSave > 2000) saveLearnSession(false);
    }
    learn.tStop = now();
  });
  engine.after = () => {
    learn.elapsed = learnTime(); learn.tEnd = true;
    const res = learnCorrelate(); learn.results = res.results; learn.error = res.error; learn.final = true;
    saveLearnSession(!interrupted);
    renderLearn(true);
  };
}
function renderLearn(final) {
  if (!learn.pid) return;
  const name = C.pidName(learn.pid), unit = C.PIDS[learn.pid].unit, last = learn.snaps[learn.snaps.length - 1];
  const secs = (learn.elapsed != null ? learn.elapsed : learnTime()) / 1000;
  const ids = last ? Object.keys(last.d).length : 0;
  $('learnRef').hidden = false;
  $('learnRef').innerHTML = `${last ? fmt(last.v) : '–'}<small> ${esc(unit)} · ${esc(t('learn.fromPid', { name }))}</small>`;
  $('learnInfo').textContent = t('learn.info', { s: secs.toFixed(0), n: learn.snaps.length, ids });
  if (final && learn.error) { $('learnResults').innerHTML = `<p class="hint">${esc(learn.error)}</p>`; return; }
  if (!learn.results.length) { $('learnResults').innerHTML = learn.snaps.length > 6 ? `<p class="sub">${esc(t('learn.none'))}</p>` : ''; return; }
  $('learnResults').innerHTML = `<h3 class="sec">${esc(final ? t('learn.best') : t('learn.sofar'))}</h3>` + learn.results.map((c, i) => {
    const raw = snapLatest(c.id);
    const v = raw ? C.extractSignal(raw, c) : null;
    const pct = Math.round(c.score * 100);
    return `<div class="cand"><span class="m">ID ${c.id} · ${esc(candLabel(c))}</span><span class="m">${pct}%</span><div class="meter"><span style="width:${pct}%"></span></div>`
      + `<span class="d">${esc(t('graph.value'))} = ${esc(t('graph.raw'))} × ${c.scale} ${c.offset < 0 ? '−' : '+'} ${Math.abs(c.offset)}${v != null ? ' → ' + esc(t('learn.now')) + ' ' + fmt(v) + ' ' + esc(unit) : ''}${c.r < 0 ? ' · ' + esc(t('learn.inverse')) : ''}</span>`
      + (final ? `<button class="btn small" data-i="${i}">${esc(t('learn.saveAs', { name }))}</button>` : '') + '</div>';
  }).join('') + (final ? `<p class="sub">${esc(t('learn.explain'))}</p>` : '');
  $('learnResults').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => saveLearned(learn.results[+b.dataset.i]));
}
const candLabel = c => c.length === 8 ? t('graph.byte') + ' ' + c.bytes[0] : t('graph.byte') + ' ' + c.bytes[0] + '–' + c.bytes[c.bytes.length - 1] + ' ' + (c.order === 'intel' ? 'LE' : 'BE');
function saveLearned(c) {
  const pid = learn.pid, unit = C.PIDS[pid].unit;
  const labels = profile().labels;
  const l = labels[c.id] || (labels[c.id] = { name: '', source: 'learn', signals: [] });
  if (l.source === 'user' && !l.name) l.source = 'learn';
  const key = 'PID_' + C.hex2(pid);
  l.signals = (l.signals || []).filter(s => s.name !== key);
  l.signals.push({ name: key, pid, id: c.id, start: c.start, length: c.length, order: c.order, signed: false, scale: c.scale, offset: c.offset, unit, source: 'learn', min: 0, max: 0 });
  l.learnPid = pid; l.learnScore = Math.round(c.score * 100);
  saveProfiles();
  const k = 'can:' + c.id + ':' + key;
  if (!graphSel.includes(k) && graphSel.length < 4) { graphSel.push(k); store.set('graph', graphSel); }
  refreshGraphIndex(); buildCharts();
  toast(t('learn.saved', { id: c.id, b: candLabel(c), name: C.pidName(pid) }));
}

// ---------- BELAJAR: cari nilai dari meter ----------
let findCands = null;
async function latestFrames() {
  // Jika tiada tangkapan berjalan, tangkap 1 saat dulu
  if (!(engine && (engine.kind === 'sniff' || engine.kind === 'act' || engine.kind === 'graf'))) {
    if (needCan()) return null;
    if (engine) { toast(t('msg.stopFirst')); return null; }
    engine = { kind: 'term' };
    try { await elm.burst(1200, onLine); } finally { engine = null; }
  }
  const m = new Map();
  for (const e of hist.ids.values()) if (now() - e.last < 5000) m.set(e.id, e.frames[e.frames.length - 1].data);
  return m;
}
async function doFind(again) {
  const val = parseFloat($('findVal').value);
  if (!isFinite(val)) { toast(t('find.needValue')); return; }
  $('btnFind').disabled = true;
  try {
    const latest = await latestFrames(); if (!latest) return;
    if (!latest.size) { toast(t('find.noFrames')); return; }
    const roles = new Map(); for (const [id] of latest) { const g = guessCache.get(id) || (hist.ids.get(id) && A.guess(hist.ids.get(id))); if (g && g.roles) roles.set(id, g.roles); }
    findCands = A.searchValue(latest, val, +$('findTol').value, again ? findCands : null, roles);
    findRound = again ? findRound + 1 : 1;
    renderFind(val);
  } finally { $('btnFind').disabled = false; }
}
let findRound = 0;
$('btnFind').onclick = () => doFind(false);
$('btnFindAgain').onclick = () => doFind(true);
$('btnFindReset').onclick = () => { findCands = null; findRound = 0; $('findResults').innerHTML = ''; $('findInfo').textContent = ''; $('btnFindAgain').disabled = $('btnFindReset').disabled = true; };
function renderFind(val) {
  const n = findCands ? findCands.length : 0;
  $('btnFindAgain').disabled = $('btnFindReset').disabled = !findCands;
  $('findInfo').textContent = !findCands ? '' : n ? t('find.count', { n, r: findRound }) + (n > 8 ? ' ' + t('find.narrow') : '') : t('find.none');
  $('findResults').innerHTML = (findCands || []).slice(0, 12).map((c, i) => `<div class="cand"><span class="m">ID ${c.id} · ${esc(candLabel(c))}</span><span class="m">${fmt(c.value)}</span>`
    + `<span class="d">${esc(t('graph.value'))} = ${esc(t('graph.raw'))} × ${+c.scale.toFixed(6)} ${c.offset < 0 ? '−' : '+'} ${Math.abs(c.offset)}</span>`
    + `<button class="btn small" data-i="${i}">${esc(t('find.save'))}</button></div>`).join('');
  $('findResults').querySelectorAll('button[data-i]').forEach(b => b.onclick = async () => {
    const c = findCands[+b.dataset.i];
    const name = await ask(t('find.saveTitle'), t('find.saveText', { id: c.id, b: candLabel(c) }), { input: true, placeholder: t('find.namePh'), ok: t('common.save') });
    if (!name) return;
    const labels = profile().labels;
    const l = labels[c.id] || (labels[c.id] = { name: '', source: 'user', signals: [] });
    l.signals = (l.signals || []).filter(s => s.name !== name);
    l.signals.push({ name, id: c.id, start: c.start, length: c.length, order: c.order, signed: false, scale: c.scale, offset: c.offset, unit: '', source: 'user', min: 0, max: 0 });
    saveProfiles(); refreshGraphIndex(); toast(t('msg.savedProfile', { p: profiles.current }));
  });
}

// ---------- BELAJAR: tindakan ----------
const act = { running: false, on: false, samples: [], marks: 0, results: [] };
function saveActSession(done) {
  lastSave = now();
  const sm = act.samples.length > 30000 ? act.samples.slice(-30000) : act.samples;
  return kv.set('session', { kind: 'act', name: $('actName').value.trim(), marks: act.marks, profile: profiles.current, savedAt: Date.now(), done: !!done,
    samples: sm.map(x => [x.on ? 1 : 0, x.f.id, toHex(x.f.data)]) });
}
$('btnAct').onclick = async () => {
  if (engine && engine.kind === 'act') return stopEngine();
  startAct(null);
};
async function startAct(resume) {
  if (needCan()) return;
  if (sniffOk === false) { toast(t('learn.noSniff')); return; }
  await stopEngine();
  Object.assign(act, { running: true, on: false, samples: [], marks: 0, results: [], final: false });
  if (resume) {
    act.samples = resume.samples.map(([on, id, h]) => ({ on: !!on, f: { id, data: fromHex(h) } }));
    act.marks = resume.marks || 0;
    if (resume.name) { $('actName').value = resume.name; $('actName').dataset.auto = '0'; }
  }
  pendingSession = null; renderResume();
  $('actResults').innerHTML = '';
  interrupted = false;
  if (transport instanceof SimTransport) transport.brake = false;
  startEngine('act', async eng => {
    const tick = setInterval(() => { if (now() - lastSave > 2000) saveActSession(false); }, 1000);
    try { await sniffUntilStop(eng); } finally { clearInterval(tick); }
  });
  engine.after = () => {
    act.running = false; act.final = true;
    if (transport instanceof SimTransport) transport.brake = null;
    act.results = A.actionBits(act.samples);
    saveActSession(!interrupted);
    renderAct(true);
  };
}
$('btnActOn').onclick = () => {
  act.on = !act.on; if (act.on) act.marks++;
  $('btnActOn').classList.toggle('on', act.on);
  updateButtons();
  if (transport instanceof SimTransport) transport.brake = act.on;
};
function renderAct(final) {
  const on = act.samples.filter(s => s.on).length;
  if (act.running || final) $('actInfo').textContent = t('act.info', { f: act.samples.length, m: act.marks, on });
  if (!final) return;
  if (act.marks < 1 || on < 3) { $('actResults').innerHTML = `<p class="hint">${esc(t('act.noMarks'))}</p>`; return; }
  if (!act.results.length) { $('actResults').innerHTML = `<p class="hint">${esc(t('act.noBits'))}</p>`; return; }
  const name = $('actName').value.trim() || t('act.default');
  $('actResults').innerHTML = `<h3 class="sec">${esc(t('act.found'))}</h3>` + act.results.map((r, i) => {
    const pct = Math.round(r.score * 100);
    return `<div class="cand"><span class="m">ID ${r.id} · ${esc(t('graph.byte'))} ${r.byte} bit ${r.bit}</span><span class="m">${pct}%</span><div class="meter"><span style="width:${pct}%"></span></div>`
      + `<span class="d">${esc(r.activeHigh ? t('act.high') : t('act.low'))} · ${esc(t('act.dbcStart', { n: r.start }))}</span><button class="btn small" data-i="${i}">${esc(t('learn.saveAs', { name }))}</button></div>`;
  }).join('');
  $('actResults').querySelectorAll('button[data-i]').forEach(b => b.onclick = () => {
    const r = act.results[+b.dataset.i];
    const labels = profile().labels;
    const l = labels[r.id] || (labels[r.id] = { name: '', source: 'learn', signals: [] });
    l.signals = (l.signals || []).filter(s => s.name !== name);
    l.signals.push({ name, id: r.id, start: r.start, length: 1, order: 'intel', signed: false, scale: 1, offset: 0, unit: '', source: 'learn', active: r.activeHigh ? 1 : 0 });
    if (l.learnPid == null) l.actScore = Math.round(r.score * 100);
    saveProfiles(); refreshGraphIndex();
    toast(t('act.saved', { id: r.id, b: r.byte, bit: r.bit, name }));
  });
}

// ---------- Sambung semula sesi ----------
function renderResume() {
  const s = pendingSession;
  $('resumeCard').hidden = !s;
  if (!s) return;
  const when = new Date(s.savedAt).toLocaleString(I18N.lang === 'ms' ? 'ms-MY' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  $('resumeText').textContent = s.kind === 'learn'
    ? t('resume.learn', { name: C.pidName(s.pid), s: Math.round(s.elapsed / 1000), n: s.snaps.length, when })
    : t('resume.act', { name: s.name || t('act.default'), n: s.samples.length, m: s.marks, when });
}
$('btnResume').onclick = () => {
  const s = pendingSession; if (!s) return;
  if (!elm) { toast(t('resume.needConn')); showTab('conn'); return; }
  if (s.profile && profiles.list[s.profile]) { profiles.current = s.profile; renderProfiles(); }
  if (s.kind === 'learn') startLearn(s); else startAct(s);
};
$('btnResumeView').onclick = () => {
  const s = pendingSession; if (!s) return;
  if (s.kind === 'learn') {
    $('learnPid').value = String(s.pid);
    learn = { pid: s.pid, snaps: s.snaps.map(sn => ({ t: sn.t, v: sn.v, d: Object.fromEntries(Object.entries(sn.f).map(([id, h]) => [id, fromHex(h)])) })), base: s.elapsed, elapsed: s.elapsed, results: [] };
    const res = learnCorrelate(); learn.results = res.results; learn.error = res.error; learn.final = true;
    renderLearn(true);
  } else {
    act.samples = s.samples.map(([on, id, h]) => ({ on: !!on, f: { id, data: fromHex(h) } })); act.marks = s.marks; act.final = true;
    if (s.name) $('actName').value = s.name;
    act.results = A.actionBits(act.samples); renderAct(true);
  }
};
$('btnResumeDrop').onclick = async () => {
  if (!(await ask(t('resume.dropTitle'), t('resume.dropText'), { ok: t('resume.drop') }))) return;
  pendingSession = null; kv.del('session'); renderResume();
};
kv.get('session').then(s => {
  if (s && !s.done && ((s.kind === 'learn' && s.snaps && s.snaps.length) || (s.kind === 'act' && s.samples && s.samples.length))) {
    pendingSession = s; renderResume(); setStatus(t('resume.banner'));
  }
});
kv.get('lastRec').then(r => { if (r && r.length) { lastRec = r; $('btnCsv').disabled = false; } });

// ---------- Belajar sendiri (auto) ----------
// Pantau beberapa PID berselang-seli dengan sniff, korelasi di latar belakang,
// dan cadangkan label bila padanan kuat & stabil. Pengguna sahkan dengan ✓.
const auto = { on: false, snaps: {}, sugg: new Map(), dismissed: new Set() };
$('btnAuto').onclick = () => { if (auto.on) stopAuto(); else startAuto(); };
function stopAuto() { auto.on = false; if (engine && engine.kind === 'auto') stopEngine(); updateAuto(); }
async function startAuto() {
  if (needCan()) return;
  if (sniffOk === false) { toast(t('learn.noSniff')); return; }
  await stopEngine();
  const AUTO_PIDS = [0x0C, 0x0D, 0x11, 0x04, 0x0B, 0x05];
  const pids = AUTO_PIDS.filter(p => !supported.length || supported.includes(p));
  if (!pids.length) { toast(t('auto.noPids')); return; }
  auto.on = true; auto.snaps = {}; auto.sugg = new Map(); auto.dismissed = new Set();
  pids.forEach(p => auto.snaps[p] = []);
  updateAuto();
  startEngine('auto', async eng => {
    eng.burst = true; let i = 0, lastCalc = now();
    while (!eng.stop && elm) {
      const pid = pids[i++ % pids.length];
      const b0 = now();
      await elm.burst(200, onLine);
      const r = await elm.readPid(pid).catch(() => null);
      if (r && typeof r.value === 'number') {
        const d = {};
        for (const e of hist.ids.values()) { const f = e.frames[e.frames.length - 1]; if (f.t >= b0) d[e.id] = f.data; }
        const arr = auto.snaps[pid]; arr.push({ t: now(), v: r.value, d }); if (arr.length > 400) arr.shift();
      }
      if (now() - lastCalc > 4000) { lastCalc = now(); autoAnalyse(pids); renderAuto(); }
    }
  });
}
function autoAnalyse(pids) {
  for (const pid of pids) {
    const snaps = auto.snaps[pid]; if (snaps.length < 8) continue;
    const vals = snaps.map(s => s.v); if (Math.max(...vals) - Math.min(...vals) < 1e-6) continue;
    const h = new A.History(1e7);
    for (const sn of snaps) for (const id in sn.d) h.add({ id, data: sn.d[id], t: sn.t });
    const res = A.correlate(snaps.map(s => ({ t: s.t, v: s.v })), h, { top: 1 });
    const c = res.results[0];
    if (c && c.score >= 0.9) {
      const key = pid + ':' + c.id + ':' + c.start + ':' + c.length;
      if (auto.dismissed.has(key)) continue;
      const prev = auto.sugg.get(key);
      auto.sugg.set(key, { pid, c, key, hits: (prev ? prev.hits : 0) + 1, score: c.score });
    }
  }
}
function updateAuto() {
  $('btnAuto').textContent = auto.on ? t('common.stop') : t('auto.start');
  $('btnAuto').setAttribute('aria-pressed', String(auto.on));
  $('autoInfo').textContent = auto.on ? t('auto.running') : t('auto.off');
  renderAuto();
}
function renderAuto() {
  const list = [...auto.sugg.values()].filter(s => s.hits >= 2).sort((a, b) => b.score - a.score);
  $('autoResults').innerHTML = list.map(sg => {
    const name = C.pidName(sg.pid);
    return `<div class="auto-sug"><span class="m">ID ${sg.c.id} · ${esc(candLabel(sg.c))}</span><span class="pct">${Math.round(sg.score * 100)}%</span>`
      + `<span class="d">${esc(name)} · ${esc(t('graph.value'))} = ${esc(t('graph.raw'))} × ${sg.c.scale} ${sg.c.offset < 0 ? '−' : '+'} ${Math.abs(sg.c.offset)}</span>`
      + `<button class="ok" data-k="${esc(sg.key)}" aria-label="${esc(t('auto.confirm'))}">✓ ${esc(t('auto.confirm'))}</button><button data-x="${esc(sg.key)}" aria-label="${esc(t('auto.dismiss'))}">✕</button></div>`;
  }).join('') || (auto.on ? `<p class="sub">${esc(t('auto.watching'))}</p>` : '');
  $('autoResults').querySelectorAll('button[data-k]').forEach(b => b.onclick = () => {
    const sg = auto.sugg.get(b.dataset.k); if (!sg) return;
    learn = { pid: sg.pid };
    saveLearned(sg.c);
    auto.dismissed.add(sg.key); auto.sugg.delete(sg.key); renderAuto();
  });
  $('autoResults').querySelectorAll('button[data-x]').forEach(b => b.onclick = () => { auto.dismissed.add(b.dataset.x); auto.sugg.delete(b.dataset.x); renderAuto(); });
}

// ---------- Hantar bingkai ke ECU (aftermarket / bench) ----------
// Kunci keselamatan: perlu akui amaran, kereta tidak bergerak, dan ID diagnostik OBD disekat.
let sending = null;
const BLOCKED_SEND = id => { const n = parseInt(id, 16); return id.length <= 3 && n >= 0x7DF && n <= 0x7EF; };
function updateSend() {
  const ack = $('sendAck').checked;
  $('btnSend').disabled = !ack || !!sending;
  $('btnSendStop').hidden = !sending;
  $('btnSend').textContent = sending && sending.hz ? t('send.sending') : t('send.send');
}
$('sendAck').onchange = updateSend;
async function carMoving() {
  if (!supported.length || !supported.includes(0x0D)) return null;   // tiada PID kelajuan
  const r = await elm.readPid(0x0D).catch(() => null);
  return r ? r.value > 0 : null;
}
$('btnSend').onclick = async () => {
  if (needCan()) return;
  if (!$('sendAck').checked) { toast(t('send.mustAck')); return; }
  const id = $('sendId').value.trim().toUpperCase();
  if (!/^[0-9A-F]{3}$|^[0-9A-F]{8}$/.test(id)) { toast(t('send.badId')); return; }
  if (BLOCKED_SEND(id)) { toast(t('send.blocked')); return; }
  const data = $('sendData').value.trim().split(/\s+/).filter(Boolean);
  if (!data.every(b => /^[0-9A-F]{1,2}$/.test(b)) || data.length === 0 || data.length > 8) { toast(t('send.badData')); return; }
  const bytes = data.map(b => parseInt(b, 16));
  const moving = await carMoving();
  if (moving === true) { toast(t('send.moving')); return; }
  if (moving === null && !(await ask(t('send.confirmTitle'), t('send.confirmPark'), { ok: t('send.confirmOk') }))) return;
  if (engine) await stopEngine();
  const hz = +$('sendHz').value;
  await elm.sendFrame(id, bytes).catch(e => toast(e.message));
  if (!hz) { await elm.endSend().catch(() => {}); $('sendInfo').textContent = t('send.sentOnce', { id }); return; }
  // Hantar berkala
  keepScreen(true);
  sending = { id, bytes, hz, count: 1, t0: now() }; updateSend();
  const period = 1000 / hz;
  (async () => {
    while (sending && elm) {
      await sleep(period);
      if (!sending || !elm) break;
      await elm.sendFrame(id, bytes).catch(() => {});
      sending.count++;
      $('sendInfo').textContent = t('send.sendingInfo', { id, hz, n: sending.count });
    }
    if (elm) await elm.endSend().catch(() => {});
    keepScreen(false); updateSend();
  })();
};
$('btnSendStop').onclick = () => { sending = null; $('sendInfo').textContent = t('send.stopped'); };
function renderSend() {
  $('sendSafe').innerHTML = [t('send.s1'), t('send.s2'), t('send.s3'), t('send.s4')].map(x => `<li class="n">${esc(x)}</li>`).join('');
  updateSend();
}

// ---------- Terminal ----------
$('termForm').addEventListener('submit', async e => {
  e.preventDefault();
  const cmd = $('termIn').value.trim().toUpperCase();
  if (!cmd || needConn()) return;
  if (engine) { toast(t('msg.stopFirst')); return; }
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
  const tn = now();
  if (tn - lastGuess > 1000 || force) { lastGuess = tn; for (const e of hist.ids.values()) guessCache.set(e.id, A.guess(e)); }
  if (tab === 'sniff') renderSniff();
  if (tab === 'graf') renderCharts();
  if (tab === 'ids' && (force || tn - lastIds > 1000)) { lastIds = tn; renderIds(); }
  if (tab === 'learn') { if (engine && engine.kind === 'learn') renderLearn(); if (act.running) renderAct(); if (auto.on) { autoAnalyse(Object.keys(auto.snaps).map(Number)); renderAuto(); $('autoInfo').textContent = t('auto.runningN', { n: Object.values(auto.snaps).reduce((a, b) => a + b.length, 0) }); } }
  if (tab === 'send') renderSend();
  if ($('idDlg').open && dlgId) renderIdBytes();
}
setInterval(() => { if (!document.hidden) render(); }, 250);

window.nativeBack = () => {
  const d = document.querySelector('dialog[open]');
  if (d) { d.close(); return true; }
  if (tab !== 'conn') { showTab('conn'); return true; }
  return false;
};
addEventListener('resize', () => renderCharts());

applyLanguage();
showTab('conn');
