const $ = id => document.getElementById(id);
const money = Receipt.money;
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dmy = iso => iso.split('-').reverse().join('/');
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// "12.50" / "12,50" / "RM 1,200" -> sen (integer)
function toSen(v) {
  let s = String(v || '').replace(/[^\d.,]/g, '');
  if (/,\d{1,2}$/.test(s) && !s.includes('.')) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? Math.round(n * 100) : 0;
}
const senToInput = sen => sen ? (sen / 100).toFixed(2) : '';
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const BUY_CATS = ['Stok / alat ganti', 'Gaji pekerja', 'Sewa kedai', 'Bil elektrik / air', 'Peralatan', 'Minyak / pengangkutan', 'Lain-lain'];
const PAY = ['Tunai', 'Online / QR', 'Kad', 'Hutang'];
const DEFAULT_SHOP = { name: 'Kedai Saya', addr: '', phone: '', ssm: '', footer: 'Terima kasih! Sila datang lagi.', prefix: 'R' };

let shop = { ...DEFAULT_SHOP };
let nextNo = 1;
let sales = [], buys = [];
let view = new Date(); view.setDate(1);
let tab = 'home', salesFilter = 'all';

/* ================= Mula ================= */
async function init() {
  try {
    shop = { ...DEFAULT_SHOP, ...(await DB.getKV('shop') || {}) };
    nextNo = (await DB.getKV('nextNo')) || 1;
    sales = await DB.all('sales');
    buys = await DB.all('buys');
  } catch (e) {
    alert('Tidak dapat buka storan telefon. Pastikan bukan mod Incognito.\n' + e);
  }
  navigator.storage?.persist?.();
  fillSettings();
  render();
}

/* ================= Navigasi ================= */
document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(t) {
  tab = t;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + t; });
  $('fab').hidden = !(t === 'sales' || t === 'buys');
  if (t === 'set') updateStorageInfo();
  scrollTo(0, 0);
  render();
}
$('fab').onclick = () => tab === 'sales' ? openSaleForm() : openBuyForm();
document.querySelectorAll('[data-new]').forEach(b => b.onclick = () => b.dataset.new === 'sale' ? openSaleForm() : openBuyForm());
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
$('prevMonth').onclick = () => { view.setMonth(view.getMonth() - 1); render(); };
$('nextMonth').onclick = () => { view.setMonth(view.getMonth() + 1); render(); };
$('debtCard').onclick = () => { setSalesFilter('debt'); showTab('sales'); };
document.querySelectorAll('[data-sfilter]').forEach(b => b.onclick = () => { setSalesFilter(b.dataset.sfilter); renderSales(); });
function setSalesFilter(f) {
  salesFilter = f;
  document.querySelectorAll('[data-sfilter]').forEach(x => x.classList.toggle('on', x.dataset.sfilter === f));
}
$('salesSearch').oninput = () => renderSales();
$('buysSearch').oninput = () => renderBuys();

/* ================= Paparan ================= */
const sumTotal = list => list.reduce((a, x) => a + x.total, 0);

function render() {
  $('shopTitle').textContent = shop.name;
  $('todayLabel').textContent = new Date().toLocaleDateString('ms-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (tab === 'home') renderHome();
  if (tab === 'sales') renderSales();
  if (tab === 'buys') renderBuys();
  refreshDatalists();
}

function renderHome() {
  $('monthLabel').textContent = view.toLocaleDateString('ms-MY', { month: 'long', year: 'numeric' });
  const mk = monthKey(view);
  const ms = sales.filter(s => s.date.startsWith(mk));
  const mb = buys.filter(b => b.date.startsWith(mk));
  const tIn = sumTotal(ms), tOut = sumTotal(mb), net = tIn - tOut;
  $('totSales').textContent = money(tIn);
  $('totBuys').textContent = money(tOut);
  $('cntSales').textContent = ms.length + ' resit';
  $('cntBuys').textContent = mb.length + ' resit';
  $('profit').textContent = money(net);
  $('profit').classList.toggle('neg', net < 0);
  $('profitSub').textContent = tIn ? `Jualan − pembelian · margin ${Math.round(net / tIn * 100)}%` : 'Jualan − pembelian bulan ini';

  const debts = sales.filter(s => !s.paid);
  $('totDebt').textContent = money(sumTotal(debts));
  $('cntDebt').textContent = debts.length ? `${debts.length} resit · tekan untuk lihat` : 'Tiada hutang 👍';

  const today = isoDate(new Date());
  const dIn = sumTotal(sales.filter(s => s.date === today));
  const dOut = sumTotal(buys.filter(b => b.date === today));
  $('dayIn').textContent = money(dIn);
  $('dayOut').textContent = money(dOut);
  $('dayNet').textContent = money(dIn - dOut);

  // Pembelian ikut kategori
  const by = {};
  mb.forEach(b => { by[b.cat] = (by[b.cat] || 0) + b.total; });
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const ul = $('bars'); ul.innerHTML = '';
  if (!rows.length) ul.append(el('li', 'empty', 'Tiada pembelian bulan ini.'));
  rows.forEach(([cat, v]) => {
    const li = el('li');
    li.title = `${cat}: ${money(v)}`;
    const val = el('span', 'val', money(v));
    val.append(el('span', 'pct', Math.round(v / tOut * 100) + '%'));
    const track = el('div', 'track'), fill = el('div', 'fill');
    fill.style.width = Math.max(2, v / rows[0][1] * 100) + '%';
    track.append(fill);
    li.append(el('span', '', cat), val, track);
    ul.append(li);
  });

  // Rekod terkini
  const recent = [...sales.map(s => ({ t: 's', x: s })), ...buys.map(b => ({ t: 'b', x: b }))]
    .sort((a, b) => b.x.created - a.x.created).slice(0, 6);
  const box = $('recent'); box.innerHTML = '';
  if (!recent.length) box.append(el('p', 'empty', 'Belum ada rekod. Tekan butang di atas untuk mula.'));
  recent.forEach(r => box.append(r.t === 's' ? saleRow(r.x) : buyRow(r.x)));
}

function saleRow(s) {
  const row = el('button', 'tx');
  const info = el('div');
  const t1 = el('div', 't1', s.no + ' · ' + (s.plate || s.cust || 'Pelanggan'));
  if (!s.paid) t1.append(el('span', 'tag debt', 'Hutang'));
  const desc = s.items.map(i => i.desc).filter(Boolean).join(', ');
  info.append(t1, el('div', 't2', [dmy(s.date), s.cust && s.plate ? s.cust : '', desc].filter(Boolean).join(' · ')));
  row.append(info, el('div', 'amt in', '+' + money(s.total)));
  row.onclick = () => openReceipt(s);
  return row;
}

function buyRow(b) {
  const row = el('button', 'tx');
  const info = el('div');
  const t1 = el('div', 't1', b.supp || b.cat);
  if (b.photo) t1.append(el('span', 'tag', '📷'));
  info.append(t1, el('div', 't2', [dmy(b.date), b.cat, b.desc].filter(Boolean).join(' · ')));
  row.append(info, el('div', 'amt out', '−' + money(b.total)));
  row.onclick = () => openBuyView(b);
  return row;
}

function groupByMonth(list, box, rowFn, emptyMsg) {
  box.innerHTML = '';
  if (!list.length) { box.append(el('p', 'empty', emptyMsg)); return; }
  let cur = null, head = null, sum = 0;
  list.forEach(x => {
    const mk = x.date.slice(0, 7);
    if (mk !== cur) {
      cur = mk; sum = 0;
      head = el('div', 'day-h');
      const label = new Date(mk + '-01T00:00').toLocaleDateString('ms-MY', { month: 'long', year: 'numeric' });
      head.append(el('span', '', label), el('span', ''));
      box.append(head);
    }
    sum += x.total;
    head.lastChild.textContent = money(sum);
    box.append(rowFn(x));
  });
}

function renderSales() {
  const q = $('salesSearch').value.trim().toLowerCase();
  const list = sales
    .filter(s => salesFilter === 'all' || !s.paid)
    .filter(s => !q || [s.no, s.cust, s.plate, s.phone, s.vehicle, ...s.items.map(i => i.desc)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  groupByMonth(list, $('salesList'), saleRow,
    q ? 'Tiada padanan.' : salesFilter === 'debt' ? 'Tiada hutang belum bayar 👍' : 'Belum ada resit pelanggan. Tekan ＋ untuk buat resit.');
}

function renderBuys() {
  const q = $('buysSearch').value.trim().toLowerCase();
  const list = buys
    .filter(b => !q || [b.supp, b.desc, b.cat].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  groupByMonth(list, $('buysList'), buyRow, q ? 'Tiada padanan.' : 'Belum ada resit pembelian. Tekan ＋ untuk rekod.');
}

function refreshDatalists() {
  const uniq = arr => [...new Set(arr.filter(Boolean))].slice(0, 200);
  const fill = (id, vals) => {
    const dl = $(id); dl.innerHTML = '';
    vals.forEach(v => { const o = document.createElement('option'); o.value = v; dl.append(o); });
  };
  const recentSales = [...sales].sort((a, b) => b.created - a.created);
  fill('dlPlates', uniq(recentSales.map(s => s.plate)));
  fill('dlVehicles', uniq(recentSales.map(s => s.vehicle)));
  fill('dlCusts', uniq(recentSales.map(s => s.cust)));
  fill('dlItems', uniq(recentSales.flatMap(s => s.items.map(i => i.desc))));
  fill('dlSupps', uniq([...buys].sort((a, b) => b.created - a.created).map(b => b.supp)));
}

/* ================= Borang resit pelanggan ================= */
let editingSale = null, salePay = 'Tunai';

function chipGroup(box, options, current, onPick) {
  box.innerHTML = '';
  options.forEach(o => {
    const b = el('button', 'chip' + (o === current ? ' on' : ''), o);
    b.type = 'button';
    b.onclick = () => { box.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); onPick(o); };
    box.append(b);
  });
}

function itemRow(it = { desc: '', qty: 1, price: 0 }) {
  const row = el('div', 'item');
  row.innerHTML = `
    <input class="i-desc" list="dlItems" placeholder="Kerja / alat ganti" maxlength="80" autocomplete="off">
    <input class="i-qty" inputmode="decimal" aria-label="Kuantiti" autocomplete="off">
    <input class="i-price" inputmode="decimal" placeholder="Harga" aria-label="Harga seunit (RM)" autocomplete="off">
    <span class="i-line">RM0.00</span>
    <button type="button" class="i-del" aria-label="Buang item">×</button>`;
  row.querySelector('.i-desc').value = it.desc;
  row.querySelector('.i-qty').value = it.qty;
  row.querySelector('.i-price').value = senToInput(it.price);
  row.querySelector('.i-del').onclick = () => {
    row.remove();
    if (!$('items').children.length) $('items').append(itemRow());
    updateSaleTotal();
  };
  row.oninput = updateSaleTotal;
  return row;
}

function readItems() {
  return [...$('items').children].map(r => ({
    desc: r.querySelector('.i-desc').value.trim(),
    qty: parseFloat(r.querySelector('.i-qty').value.replace(',', '.')) || 0,
    price: toSen(r.querySelector('.i-price').value)
  })).filter(i => (i.desc || i.price) && i.qty > 0);
}

function updateSaleTotal() {
  [...$('items').children].forEach(r => {
    const q = parseFloat(r.querySelector('.i-qty').value.replace(',', '.')) || 0;
    r.querySelector('.i-line').textContent = money(Math.round(q * toSen(r.querySelector('.i-price').value)));
  });
  const sub = readItems().reduce((a, i) => a + Math.round(i.qty * i.price), 0);
  $('fTotal').textContent = money(Math.max(0, sub - toSen($('fDisc').value)));
}
$('fDisc').oninput = updateSaleTotal;
$('addItem').onclick = () => {
  const r = itemRow(); $('items').append(r); r.querySelector('.i-desc').focus();
};

// Isi automatik maklumat pelanggan lama bila taip no. plat / nama
function autofill(field) {
  const v = $(field).value.trim().toLowerCase();
  if (!v) return;
  const key = field === 'fPlate' ? 'plate' : 'cust';
  const prev = [...sales].sort((a, b) => b.created - a.created).find(s => (s[key] || '').toLowerCase() === v);
  if (!prev) return;
  [['fCust', 'cust'], ['fPhone', 'phone'], ['fVehicle', 'vehicle'], ['fPlate', 'plate']].forEach(([id, k]) => {
    if (!$(id).value && prev[k]) $(id).value = prev[k];
  });
}
$('fPlate').onchange = () => { $('fPlate').value = $('fPlate').value.toUpperCase(); autofill('fPlate'); };
$('fCust').onchange = () => autofill('fCust');

function openSaleForm(s = null) {
  editingSale = s;
  $('saleTitle').textContent = s ? 'Ubah ' + s.no : 'Resit Pelanggan Baru';
  $('fPlate').value = s?.plate || '';
  $('fVehicle').value = s?.vehicle || '';
  $('fCust').value = s?.cust || '';
  $('fPhone').value = s?.phone || '';
  $('fDisc').value = senToInput(s?.disc || 0);
  $('fDate').value = s?.date || isoDate(new Date());
  $('fNote').value = s?.note || '';
  salePay = s?.pay || 'Tunai';
  chipGroup($('fPay'), PAY, salePay, p => { salePay = p; });
  $('items').innerHTML = '';
  (s?.items?.length ? s.items : [undefined]).forEach(it => $('items').append(itemRow(it)));
  updateSaleTotal();
  $('saleDlg').showModal();
  $('saleDlg').querySelector('.dlg-body').scrollTop = 0;
}

$('saleForm').onsubmit = async e => {
  e.preventDefault();
  const items = readItems();
  if (!items.length) { alert('Masukkan sekurang-kurangnya satu item dengan harga.'); return; }
  const sub = items.reduce((a, i) => a + Math.round(i.qty * i.price), 0);
  const disc = Math.min(toSen($('fDisc').value), sub);
  const paid = salePay !== 'Hutang';
  const s = editingSale ? { ...editingSale } : { created: Date.now(), time: nowTime() };
  Object.assign(s, {
    plate: $('fPlate').value.trim().toUpperCase(),
    vehicle: $('fVehicle').value.trim(),
    cust: $('fCust').value.trim(),
    phone: $('fPhone').value.trim(),
    items, disc, total: sub - disc,
    date: $('fDate').value,
    pay: salePay, paid,
    paidDate: paid ? (editingSale?.paidDate || $('fDate').value) : null,
    note: $('fNote').value.trim()
  });
  if (!s.no) {
    s.no = (shop.prefix || '') + String(nextNo).padStart(4, '0');
    nextNo++;
    await DB.setKV('nextNo', nextNo);
  }
  s.id = await DB.put('sales', s);
  sales = sales.filter(x => x.id !== s.id).concat(s);
  $('saleDlg').close();
  render();
  openReceipt(s);
};

/* ================= Papar / hantar resit ================= */
let curSale = null, curCanvas = null;

function openReceipt(s) {
  curSale = s;
  curCanvas = Receipt.draw(s, shop);
  $('rcptImg').src = curCanvas.toDataURL('image/png');
  $('rcptTitle').textContent = (s.paid ? 'Resit ' : 'Invois ') + s.no;
  $('rPaid').hidden = s.paid;
  $('rWaText').textContent = s.phone ? 'WhatsApp ke ' + s.phone : 'WhatsApp (teks)';
  if (!$('rcptDlg').open) $('rcptDlg').showModal();
}

function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '6' + d;          // 012… -> 6012…
  return d;
}
function openWhatsAppText() {
  const num = waNumber(curSale.phone);
  open(`https://wa.me/${num}?text=${encodeURIComponent(Receipt.text(curSale, shop))}`, '_blank');
}

$('rShare').onclick = async () => {
  const blob = await new Promise(r => curCanvas.toBlob(r, 'image/png'));
  const file = new File([blob], `Resit-${curSale.no}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `Resit ${curSale.no}`, text: `${shop.name} — resit ${curSale.no} (${money(curSale.total)})` });
      return;
    } catch (err) { if (err.name === 'AbortError') return; }
  }
  // Telefon/browser tak sokong kongsi gambar: hantar teks
  openWhatsAppText();
};
$('rWaText').onclick = openWhatsAppText;

$('rPrint').onclick = () => {
  const area = $('printArea');
  area.innerHTML = '';
  const img = new Image();
  img.onload = () => { setTimeout(() => print(), 50); };
  img.src = $('rcptImg').src;
  area.append(img);
};

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('rPdf').onclick = () => download(`Resit-${curSale.no}.pdf`, Receipt.pdf(curCanvas));

$('rPaid').onclick = async () => {
  const pay = prompt('Pelanggan bayar guna apa? (Tunai / Online / Kad)', 'Tunai');
  if (pay === null) return;
  const s = { ...curSale, paid: true, paidDate: isoDate(new Date()), pay: pay.trim() || 'Tunai' };
  await DB.put('sales', s);
  sales = sales.map(x => x.id === s.id ? s : x);
  render();
  openReceipt(s);
};
$('rEdit').onclick = () => { $('rcptDlg').close(); openSaleForm(curSale); };
$('rDel').onclick = async () => {
  if (!confirm(`Padam resit ${curSale.no} (${money(curSale.total)})? Tidak boleh undo.`)) return;
  await DB.del('sales', curSale.id);
  sales = sales.filter(x => x.id !== curSale.id);
  $('rcptDlg').close();
  render();
};

/* ================= Resit pembelian ================= */
let editingBuy = null, buyCat = BUY_CATS[0], buyPhoto = null, photoURL = null;

function setPhotoPreview(blob) {
  buyPhoto = blob;
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = blob ? URL.createObjectURL(blob) : null;
  $('bPhotoPrev').hidden = !blob;
  $('bPhotoDel').hidden = !blob;
  $('bPhotoHint').hidden = !!blob;
  if (blob) $('bPhotoPrev').src = photoURL;
}

// Kecilkan gambar supaya jimat ruang (maks 1400px, JPEG)
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
}
$('bPhoto').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { setPhotoPreview(await compressImage(f)); }
  catch { setPhotoPreview(f); }
  e.target.value = '';
};
$('bPhotoDel').onclick = () => setPhotoPreview(null);

function openBuyForm(b = null) {
  editingBuy = b;
  $('buyTitle').textContent = b ? 'Ubah Resit Pembelian' : 'Resit Pembelian Baru';
  $('bAmt').value = senToInput(b?.total || 0);
  $('bSupp').value = b?.supp || '';
  $('bDesc').value = b?.desc || '';
  $('bDate').value = b?.date || isoDate(new Date());
  $('bPay').value = b?.pay || 'Tunai';
  buyCat = b?.cat || BUY_CATS[0];
  chipGroup($('bCats'), BUY_CATS, buyCat, c => { buyCat = c; });
  setPhotoPreview(b?.photo || null);
  $('buyDlg').showModal();
}

$('buyForm').onsubmit = async e => {
  e.preventDefault();
  const total = toSen($('bAmt').value);
  if (total <= 0) { $('bAmt').focus(); return; }
  const b = editingBuy ? { ...editingBuy } : { created: Date.now() };
  Object.assign(b, {
    total, cat: buyCat,
    supp: $('bSupp').value.trim(),
    desc: $('bDesc').value.trim(),
    date: $('bDate').value,
    pay: $('bPay').value,
    photo: buyPhoto
  });
  b.id = await DB.put('buys', b);
  buys = buys.filter(x => x.id !== b.id).concat(b);
  $('buyDlg').close();
  render();
};

let curBuy = null, bvURL = null;
function openBuyView(b) {
  curBuy = b;
  if (bvURL) URL.revokeObjectURL(bvURL);
  bvURL = b.photo ? URL.createObjectURL(b.photo) : null;
  $('bvImg').hidden = !b.photo;
  if (bvURL) $('bvImg').src = bvURL;
  const dl = $('bvInfo'); dl.innerHTML = '';
  [['Jumlah', money(b.total)], ['Tarikh', dmy(b.date)], ['Kategori', b.cat], ['Pembekal', b.supp || '—'],
   ['Keterangan', b.desc || '—'], ['Cara bayar', b.pay]].forEach(([k, v]) => dl.append(el('dt', '', k), el('dd', '', v)));
  $('buyView').showModal();
}
$('bvImg').onclick = () => bvURL && open(bvURL, '_blank');
$('bvEdit').onclick = () => { $('buyView').close(); openBuyForm(curBuy); };
$('bvDel').onclick = async () => {
  if (!confirm(`Padam pembelian ${money(curBuy.total)}? Tidak boleh undo.`)) return;
  await DB.del('buys', curBuy.id);
  buys = buys.filter(x => x.id !== curBuy.id);
  $('buyView').close();
  render();
};

/* ================= Tetapan ================= */
function fillSettings() {
  $('sName').value = shop.name; $('sAddr').value = shop.addr; $('sPhone').value = shop.phone;
  $('sSsm').value = shop.ssm; $('sFooter').value = shop.footer; $('sPrefix').value = shop.prefix;
  $('sNext').value = nextNo;
}
$('setForm').onsubmit = async e => {
  e.preventDefault();
  shop = {
    name: $('sName').value.trim() || 'Kedai Saya', addr: $('sAddr').value.trim(), phone: $('sPhone').value.trim(),
    ssm: $('sSsm').value.trim(), footer: $('sFooter').value.trim(), prefix: $('sPrefix').value.trim()
  };
  const n = parseInt($('sNext').value, 10);
  if (n > 0) { nextNo = n; await DB.setKV('nextNo', nextNo); }
  await DB.setKV('shop', shop);
  render();
  $('savedMsg').hidden = false;
  setTimeout(() => { $('savedMsg').hidden = true; }, 2000);
};

async function updateStorageInfo() {
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  const mb = est ? (est.usage / 1048576).toFixed(1) + ' MB digunakan' : '';
  $('storageInfo').textContent = `${sales.length} resit pelanggan · ${buys.length} resit pembelian${mb ? ' · ' + mb : ''}${persisted ? ' · storan kekal ✓' : ''}`;
}

const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();

$('backupBtn').onclick = async () => {
  const data = {
    app: 'akaun-kedai', version: 1, savedAt: new Date().toISOString(),
    kv: { shop, nextNo }, sales,
    buys: await Promise.all(buys.map(async b => ({ ...b, photo: b.photo ? await blobToDataURL(b.photo) : null })))
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `backup-akaun-${isoDate(new Date())}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] }) && confirm('Kongsi fail backup (contoh: ke WhatsApp sendiri / Google Drive)?\nTekan Cancel untuk muat turun sahaja.')) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  download(name, blob);
};

$('restoreFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'akaun-kedai' || !Array.isArray(data.sales) || !Array.isArray(data.buys)) throw new Error('format');
    if (!confirm(`Pulih ${data.sales.length} resit pelanggan & ${data.buys.length} resit pembelian?\nData sekarang dalam telefon ini akan DIGANTI.`)) return;
    data.buys = await Promise.all(data.buys.map(async b => ({ ...b, photo: b.photo ? await dataURLToBlob(b.photo) : null })));
    await DB.replaceAll(data);
    await init();
    alert('Backup berjaya dipulihkan.');
  } catch { alert('Fail backup tidak sah.'); }
};

$('csvBtn').onclick = () => {
  const mk = monthKey(view);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Tarikh', 'Jenis', 'No. resit / Pembekal', 'Pelanggan', 'No. plat', 'Kategori / Item', 'Cara bayar', 'Status', 'Amaun (RM)']];
  sales.filter(s => s.date.startsWith(mk)).forEach(s => rows.push([s.date, 'Jualan', s.no, s.cust, s.plate,
    s.items.map(i => i.desc).join('; '), s.pay, s.paid ? 'Dibayar' : 'Hutang', (s.total / 100).toFixed(2)]));
  buys.filter(b => b.date.startsWith(mk)).forEach(b => rows.push([b.date, 'Pembelian', b.supp, '', '',
    b.cat + (b.desc ? ' - ' + b.desc : ''), b.pay, '', (-b.total / 100).toFixed(2)]));
  rows.splice(1, rows.length - 1, ...rows.slice(1).sort((a, b) => a[0].localeCompare(b[0])));
  const csv = '﻿' + rows.map(r => r.map((v, i) => i === 8 && r !== rows[0] ? v : esc(v)).join(',')).join('\n');
  download(`akaun-${mk}.csv`, new Blob([csv], { type: 'text/csv' }));
};

/* ================= PWA ================= */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
setInterval(() => { $('todayLabel').textContent = new Date().toLocaleDateString('ms-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }, 60000);

init();
