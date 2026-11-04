// Lukis resit pelanggan ke canvas (dipakai untuk paparan, WhatsApp, cetak dan PDF)
const Receipt = (() => {
  const money = sen => (sen < 0 ? '-' : '') + 'RM' + (Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dmy = iso => iso.split('-').reverse().join('/');
  const subtotal = s => s.items.reduce((a, it) => a + Math.round(it.qty * it.price), 0);

  function draw(s, shop) {
    const W = 576, P = 28, S = 2; // 576px = lebar printer resit 80mm
    const FONT = 'system-ui, -apple-system, Roboto, "Segoe UI", sans-serif';

    const pass = (ctx, paint) => {
      let y = P;
      ctx.textBaseline = 'top';
      const setF = (sz, b) => { ctx.font = `${b ? '700 ' : ''}${sz}px ${FONT}`; };
      const wrap = (t, max) => {
        const out = [];
        String(t).split('\n').forEach(para => {
          let line = '';
          para.split(/\s+/).forEach(w => {
            const test = line ? line + ' ' + w : w;
            if (ctx.measureText(test).width > max && line) { out.push(line); line = w; }
            else line = test;
          });
          out.push(line);
        });
        return out;
      };
      const center = (t, sz = 22, b = false, color = '#000') => {
        if (!t) return;
        setF(sz, b);
        wrap(t, W - 2 * P).forEach(l => {
          if (paint) { ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(l, W / 2, y); }
          y += sz * 1.35;
        });
      };
      const lr = (l, r, sz = 22, b = false, color = '#000') => {
        setF(sz, b);
        const rw = r ? ctx.measureText(r).width + 16 : 0;
        wrap(l, W - 2 * P - rw).forEach((ln, i) => {
          if (paint) {
            ctx.fillStyle = color;
            ctx.textAlign = 'left'; ctx.fillText(ln, P, y);
            if (i === 0 && r) { ctx.textAlign = 'right'; ctx.fillText(r, W - P, y); }
          }
          y += sz * 1.35;
        });
      };
      const gap = h => { y += h; };
      const dash = () => {
        gap(8);
        if (paint) {
          ctx.save(); ctx.strokeStyle = '#000'; ctx.setLineDash([8, 6]); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(P, y); ctx.lineTo(W - P, y); ctx.stroke(); ctx.restore();
        }
        gap(16);
      };

      center(shop.name || 'Kedai Saya', 34, true);
      gap(4);
      center(shop.addr, 20);
      if (shop.phone) center('Tel: ' + shop.phone, 20);
      if (shop.ssm) center('(' + shop.ssm + ')', 18, false, '#333');
      dash();
      center(s.paid ? 'RESIT' : 'INVOIS', 26, true);
      gap(6);
      lr('No: ' + s.no, dmy(s.date) + (s.time ? ' ' + s.time : ''), 21);
      if (s.cust) lr('Pelanggan: ' + s.cust, '', 21);
      if (s.phone) lr('Tel: ' + s.phone, '', 21);
      const veh = [s.plate, s.vehicle].filter(Boolean).join(' · ');
      if (veh) lr('Kenderaan: ' + veh, '', 21);
      dash();
      s.items.forEach(it => {
        lr(it.desc || 'Item', money(Math.round(it.qty * it.price)), 22);
        if (it.qty !== 1) lr(`   ${it.qty} x ${money(it.price)}`, '', 19, false, '#444');
        gap(4);
      });
      dash();
      const sub = subtotal(s);
      if (s.disc) { lr('Jumlah kecil', money(sub), 21); lr('Diskaun', '-' + money(s.disc), 21); }
      lr('JUMLAH', money(s.total), 30, true);
      gap(4);
      lr('Cara bayar', s.pay, 20);
      if (!s.paid) { gap(8); center('*** BELUM DIBAYAR ***', 24, true); }
      else if (s.paidDate && s.paidDate !== s.date) lr('Dibayar pada', dmy(s.paidDate), 20);
      if (s.note) { gap(8); center(s.note, 19, false, '#222'); }
      dash();
      center(shop.footer || 'Terima kasih!', 20);
      return y + P;
    };

    const measure = document.createElement('canvas').getContext('2d');
    const H = Math.ceil(pass(measure, false));
    const c = document.createElement('canvas');
    c.width = W * S; c.height = H * S;
    const ctx = c.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    pass(ctx, true);
    return c;
  }

  // Teks ringkas untuk mesej WhatsApp
  function text(s, shop) {
    const L = [`*${shop.name || 'Kedai Saya'}*`, `${s.paid ? 'Resit' : 'Invois'} ${s.no} — ${dmy(s.date)}`];
    const veh = [s.plate, s.vehicle].filter(Boolean).join(' · ');
    if (veh) L.push('Kenderaan: ' + veh);
    L.push('');
    s.items.forEach(it => L.push(`• ${it.desc || 'Item'}${it.qty !== 1 ? ` (${it.qty} x ${money(it.price)})` : ''} — ${money(Math.round(it.qty * it.price))}`));
    if (s.disc) L.push(`Diskaun: -${money(s.disc)}`);
    L.push('', `*Jumlah: ${money(s.total)}*`, `Bayaran: ${s.pay}${s.paid ? '' : ' (BELUM DIBAYAR)'}`);
    if (s.note) L.push(s.note);
    L.push('', shop.footer || 'Terima kasih!');
    return L.join('\n');
  }

  // Tukar canvas ke fail PDF (satu halaman, lebar 80mm) tanpa library luar
  function pdf(canvas) {
    const bin = atob(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
    const img = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) img[i] = bin.charCodeAt(i);
    const w = canvas.width, h = canvas.height;
    const pw = 226.77, ph = +(pw * h / w).toFixed(2);
    const enc = new TextEncoder();
    const parts = [], offs = [];
    let len = 0;
    const add = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offs[n] = len; add(`${n} 0 obj\n`); body(); add('\nendobj\n'); };
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    add('%PDF-1.4\n');
    obj(1, () => add('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
    obj(4, () => {
      add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
      add(img); add('\nendstream');
    });
    obj(5, () => add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    const xref = len;
    let x = 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    add(x + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  return { draw, text, pdf, money, subtotal };
})();
