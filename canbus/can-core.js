/*
 * Enjin nyahkod OBD-II / CAN (tiada DOM, boleh diuji dengan Node).
 * - Huraikan jawapan ELM327 (CAN 11-bit, CAN 29-bit, protokol lama K-line/J1850)
 * - Himpun semula mesej berbilang-bingkai ISO-TP (ISO 15765-2)
 * - Nyahkod PID mod 01, kod kerosakan (DTC), VIN
 * - Huraikan bingkai CAN mentah (ATMA) dan ekstrak isyarat gaya DBC
 */
(function (root) {
  'use strict';
  // Terjemahan: guna I18N jika ada (dalam app), jika tidak teks Bahasa Malaysia asal
  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null ? v[k] : m));
  const tr = (k, fb, v) => (root.I18N ? root.I18N.t(k, v, fb) : fill(fb, v));

  // ---------- Protokol ELM327 (ATDPN) ----------
  const PROTOCOLS = {
    '1': 'SAE J1850 PWM', '2': 'SAE J1850 VPW', '3': 'ISO 9141-2', '4': 'ISO 14230-4 KWP (5 baud)',
    '5': 'ISO 14230-4 KWP (pantas)', '6': 'ISO 15765-4 CAN 11-bit 500k', '7': 'ISO 15765-4 CAN 29-bit 500k',
    '8': 'ISO 15765-4 CAN 11-bit 250k', '9': 'ISO 15765-4 CAN 29-bit 250k', 'A': 'SAE J1939 CAN 29-bit 250k',
    'B': 'CAN pengguna 1', 'C': 'CAN pengguna 2'
  };
  function protocolInfo(dpn) {
    const p = String(dpn || '').trim().toUpperCase().replace(/^A(?=[0-9A-C]$)/, ''); // "A6" = auto, protokol 6
    const can = /^[6-9A-C]$/.test(p);
    return { id: p, name: protocolName(p), can, ext: can && /^[79A]$/.test(p) };
  }
  function protocolName(p) { return PROTOCOLS[p] ? tr('proto.name.' + p, PROTOCOLS[p]) : tr('proto.unknown', 'Tidak diketahui'); }

  const isHex = s => /^[0-9A-F]+$/i.test(s);
  const hex2 = n => (n & 0xff).toString(16).toUpperCase().padStart(2, '0');

  // Bersihkan output mentah ELM327 kepada baris-baris data
  const NOISE = /^(SEARCHING\.*|BUS INIT:?\s*\.*(OK)?|OK|STOPPED|>)$/i;
  function cleanLines(raw) {
    return String(raw).replace(/>/g, '').split(/[\r\n]+/).map(l => l.trim()).filter(l => l && !NOISE.test(l));
  }

  const ERRORS = ['NO DATA', 'CAN ERROR', 'BUS ERROR', 'BUS BUSY', 'UNABLE TO CONNECT', 'STOPPED', 'BUFFER FULL',
    'DATA ERROR', 'FB ERROR', 'LV RESET', 'ACT ALERT', '?', 'ERR'];
  function findError(lines) {
    for (const l of lines) for (const e of ERRORS) if (l.toUpperCase().startsWith(e)) return l;
    return null;
  }

  function tokens(line) {
    const t = line.trim().split(/\s+/);
    if (t.length === 1 && t[0].length > 3 && t[0].length % 2 === 1) {
      // Ruang dimatikan (ATS0) + header 11-bit: "7E8064100BE3FA813"
      const s = t[0]; const out = [s.slice(0, 3)];
      for (let i = 3; i < s.length; i += 2) out.push(s.slice(i, i + 2));
      return out;
    }
    if (t.length === 1 && t[0].length > 2) { const s = t[0]; const out = []; for (let i = 0; i < s.length; i += 2) out.push(s.slice(i, i + 2)); return out; }
    return t;
  }

  /*
   * Tukar baris jawapan (headers ON, ATH1) kepada mesej per ECU.
   * Pulangkan [{ ecu: '7E8', bytes: [..payload tanpa PCI..] }]
   */
  function parseResponse(raw, proto) {
    const info = typeof proto === 'object' ? proto : protocolInfo(proto || '6');
    const lines = cleanLines(raw);
    const err = findError(lines);
    if (err) return { error: err, messages: [] };
    const frames = [];
    for (const line of lines) {
      const t = tokens(line);
      if (!t.every(isHex)) continue;
      if (info.can) {
        let ecu, data;
        if (info.ext || (t[0].length === 2 && t.length >= 5 && /^18$/i.test(t[0]))) {
          ecu = t.slice(0, 4).join('').toUpperCase(); data = t.slice(4);
        } else { ecu = t[0].toUpperCase(); data = t.slice(1); }
        frames.push({ ecu, data: data.map(h => parseInt(h, 16)) });
      } else {
        // Lama: 3 bait header (prioriti, sasaran, sumber) + data + checksum
        if (t.length < 5) continue;
        frames.push({ ecu: t[2].toUpperCase(), data: t.slice(3, -1).map(h => parseInt(h, 16)), legacy: true });
      }
    }
    return { error: null, messages: info.can ? assembleIsoTp(frames) : assembleLegacy(frames) };
  }

  function assembleIsoTp(frames) {
    const out = []; const pending = {};
    for (const f of frames) {
      const pci = f.data[0] >> 4;
      if (pci === 0) {
        const len = f.data[0] & 0x0f;
        out.push({ ecu: f.ecu, bytes: f.data.slice(1, 1 + len) });
      } else if (pci === 1) {
        const len = ((f.data[0] & 0x0f) << 8) | f.data[1];
        pending[f.ecu] = { ecu: f.ecu, len, bytes: f.data.slice(2), seq: 1 };
      } else if (pci === 2 && pending[f.ecu]) {
        const p = pending[f.ecu];
        p.bytes.push(...f.data.slice(1));
        if (p.bytes.length >= p.len) { out.push({ ecu: p.ecu, bytes: p.bytes.slice(0, p.len) }); delete pending[f.ecu]; }
      }
    }
    for (const k in pending) out.push({ ecu: k, bytes: pending[k].bytes, partial: true });
    return out;
  }

  // Protokol lama: gabung baris dari ECU sama (mod 03 ulang "43", mod 09 ulang "49 PID SEQ")
  function assembleLegacy(frames) {
    const by = {};
    for (const f of frames) {
      if (!by[f.ecu]) { by[f.ecu] = { ecu: f.ecu, bytes: f.data.slice() }; continue; }
      const b = by[f.ecu].bytes; const d = f.data;
      if (d[0] === 0x43 || d[0] === 0x47 || d[0] === 0x4A) b.push(...d.slice(1));
      else if (d[0] === 0x49) b.push(...d.slice(3));
      else b.push(...d);
    }
    return Object.values(by);
  }

  // ---------- PID Mod 01 ----------
  const A = d => d[0], B = d => d[1], AB = d => d[0] * 256 + d[1];
  const temp = d => d[0] - 40, pct = d => d[0] * 100 / 255, trim = d => d[0] / 1.28 - 100;
  const PIDS = {
    0x04: { name: 'Beban enjin', unit: '%', f: pct },
    0x05: { name: 'Suhu air penyejuk', unit: '°C', f: temp },
    0x06: { name: 'Fuel trim jangka pendek B1', unit: '%', f: trim },
    0x07: { name: 'Fuel trim jangka panjang B1', unit: '%', f: trim },
    0x08: { name: 'Fuel trim jangka pendek B2', unit: '%', f: trim },
    0x09: { name: 'Fuel trim jangka panjang B2', unit: '%', f: trim },
    0x0A: { name: 'Tekanan minyak', unit: 'kPa', f: d => A(d) * 3 },
    0x0B: { name: 'Tekanan intake (MAP)', unit: 'kPa', f: A },
    0x0C: { name: 'RPM enjin', unit: 'rpm', f: d => AB(d) / 4 },
    0x0D: { name: 'Kelajuan', unit: 'km/j', f: A },
    0x0E: { name: 'Timing advance', unit: '°', f: d => A(d) / 2 - 64 },
    0x0F: { name: 'Suhu udara intake', unit: '°C', f: temp },
    0x10: { name: 'Aliran udara MAF', unit: 'g/s', f: d => AB(d) / 100 },
    0x11: { name: 'Kedudukan throttle', unit: '%', f: pct },
    0x1F: { name: 'Masa sejak enjin hidup', unit: 's', f: AB },
    0x21: { name: 'Jarak dengan lampu MIL', unit: 'km', f: AB },
    0x23: { name: 'Tekanan rel minyak', unit: 'kPa', f: d => AB(d) * 10 },
    0x2C: { name: 'EGR diperintah', unit: '%', f: pct },
    0x2F: { name: 'Paras minyak', unit: '%', f: pct },
    0x31: { name: 'Jarak sejak DTC dipadam', unit: 'km', f: AB },
    0x33: { name: 'Tekanan barometrik', unit: 'kPa', f: A },
    0x3C: { name: 'Suhu catalyst B1S1', unit: '°C', f: d => AB(d) / 10 - 40 },
    0x42: { name: 'Voltan modul kawalan', unit: 'V', f: d => AB(d) / 1000 },
    0x43: { name: 'Beban mutlak', unit: '%', f: d => AB(d) * 100 / 255 },
    0x44: { name: 'Nisbah udara/minyak (lambda)', unit: 'λ', f: d => AB(d) * 2 / 65536 },
    0x45: { name: 'Throttle relatif', unit: '%', f: pct },
    0x46: { name: 'Suhu udara luar', unit: '°C', f: temp },
    0x49: { name: 'Pedal minyak D', unit: '%', f: pct },
    0x4C: { name: 'Throttle actuator', unit: '%', f: pct },
    0x51: { name: 'Jenis minyak', unit: '', f: d => FUEL_TYPES[A(d)] ? tr('fuel.' + A(d), FUEL_TYPES[A(d)]) : tr('fuel.other', 'Jenis {n}', { n: A(d) }) },
    0x5A: { name: 'Pedal minyak relatif', unit: '%', f: pct },
    0x5C: { name: 'Suhu minyak enjin', unit: '°C', f: temp },
    0x5E: { name: 'Kadar guna minyak', unit: 'L/j', f: d => AB(d) / 20 },
    0x01: { name: 'Status monitor (MIL)', unit: '', f: d => ((A(d) & 0x80) ? tr('mil.on', 'MIL HIDUP') : tr('mil.off', 'MIL padam')) + ', ' + (A(d) & 0x7f) + ' DTC' },
    0x14: { name: 'Sensor O2 B1S1', unit: 'V', f: d => A(d) / 200 },
    0x15: { name: 'Sensor O2 B1S2', unit: 'V', f: d => A(d) / 200 },
    0x1C: { name: 'Standard OBD', unit: '', f: d => OBD_STD[A(d)] ? tr('obdstd.' + A(d), OBD_STD[A(d)]) : tr('obdstd.other', 'Kod {n}', { n: A(d) }) },
    0x30: { name: 'Warm-up sejak DTC dipadam', unit: '', f: A },
    0x4D: { name: 'Masa enjin dengan MIL', unit: 'min', f: AB },
    0x4E: { name: 'Masa sejak DTC dipadam', unit: 'min', f: AB },
    0xA6: { name: 'Odometer', unit: 'km', f: d => (((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]) / 10 }
  };
  const FUEL_TYPES = { 1: 'Petrol', 2: 'Metanol', 3: 'Etanol', 4: 'Diesel', 5: 'LPG', 6: 'CNG', 8: 'Elektrik', 17: 'Hibrid petrol', 19: 'Hibrid diesel', 21: 'Hibrid elektrik' };
  const OBD_STD = { 1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD + OBD-II', 6: 'EOBD (Eropah)', 7: 'EOBD + OBD-II', 9: 'EOBD + OBD + OBD-II', 11: 'JOBD (Jepun)', 13: 'JOBD + EOBD + OBD-II' };

  // Jawapan mod 41: [0x41, pid, ...data]
  function decodePid(pid, bytes) {
    const def = PIDS[pid];
    if (!def || !bytes) return null;
    const v = def.f(bytes);
    return { pid, name: pidName(pid), unit: def.unit, value: typeof v === 'number' ? Math.round(v * 100) / 100 : v };
  }
  function pidName(pid) { const d = PIDS[pid]; return d ? tr('pid.' + hex2(pid), d.name) : 'PID ' + hex2(pid); }

  // PID 00/20/40/.. : bitmask PID yang disokong
  function decodeSupported(base, bytes) {
    const list = [];
    for (let i = 0; i < 32; i++) if (bytes[i >> 3] & (0x80 >> (i & 7))) list.push(base + i + 1);
    return list;
  }

  // ---------- DTC ----------
  function dtcFromBytes(a, b) {
    return 'PCBU'[a >> 6] + ((a >> 4) & 3) + (a & 0x0f).toString(16).toUpperCase() + hex2(b);
  }
  // payload bermula dengan 0x43/0x47/0x4A. CAN: bait kedua = bilangan.
  function decodeDtcs(bytes, can) {
    let d = bytes.slice(1);
    if (can && d.length % 2 === 1) d = d.slice(1);
    const out = [];
    for (let i = 0; i + 1 < d.length; i += 2) {
      if (d[i] === 0 && d[i + 1] === 0) continue;
      const c = dtcFromBytes(d[i], d[i + 1]);
      if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  const DTC_TEXT = {
    P0010: 'Litar aktuator camshaft A (Bank 1)', P0011: 'Timing camshaft A terlalu awal (Bank 1)',
    P0016: 'Korelasi crankshaft/camshaft (Bank 1 Sensor A)', P0068: 'Korelasi MAP/MAF dengan throttle',
    P0100: 'Litar sensor MAF', P0101: 'Julat/prestasi sensor MAF', P0102: 'Input sensor MAF rendah', P0103: 'Input sensor MAF tinggi',
    P0105: 'Litar sensor MAP', P0106: 'Julat/prestasi sensor MAP', P0107: 'Input sensor MAP rendah', P0108: 'Input sensor MAP tinggi',
    P0110: 'Litar sensor suhu udara intake', P0112: 'Sensor suhu udara intake rendah', P0113: 'Sensor suhu udara intake tinggi',
    P0115: 'Litar sensor suhu penyejuk', P0116: 'Julat sensor suhu penyejuk', P0117: 'Sensor suhu penyejuk rendah', P0118: 'Sensor suhu penyejuk tinggi',
    P0120: 'Litar sensor throttle (TPS) A', P0121: 'Julat sensor throttle A', P0122: 'Sensor throttle A rendah', P0123: 'Sensor throttle A tinggi',
    P0125: 'Suhu penyejuk tidak cukup untuk closed loop', P0128: 'Termostat (suhu penyejuk bawah suhu termostat)',
    P0130: 'Litar sensor O2 B1S1', P0131: 'Sensor O2 B1S1 voltan rendah', P0132: 'Sensor O2 B1S1 voltan tinggi', P0133: 'Sensor O2 B1S1 lambat',
    P0134: 'Sensor O2 B1S1 tiada aktiviti', P0135: 'Pemanas sensor O2 B1S1', P0136: 'Litar sensor O2 B1S2', P0137: 'Sensor O2 B1S2 voltan rendah',
    P0138: 'Sensor O2 B1S2 voltan tinggi', P0141: 'Pemanas sensor O2 B1S2',
    P0171: 'Campuran terlalu cair (lean) Bank 1', P0172: 'Campuran terlalu pekat (rich) Bank 1',
    P0174: 'Campuran terlalu cair (lean) Bank 2', P0175: 'Campuran terlalu pekat (rich) Bank 2',
    P0201: 'Litar injektor silinder 1', P0202: 'Litar injektor silinder 2', P0203: 'Litar injektor silinder 3', P0204: 'Litar injektor silinder 4',
    P0217: 'Enjin terlalu panas', P0219: 'RPM enjin melebihi had', P0230: 'Litar relay pam minyak',
    P0234: 'Turbo/supercharger overboost', P0299: 'Turbo/supercharger underboost',
    P0300: 'Misfire rawak/berbilang silinder', P0301: 'Misfire silinder 1', P0302: 'Misfire silinder 2', P0303: 'Misfire silinder 3',
    P0304: 'Misfire silinder 4', P0305: 'Misfire silinder 5', P0306: 'Misfire silinder 6',
    P0325: 'Litar sensor knock 1', P0327: 'Sensor knock 1 rendah', P0335: 'Litar sensor kedudukan crankshaft A', P0336: 'Julat sensor crankshaft A',
    P0340: 'Litar sensor kedudukan camshaft A', P0341: 'Julat sensor camshaft A',
    P0351: 'Litar coil pencucuh A', P0352: 'Litar coil pencucuh B', P0353: 'Litar coil pencucuh C', P0354: 'Litar coil pencucuh D',
    P0400: 'Aliran EGR', P0401: 'Aliran EGR tidak mencukupi', P0402: 'Aliran EGR berlebihan',
    P0420: 'Kecekapan catalyst bawah had (Bank 1)', P0430: 'Kecekapan catalyst bawah had (Bank 2)',
    P0440: 'Sistem EVAP', P0441: 'Aliran purge EVAP salah', P0442: 'Kebocoran kecil EVAP', P0443: 'Litar injap purge EVAP',
    P0446: 'Kawalan vent EVAP', P0455: 'Kebocoran besar EVAP', P0456: 'Kebocoran sangat kecil EVAP',
    P0480: 'Litar kawalan kipas penyejuk 1', P0500: 'Sensor kelajuan kenderaan (VSS)', P0505: 'Sistem kawalan idle (IAC)',
    P0506: 'RPM idle lebih rendah dari jangkaan', P0507: 'RPM idle lebih tinggi dari jangkaan',
    P0562: 'Voltan sistem rendah', P0563: 'Voltan sistem tinggi', P0600: 'Pautan komunikasi bersiri ECU',
    P0601: 'Ralat checksum memori ECU', P0603: 'Ralat memori KAM ECU', P0606: 'Prosesor ECU', P0700: 'Sistem kawalan transmisi (rujuk TCM)',
    P0705: 'Litar sensor julat transmisi (PRNDL)', P0715: 'Litar sensor kelajuan turbin input',
    P0720: 'Litar sensor kelajuan output', P0740: 'Litar klac torque converter', P0741: 'Klac torque converter tersekat OFF',
    P0750: 'Solenoid syif A', P0755: 'Solenoid syif B',
    P2096: 'Fuel trim selepas catalyst terlalu cair B1', P2097: 'Fuel trim selepas catalyst terlalu pekat B1',
    P2135: 'Korelasi voltan sensor throttle/pedal A/B', P2138: 'Korelasi voltan sensor pedal D/E',
    U0001: 'Bas komunikasi CAN kelajuan tinggi', U0073: 'Bas komunikasi modul kawalan OFF',
    U0100: 'Hilang komunikasi dengan ECM/PCM', U0101: 'Hilang komunikasi dengan TCM', U0121: 'Hilang komunikasi dengan modul ABS',
    U0140: 'Hilang komunikasi dengan BCM', U0155: 'Hilang komunikasi dengan panel meter (IPC)',
    C0035: 'Litar sensor kelajuan roda depan kiri', C0040: 'Litar sensor kelajuan roda depan kanan',
    C0045: 'Litar sensor kelajuan roda belakang kiri', C0050: 'Litar sensor kelajuan roda belakang kanan',
    B0001: 'Kawalan beg udara pemandu (peringkat 1)', B1000: 'Kerosakan dalaman ECU (pengeluar)'
  };
  const DTC_SYSTEM = { P: 'Powertrain (enjin/transmisi)', C: 'Chassis (ABS/stereng)', B: 'Body (beg udara/lampu/aircond)', U: 'Rangkaian (komunikasi CAN)' };
  function describeDtc(code) {
    if (DTC_TEXT[code]) return tr('dtc.' + code, DTC_TEXT[code]);
    const generic = code[1] === '0' || code[1] === '2' || (code[0] === 'P' && code[1] === '3' && code[2] >= 'A');
    return (generic ? tr('dtc.generic', 'Kod generik') : tr('dtc.maker', 'Kod khas pengeluar')) + ' — ' + tr('dtc.sys.' + code[0], DTC_SYSTEM[code[0]]);
  }

  // ---------- VIN (mod 09 PID 02) ----------
  function decodeVin(bytes) {
    // [0x49, 0x02, (bilangan), ...ASCII]
    let d = bytes.slice(2);
    const txt = b => b.filter(c => c >= 0x20 && c < 0x7f).map(c => String.fromCharCode(c)).join('');
    let s = txt(d);
    if (s.length > 17) s = s.slice(-17);
    return s.replace(/[^A-HJ-NPR-Z0-9]/gi, '').length >= 11 ? s : txt(d.slice(1));
  }

  // ---------- Bingkai CAN mentah (ATMA, ATH1) ----------
  function parseCanFrame(line, now) {
    const t = tokens(String(line).trim());
    if (t.length < 1 || !t.every(isHex)) return null;
    let id, data, ext = false;
    if (t[0].length === 3) { id = t[0]; data = t.slice(1); }
    else if (t[0].length === 8) { id = t[0]; data = t.slice(1); ext = true; }
    else if (t.length >= 4 && t.slice(0, 4).every(x => x.length === 2)) { id = t.slice(0, 4).join(''); data = t.slice(4); ext = true; }
    else return null;
    if (data.length > 8 || data.some(x => x.length !== 2)) return null;
    return { id: id.toUpperCase(), ext, data: data.map(h => parseInt(h, 16)), t: now || 0 };
  }

  /*
   * Ekstrak isyarat ala DBC.
   * sig = { start, length, order: 'intel'|'motorola', signed, scale, offset }
   * Intel: start = LSB; Motorola: start = MSB (penomboran bit DBC: bait*8 + bit, bit 7 = MSB bait)
   */
  function extractSignal(data, sig) {
    const len = sig.length | 0;
    if (len < 1 || len > 32) return null;
    let raw = 0;
    if ((sig.order || 'intel') === 'intel') {
      for (let i = 0; i < len; i++) {
        const bit = sig.start + i, byte = bit >> 3;
        if (byte >= data.length) return null;
        if ((data[byte] >> (bit & 7)) & 1) raw += Math.pow(2, i);
      }
    } else {
      let bit = sig.start;
      for (let i = 0; i < len; i++) {
        const byte = bit >> 3;
        if (byte >= data.length) return null;
        raw = raw * 2 + ((data[byte] >> (bit & 7)) & 1);
        if ((bit & 7) === 0) bit += 15; else bit -= 1;
      }
    }
    if (sig.signed && raw >= Math.pow(2, len - 1)) raw -= Math.pow(2, len);
    const v = raw * (sig.scale == null ? 1 : sig.scale) + (sig.offset || 0);
    return Math.round(v * 1e6) / 1e6;
  }

  const api = {
    PROTOCOLS, PIDS, DTC_TEXT, protocolInfo, protocolName, pidName, cleanLines, findError, parseResponse, assembleIsoTp, decodePid, decodeSupported,
    dtcFromBytes, decodeDtcs, describeDtc, decodeVin, parseCanFrame, extractSignal, hex2
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ObdCore = api;
})(typeof self !== 'undefined' ? self : this);
