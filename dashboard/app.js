const $ = id => document.getElementById(id);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
};

/* Tema */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#f2f5f8' : '#0b1016';
}
applyTheme(store.get('theme', 'dark'));
$('themeBtn').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  store.set('theme', next);
  applyTheme(next);
};

/* Jam & tanggal */
function tick() {
  const now = new Date();
  const h = now.getHours();
  $('clock').textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  $('date').textContent = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('greet').textContent = h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 19 ? 'Selamat sore' : 'Selamat malam';
}
tick();
setInterval(tick, 1000);

/* Baterai (didukung Chrome Android) */
if (navigator.getBattery) {
  navigator.getBattery().then(b => {
    const update = () => {
      const pct = Math.round(b.level * 100);
      $('batt').textContent = pct + '%';
      const bar = $('battBar');
      bar.style.width = pct + '%';
      bar.style.background = b.charging || pct > 30 ? 'var(--accent)' : pct > 15 ? 'var(--warn)' : 'var(--bad)';
      $('battSub').textContent = b.charging ? '⚡ Sedang mengisi' : 'Tidak mengisi';
    };
    update();
    ['levelchange', 'chargingchange'].forEach(ev => b.addEventListener(ev, update));
  });
} else {
  $('battSub').textContent = 'Tidak didukung browser ini';
}

/* Jaringan */
function updateNet() {
  const c = navigator.connection;
  $('net').textContent = navigator.onLine ? 'Online' : 'Offline';
  $('net').style.color = navigator.onLine ? 'var(--accent)' : 'var(--bad)';
  const parts = [];
  if (c) {
    if (c.type) parts.push(c.type === 'wifi' ? 'Wi-Fi' : c.type === 'cellular' ? 'Seluler' : c.type);
    if (c.effectiveType) parts.push(c.effectiveType.toUpperCase());
    if (c.downlink) parts.push(c.downlink + ' Mbps');
    if (c.saveData) parts.push('Hemat data');
  }
  $('netSub').textContent = parts.join(' · ');
}
updateNet();
addEventListener('online', updateNet);
addEventListener('offline', updateNet);
navigator.connection?.addEventListener('change', updateNet);

/* Info perangkat */
function updateDevice() {
  const ua = navigator.userAgent;
  const android = ua.match(/Android\s([\d.]+)/);
  const model = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/);
  const rows = [
    ['Sistem', android ? 'Android ' + android[1] : navigator.platform || '—'],
    ['Model', model && model[1] !== 'K' ? model[1] : '—'],
    ['Layar', `${screen.width}×${screen.height} @${devicePixelRatio}x`],
    ['CPU', navigator.hardwareConcurrency ? navigator.hardwareConcurrency + ' core' : '—'],
    ['RAM', navigator.deviceMemory ? '≥ ' + navigator.deviceMemory + ' GB' : '—'],
    ['Bahasa', navigator.language]
  ];
  $('device').innerHTML = '';
  rows.forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    $('device').append(dt, dd);
  });
}
updateDevice();
addEventListener('resize', updateDevice);

/* Tugas */
let todos = store.get('todos', []);
function renderTodos() {
  const list = $('todoList');
  list.innerHTML = '';
  if (!todos.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Belum ada tugas.';
    list.append(li);
  }
  todos.forEach((t, i) => {
    const li = document.createElement('li');
    if (t.done) li.className = 'done';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = t.done;
    cb.onchange = () => { t.done = cb.checked; saveTodos(); };
    const span = document.createElement('span'); span.textContent = t.text;
    const del = document.createElement('button');
    del.textContent = '×'; del.setAttribute('aria-label', 'Hapus');
    del.onclick = () => { todos.splice(i, 1); saveTodos(); };
    li.append(cb, span, del);
    list.append(li);
  });
  $('todoCount').textContent = todos.filter(t => !t.done).length;
}
function saveTodos() { store.set('todos', todos); renderTodos(); }
$('todoForm').onsubmit = e => {
  e.preventDefault();
  const text = $('todoInput').value.trim();
  if (!text) return;
  todos.push({ text, done: false });
  $('todoInput').value = '';
  saveTodos();
};
renderTodos();

/* Catatan */
$('notes').value = store.get('notes', '');
let noteTimer;
$('notes').oninput = () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => store.set('notes', $('notes').value), 300);
};

/* Pasang sebagai aplikasi (PWA) */
let deferredPrompt;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').onclick = async () => {
  $('installBtn').hidden = true;
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
