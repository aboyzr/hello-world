const $ = id => document.getElementById(id);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { alert('Gagal simpan data. Ruang storan mungkin penuh.'); }
  }
};

const CATS = {
  in: ['Upah servis', 'Jual alat ganti', 'Repair / baiki', 'Cuci / polish', 'Lain-lain'],
  out: ['Beli stok / alat ganti', 'Gaji pekerja', 'Sewa kedai', 'Bil elektrik / air', 'Peralatan', 'Minyak / pengangkutan', 'Lain-lain']
};
const BAR_COLOR = { in: 'var(--in)', out: 'var(--out)' };

/* Amaun disimpan dalam sen (integer) supaya kira tepat */
const fmt = sen => (sen < 0 ? '-' : '') + 'RM' + (Math.abs(sen) / 100).toLocaleString('ms-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

let txs = store.get('txs', []);
let view = new Date(); view.setDate(1);
let barKind = 'out';
const save = () => { store.set('txs', txs); render(); };

/* Tema */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#f2f5f8' : '#0b1016';
}
applyTheme(store.get('theme', 'dark'));
$('themeBtn').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  store.set('theme', next); applyTheme(next);
};

/* Nama kedai */
$('shopName').textContent = store.get('shop', 'Workshop Saya');
$('shopName').onclick = () => {
  const n = prompt('Nama kedai:', $('shopName').textContent);
  if (n && n.trim()) { store.set('shop', n.trim()); $('shopName').textContent = n.trim(); }
};

/* Bulan */
$('prevMonth').onclick = () => { view.setMonth(view.getMonth() - 1); render(); };
$('nextMonth').onclick = () => { view.setMonth(view.getMonth() + 1); render(); };

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  barKind = t.dataset.kind; renderBars();
});
$('search').oninput = () => renderList();

function sum(list, kind) { return list.filter(t => t.kind === kind).reduce((a, t) => a + t.amt, 0); }
function monthTx() { const k = monthKey(view); return txs.filter(t => t.date.startsWith(k)); }

function render() {
  const now = new Date();
  $('today').textContent = now.toLocaleDateString('ms-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('monthLabel').textContent = view.toLocaleDateString('ms-MY', { month: 'long', year: 'numeric' });

  const m = monthTx();
  const tin = sum(m, 'in'), tout = sum(m, 'out'), net = tin - tout;
  $('totIn').textContent = fmt(tin);
  $('totOut').textContent = fmt(tout);
  $('cntIn').textContent = m.filter(t => t.kind === 'in').length + ' rekod';
  $('cntOut').textContent = m.filter(t => t.kind === 'out').length + ' rekod';
  $('profit').textContent = fmt(net);
  $('profit').classList.toggle('neg', net < 0);
  const debt = m.filter(t => t.kind === 'in' && t.pay === 'Hutang').reduce((a, t) => a + t.amt, 0);
  $('profitSub').textContent = (tin ? `Margin ${Math.round(net / tin * 100)}%` : 'Belum ada duit masuk')
    + (debt ? ` · Hutang pelanggan ${fmt(debt)}` : '');

  const d = txs.filter(t => t.date === isoDate(now));
  const din = sum(d, 'in'), dout = sum(d, 'out');
  $('dayIn').textContent = fmt(din);
  $('dayOut').textContent = fmt(dout);
  $('dayNet').textContent = fmt(din - dout);

  renderBars(); renderList();
}

function renderBars() {
  const m = monthTx().filter(t => t.kind === barKind);
  const total = m.reduce((a, t) => a + t.amt, 0);
  const by = {};
  m.forEach(t => by[t.cat] = (by[t.cat] || 0) + t.amt);
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;
  const ul = $('bars'); ul.innerHTML = '';
  if (!rows.length) {
    ul.innerHTML = `<li class="empty">Tiada ${barKind === 'in' ? 'pendapatan' : 'belanja'} bulan ini.</li>`;
    return;
  }
  rows.forEach(([cat, v]) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = cat;
    const val = document.createElement('span'); val.className = 'val';
    val.innerHTML = `${fmt(v)}<span class="pct">${Math.round(v / total * 100)}%</span>`;
    const track = document.createElement('div'); track.className = 'track';
    const fill = document.createElement('div'); fill.className = 'fill';
    fill.style.width = Math.max(2, v / max * 100) + '%';
    fill.style.background = BAR_COLOR[barKind];
    track.append(fill);
    li.title = `${cat}: ${fmt(v)}`;
    li.append(name, val, track);
    ul.append(li);
  });
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const m = monthTx()
    .filter(t => !q || (t.note + ' ' + t.cat).toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const box = $('txList'); box.innerHTML = '';
  if (!m.length) {
    box.innerHTML = `<p class="empty">${q ? 'Tiada padanan.' : 'Belum ada transaksi bulan ini. Tekan butang di bawah untuk tambah.'}</p>`;
    return;
  }
  let cur = null;
  m.forEach(t => {
    if (t.date !== cur) {
      cur = t.date;
      const day = m.filter(x => x.date === cur);
      const h = document.createElement('div'); h.className = 'day-h';
      const dl = new Date(cur + 'T00:00').toLocaleDateString('ms-MY', { weekday: 'short', day: 'numeric', month: 'short' });
      h.innerHTML = `<span>${dl}</span><span>Untung ${fmt(sum(day, 'in') - sum(day, 'out'))}</span>`;
      box.append(h);
    }
    const row = document.createElement('div'); row.className = 'tx';
    const info = document.createElement('div');
    const t1 = document.createElement('div'); t1.className = 't1'; t1.textContent = t.cat;
    const tag = document.createElement('span'); tag.className = 'tag' + (t.pay === 'Hutang' ? ' debt' : ''); tag.textContent = t.pay;
    t1.append(tag);
    const t2 = document.createElement('div'); t2.className = 't2'; t2.textContent = t.note || '—';
    info.append(t1, t2);
    const amt = document.createElement('div'); amt.className = 'amt ' + t.kind;
    amt.textContent = (t.kind === 'in' ? '+' : '−') + fmt(t.amt);
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '×';
    del.setAttribute('aria-label', 'Padam');
    del.onclick = () => {
      if (confirm(`Padam ${t.cat} ${fmt(t.amt)}?`)) { txs = txs.filter(x => x.id !== t.id); save(); }
    };
    row.append(info, amt, del);
    box.append(row);
  });
}

/* Borang tambah transaksi */
let formKind = 'in', formCat = null;
function openSheet(kind) {
  formKind = kind; formCat = CATS[kind][0];
  $('sheetTitle').textContent = kind === 'in' ? 'Duit Masuk' : 'Duit Keluar';
  $('sheet').style.setProperty('--accent', kind === 'in' ? 'var(--in)' : 'var(--out)');
  $('amt').value = ''; $('note').value = '';
  const now = new Date();
  $('date').value = monthKey(view) === monthKey(now) ? isoDate(now) : isoDate(view);
  $('pay').value = 'Tunai';
  const chips = $('cats'); chips.innerHTML = '';
  CATS[kind].forEach(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (c === formCat ? ' on' : ''); b.textContent = c;
    b.onclick = () => {
      formCat = c;
      chips.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
    };
    chips.append(b);
  });
  $('sheet').showModal();
  setTimeout(() => $('amt').focus(), 50);
}
document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openSheet(b.dataset.open));
$('cancel').onclick = () => $('sheet').close();
$('txForm').onsubmit = e => {
  e.preventDefault();
  const sen = Math.round(parseFloat($('amt').value.replace(/,/g, '.').replace(/[^\d.]/g, '')) * 100);
  if (!sen || sen <= 0) { $('amt').focus(); return; }
  txs.push({ id: Date.now(), kind: formKind, amt: sen, cat: formCat, note: $('note').value.trim(), date: $('date').value, pay: $('pay').value });
  const d = new Date($('date').value + 'T00:00'); view = new Date(d.getFullYear(), d.getMonth(), 1);
  $('sheet').close();
  save();
};

/* Backup & eksport */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('exportCsv').onclick = () => {
  const m = monthTx().sort((a, b) => a.date.localeCompare(b.date));
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [['Tarikh', 'Jenis', 'Kategori', 'Nota', 'Cara bayar', 'Amaun (RM)'].join(',')];
  m.forEach(t => lines.push([t.date, t.kind === 'in' ? 'Masuk' : 'Keluar', esc(t.cat), esc(t.note), esc(t.pay),
    ((t.kind === 'in' ? 1 : -1) * t.amt / 100).toFixed(2)].join(',')));
  download(`akaun-${monthKey(view)}.csv`, '﻿' + lines.join('\n'), 'text/csv');
};
$('backup').onclick = () => download(`backup-akaun-${isoDate(new Date())}.json`,
  JSON.stringify({ shop: store.get('shop', ''), txs }, null, 1), 'application/json');
$('restore').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.txs)) throw 0;
    if (!confirm(`Pulih ${data.txs.length} rekod? Data sekarang akan diganti.`)) return;
    txs = data.txs;
    if (data.shop) { store.set('shop', data.shop); $('shopName').textContent = data.shop; }
    save();
  } catch { alert('Fail backup tidak sah.'); }
  e.target.value = '';
};

render();
setInterval(() => { $('today').textContent = new Date().toLocaleDateString('ms-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }, 60000);

/* Pasang sebagai aplikasi (PWA) */
let deferredPrompt;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => {
  $('installBtn').hidden = true;
  if (!deferredPrompt) return;
  deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null;
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
