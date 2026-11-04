/*
 * Kenal ID CAN: label standard (OBD/UDS, J1939), tekaan dari corak data,
 * pembelajaran dengan korelasi PID dan dengan tindakan (tekan brek, buka pintu…).
 */
(function (root) {
  'use strict';
  const Core = root.ObdCore || (typeof require !== 'undefined' ? require('./can-core.js') : null);

  // ---------- ID standard ----------
  const ECU_NAMES = ['enjin (ECM)', 'transmisi (TCM)', 'ECU #3 (biasanya ABS)', 'ECU #4', 'ECU #5', 'ECU #6', 'ECU #7', 'ECU #8'];

  // PGN J1939 biasa (lori, bas, jentera) — kedudukan isyarat ikut SAE J1939-71
  const J1939 = {
    61444: { name: 'EEC1 · Kawalan enjin elektronik 1', signals: [
      { name: 'Tork enjin sebenar', start: 16, length: 8, scale: 1, offset: -125, unit: '%' },
      { name: 'RPM enjin', start: 24, length: 16, scale: 0.125, offset: 0, unit: 'rpm' }] },
    61443: { name: 'EEC2 · Kawalan enjin elektronik 2', signals: [
      { name: 'Pedal minyak 1', start: 8, length: 8, scale: 0.4, offset: 0, unit: '%' },
      { name: 'Beban enjin', start: 16, length: 8, scale: 1, offset: 0, unit: '%' }] },
    65262: { name: 'ET1 · Suhu enjin', signals: [
      { name: 'Suhu air penyejuk', start: 0, length: 8, scale: 1, offset: -40, unit: '°C' },
      { name: 'Suhu minyak bahan api', start: 8, length: 8, scale: 1, offset: -40, unit: '°C' },
      { name: 'Suhu minyak enjin', start: 16, length: 16, scale: 0.03125, offset: -273, unit: '°C' }] },
    65263: { name: 'EFL/P1 · Paras/tekanan cecair enjin', signals: [
      { name: 'Tekanan minyak enjin', start: 24, length: 8, scale: 4, offset: 0, unit: 'kPa' }] },
    65265: { name: 'CCVS · Kelajuan kenderaan / cruise', signals: [
      { name: 'Kelajuan roda', start: 8, length: 16, scale: 1 / 256, offset: 0, unit: 'km/j' }] },
    65266: { name: 'LFE · Penggunaan bahan api', signals: [
      { name: 'Kadar bahan api', start: 0, length: 16, scale: 0.05, offset: 0, unit: 'L/j' }] },
    65270: { name: 'IC1 · Keadaan intake/ekzos', signals: [
      { name: 'Tekanan boost', start: 8, length: 8, scale: 2, offset: 0, unit: 'kPa' },
      { name: 'Suhu manifold intake', start: 16, length: 8, scale: 1, offset: -40, unit: '°C' }] },
    65271: { name: 'VEP1 · Voltan kenderaan', signals: [
      { name: 'Voltan bateri', start: 32, length: 16, scale: 0.05, offset: 0, unit: 'V' }] },
    65276: { name: 'DD · Paparan pemandu', signals: [
      { name: 'Paras bahan api', start: 8, length: 8, scale: 0.4, offset: 0, unit: '%' }] },
    65253: { name: 'HOURS · Jam enjin', signals: [
      { name: 'Jumlah jam enjin', start: 0, length: 32, scale: 0.05, offset: 0, unit: 'j' }] },
    65226: { name: 'DM1 · Kod kerosakan aktif (J1939)', signals: [] },
    59904: { name: 'Permintaan PGN (J1939)', signals: [] }
  };

  function j1939Pgn(idHex) {
    const id = parseInt(idHex, 16);
    const pf = (id >> 16) & 0xff, ps = (id >> 8) & 0xff, dp = (id >> 24) & 0x3;
    const pgn = (dp << 16) | (pf << 8) | (pf < 240 ? 0 : ps);
    return { pgn, src: id & 0xff, prio: (id >> 26) & 7 };
  }

  function standardLabel(idHex, isExt) {
    const id = parseInt(idHex, 16);
    if (!isExt && idHex.length <= 3) {
      if (id === 0x7DF) return { name: 'Soalan diagnostik OBD ke semua ECU', source: 'std' };
      if (id >= 0x7E0 && id <= 0x7E7) return { name: 'Soalan diagnostik ke ' + ECU_NAMES[id - 0x7E0], source: 'std' };
      if (id >= 0x7E8 && id <= 0x7EF) return { name: 'Jawapan diagnostik dari ' + ECU_NAMES[id - 0x7E8], source: 'std' };
      return null;
    }
    if ((id & 0x1FFF0000) === 0x18DB0000 && (id & 0xff) === 0xF1) return { name: 'Soalan diagnostik OBD 29-bit ke semua ECU', source: 'std' };
    if ((id & 0x1FFF0000) === 0x18DA0000) {
      const ta = (id >> 8) & 0xff, sa = id & 0xff;
      if (sa === 0xF1) return { name: 'Soalan diagnostik ke ECU 0x' + Core.hex2(ta), source: 'std' };
      if (ta === 0xF1) return { name: 'Jawapan diagnostik dari ECU 0x' + Core.hex2(sa), source: 'std' };
    }
    const p = j1939Pgn(idHex);
    const d = J1939[p.pgn];
    if (d) return {
      name: d.name, source: 'std', detail: 'J1939 PGN ' + p.pgn + ' dari alamat ' + p.src,
      signals: d.signals.map(s => Object.assign({ id: idHex.toUpperCase(), order: 'intel', signed: false, source: 'std' }, s))
    };
    return null;
  }

  // ---------- Sejarah bingkai per ID ----------
  class History {
    constructor(max) { this.max = max || 300; this.ids = new Map(); }
    add(f) {
      let e = this.ids.get(f.id);
      if (!e) { e = { id: f.id, ext: f.ext, frames: [], count: 0, first: f.t }; this.ids.set(f.id, e); }
      e.count++; e.last = f.t; e.frames.push(f);
      if (e.frames.length > this.max) e.frames.shift();
      return e;
    }
    clear() { this.ids.clear(); }
  }

  // ---------- Tekaan dari corak ----------
  function byteSeries(frames, i) { return frames.map(f => f.data[i]).filter(v => v !== undefined); }
  function isCounter(s, mask) {
    if (s.length < 8) return false;
    let ok = 0;
    for (let k = 1; k < s.length; k++) {
      const d = ((s[k] & mask) - (s[k - 1] & mask) + mask + 1) & mask;
      if (d === 1 || d === 2) ok++;
    }
    return ok / (s.length - 1) > 0.9;
  }

  // Peranan setiap bait: tetap, counter, checksum, analog, bit
  function byteRoles(frames) {
    if (!frames.length) return [];
    const n = Math.max(...frames.map(f => f.data.length));
    const roles = [];
    for (let i = 0; i < n; i++) {
      const s = byteSeries(frames, i);
      const distinct = new Set(s).size;
      if (distinct <= 1) { roles.push('tetap'); continue; }
      if (isCounter(s, 0xff) || isCounter(s, 0x0f) || isCounter(s.map(v => v >> 4), 0x0f)) { roles.push('counter'); continue; }
      let changes = 0, jump = 0;
      for (let k = 1; k < s.length; k++) if (s[k] !== s[k - 1]) { changes++; jump += Math.abs(s[k] - s[k - 1]); }
      const rate = changes / Math.max(1, s.length - 1);
      const avgJump = changes ? jump / changes : 0;
      // Berapa bit yang pernah bertukar
      let toggled = 0; for (let b = 0; b < 8; b++) { const first = (s[0] >> b) & 1; if (s.some(v => ((v >> b) & 1) !== first)) toggled++; }
      if (i === n - 1 && rate > 0.8 && avgJump > 40 && distinct > s.length * 0.3) { roles.push('checksum'); continue; }
      if (toggled <= 2 && distinct <= 4) { roles.push('bit'); continue; }
      roles.push(avgJump > 60 && rate > 0.8 ? 'rawak' : 'analog');
    }
    return roles;
  }

  function guess(entry) {
    const fr = entry.frames.slice(-300);
    if (fr.length < 10) return { name: 'Mengumpul data…', conf: 0, source: 'unk' };
    const roles = byteRoles(fr);
    const len = fr[fr.length - 1].data.length;
    const hz = entry.hz || 0;
    const detail = [];
    const counters = roles.filter(r => r === 'counter').length, cks = roles.includes('checksum');
    if (counters) detail.push('counter'); if (cks) detail.push('checksum');

    // 4 nilai 16-bit hampir sama => kelajuan roda
    if (len === 8) {
      for (const be of [true, false]) {
        const last = fr.slice(-20);
        const ok = last.every(f => {
          const v = [0, 2, 4, 6].map(i => be ? f.data[i] * 256 + f.data[i + 1] : f.data[i + 1] * 256 + f.data[i]);
          const mx = Math.max(...v), mn = Math.min(...v);
          return mx > 0 && (mx - mn) / mx < 0.1;
        });
        const varies = new Set(fr.map(f => f.data[be ? 1 : 0] + 256 * f.data[be ? 0 : 1])).size > 3;
        if (ok && varies) return { name: 'Mungkin kelajuan 4 roda (ABS)', conf: 0.7, source: 'guess', detail: '4 nilai 16-bit ' + (be ? 'big' : 'little') + ' endian hampir sama', roles };
      }
    }
    if (roles.every(r => r === 'tetap')) return { name: 'Data tetap (status / konfigurasi)', conf: 0.5, source: 'guess', detail: 'tiada bait berubah', roles };
    const analog = roles.filter(r => r === 'analog').length, bits = roles.filter(r => r === 'bit').length;
    if (analog === 0 && bits > 0) return { name: 'Mungkin suis / status on-off', conf: 0.5, source: 'guess', detail: bits + ' bait bit' + (detail.length ? ', ' + detail.join(', ') : ''), roles };
    // Nilai bertanda di dua bait pertama (sudut stereng biasanya begini)
    const signedLike = fr.slice(-40).some(f => f.data[1] === 0xFF || f.data[1] >= 0xF0) && fr.slice(-40).some(f => f.data[1] <= 0x0F);
    if (signedLike && roles[0] === 'analog') return { name: 'Mungkin sudut stereng / nilai bertanda', conf: 0.45, source: 'guess', detail: 'nilai melintasi sifar' + (detail.length ? ', ' + detail.join(', ') : ''), roles };
    const name = analog ? `${analog} bait isyarat analog (sensor)` : 'Isyarat berubah';
    return { name, conf: 0.35, source: 'guess', detail: (hz ? Math.round(hz) + ' Hz' : '') + (detail.length ? ', ' + detail.join(', ') : ''), roles };
  }

  // ---------- Calon isyarat ----------
  function candidatesFor(len) {
    const out = [];
    for (let i = 0; i < len; i++) out.push({ label: 'bait ' + i, start: i * 8, length: 8, order: 'intel', bytes: [i] });
    for (let i = 0; i + 1 < len; i++) {
      out.push({ label: 'bait ' + i + '–' + (i + 1) + ' LE', start: i * 8, length: 16, order: 'intel', bytes: [i, i + 1] });
      out.push({ label: 'bait ' + i + '–' + (i + 1) + ' BE', start: i * 8 + 7, length: 16, order: 'motorola', bytes: [i, i + 1] });
    }
    return out;
  }

  function pearson(x, y) {
    const n = x.length; if (n < 4) return 0;
    let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n; let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; cov += a * b; vx += a * a; vy += b * b; }
    if (!vx || !vy) return 0;
    return cov / Math.sqrt(vx * vy);
  }
  function fit(x, y) {
    const n = x.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
    const d = n * sxx - sx * sx; if (!d) return { scale: 1, offset: 0 };
    const a = (n * sxy - sx * sy) / d; return { scale: a, offset: (sy - a * sx) / n };
  }
  const nice = v => { if (!v) return 0; const p = Math.pow(10, 3 - Math.floor(Math.log10(Math.abs(v)))); return Math.round(v * p) / p; };

  /*
   * Banding nilai rujukan (PID standard) dengan setiap bait/pasangan bait semua ID.
   * ref = [{t, v}], hist = History. Pulangkan calon terbaik dengan skala & ofset dipadankan.
   */
  function correlate(ref, hist, opts) {
    opts = Object.assign({ before: 1500, after: 300, top: 5 }, opts);
    const vals = ref.map(r => r.v);
    if (ref.length < 6 || Math.max(...vals) - Math.min(...vals) < 1e-9) return { error: 'Nilai rujukan tidak berubah. Ubah keadaan (contoh tekan pedal) semasa merakam.', results: [] };
    const results = [];
    for (const e of hist.ids.values()) {
      // padankan setiap titik rujukan dengan bingkai terdekat ID ini
      const pairs = [];
      let k = 0;
      for (const r of ref) {
        while (k + 1 < e.frames.length && e.frames[k + 1].t <= r.t) k++;
        let f = e.frames[k];
        const nx = e.frames[k + 1];
        if (nx && (!f || f.t > r.t || Math.abs(nx.t - r.t) < Math.abs(f.t - r.t))) f = nx; // bingkai paling hampir masa
        if (f && f.t <= r.t + opts.after && f.t >= r.t - opts.before) pairs.push({ v: r.v, d: f.data });
      }
      if (pairs.length < Math.max(6, ref.length * 0.6)) continue;
      const len = Math.min(...pairs.map(p => p.d.length));
      for (const c of candidatesFor(len)) {
        const raw = pairs.map(p => Core.extractSignal(p.d, c));
        const y = pairs.map(p => p.v);
        if (new Set(raw).size < 3) continue;
        const r = pearson(raw, y);
        if (!isFinite(r) || Math.abs(r) < 0.6) continue;
        const f = fit(raw, y);
        results.push({ id: e.id, label: c.label, start: c.start, length: c.length, order: c.order, bytes: c.bytes, r, score: Math.abs(r), scale: nice(f.scale), offset: nice(f.offset), n: pairs.length });
      }
    }
    results.sort((a, b) => b.score - a.score || a.length - b.length);
    // buang calon bertindih dari ID yang sama (simpan yang terbaik)
    const out = [];
    for (const r of results) {
      if (out.some(o => o.id === r.id && o.bytes.some(b => r.bytes.includes(b)))) continue;
      out.push(r);
      if (out.length >= opts.top) break;
    }
    return { error: null, results: out };
  }

  /*
   * Cari bit yang ikut tindakan pengguna (tekan brek, buka pintu…).
   * samples = [{ on: bool, f: frame }]
   */
  function actionBits(samples, top) {
    const byId = new Map();
    for (const s of samples) {
      let e = byId.get(s.f.id); if (!e) { e = []; byId.set(s.f.id, e); } e.push(s);
    }
    const out = [];
    for (const [id, list] of byId) {
      const on = list.filter(s => s.on), off = list.filter(s => !s.on);
      if (on.length < 3 || off.length < 3) continue;
      const len = Math.min(...list.map(s => s.f.data.length));
      for (let byte = 0; byte < len; byte++) for (let bit = 0; bit < 8; bit++) {
        const pOn = on.filter(s => (s.f.data[byte] >> bit) & 1).length / on.length;
        const pOff = off.filter(s => (s.f.data[byte] >> bit) & 1).length / off.length;
        const score = Math.abs(pOn - pOff);
        if (score >= 0.7) out.push({ id, byte, bit, start: byte * 8 + bit, score, activeHigh: pOn > pOff });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, top || 8);
  }

  const api = { J1939, j1939Pgn, standardLabel, History, byteRoles, guess, correlate, actionBits, pearson, candidatesFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analyze = api;
})(typeof self !== 'undefined' ? self : this);
