/*
 * Baca & tulis fail DBC (pangkalan data isyarat CAN).
 * Sokong BO_, SG_ (Intel @1 / Motorola @0, bertanda +/-), CM_ dan VAL_.
 * Isyarat multiplex (m0, m1…) diabaikan kerana tidak boleh dinyahkod tanpa pemilih.
 */
(function (root) {
  'use strict';

  function idToHex(dec) {
    const ext = dec > 0x7FF || (dec & 0x80000000) !== 0;
    const id = (dec & 0x1FFFFFFF) >>> 0;
    return ext ? id.toString(16).toUpperCase().padStart(8, '0') : id.toString(16).toUpperCase().padStart(3, '0');
  }
  function hexToDbcId(hex) {
    const n = parseInt(hex, 16);
    return hex.length > 3 ? ((n | 0x80000000) >>> 0) : n;
  }

  const SG = /^\s*SG_\s+(\w+)\s*(M|m\d+M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)\s*\[\s*([^|]*?)\s*\|\s*([^\]]*?)\s*\]\s*"([^"]*)"/;

  function parseDbc(text, source) {
    const messages = {};
    let cur = null, skipped = 0;
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/.exec(line))) {
        const id = idToHex(Number(m[1]));
        cur = messages[id] = { id, name: m[2], dlc: +m[3], sender: m[4], signals: [], comment: '' };
        continue;
      }
      if ((m = SG.exec(line)) && cur) {
        if (m[2] && m[2] !== 'M') { skipped++; continue; }
        cur.signals.push({
          name: m[1], id: cur.id, start: +m[3], length: +m[4], order: m[5] === '1' ? 'intel' : 'motorola',
          signed: m[6] === '-', scale: parseFloat(m[7]), offset: parseFloat(m[8]),
          min: parseFloat(m[9]) || 0, max: parseFloat(m[10]) || 0, unit: m[11], source: source || 'dbc'
        });
        continue;
      }
      if (/^\S/.test(line) && !/^\s*SG_/.test(line)) cur = null;
      // CM_ boleh berbilang baris
      if (/^CM_\s+(BO_|SG_)/.test(line)) {
        let full = line;
        while (!/";\s*$/.test(full) && i + 1 < lines.length) full += '\n' + lines[++i];
        if ((m = /^CM_\s+BO_\s+(\d+)\s+"([\s\S]*)";/.exec(full))) {
          const msg = messages[idToHex(Number(m[1]))]; if (msg) msg.comment = m[2];
        } else if ((m = /^CM_\s+SG_\s+(\d+)\s+(\w+)\s+"([\s\S]*)";/.exec(full))) {
          const msg = messages[idToHex(Number(m[1]))];
          const sg = msg && msg.signals.find(s => s.name === m[2]); if (sg) sg.comment = m[3];
        }
        continue;
      }
      if ((m = /^VAL_\s+(\d+)\s+(\w+)\s+(.*);/.exec(line))) {
        const msg = messages[idToHex(Number(m[1]))];
        const sg = msg && msg.signals.find(s => s.name === m[2]);
        if (sg) {
          sg.values = {};
          const re = /(-?\d+)\s+"([^"]*)"/g; let v;
          while ((v = re.exec(m[3]))) sg.values[v[1]] = v[2];
        }
      }
    }
    return { messages, count: Object.keys(messages).length, skipped };
  }

  const clean = s => String(s || 'X').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 32);

  // labels = { ID: { name, signals: [...] } }
  function exportDbc(labels, title) {
    const out = ['VERSION "' + (title || 'Aboy Canbus') + '"', '', 'NS_ :', '', 'BS_:', '', 'BU_: ECU', ''];
    const cms = [];
    for (const id of Object.keys(labels).sort()) {
      const l = labels[id];
      out.push(`BO_ ${hexToDbcId(id)} ${clean(l.name || 'ID_' + id)}: 8 ECU`);
      for (const s of l.signals || []) {
        out.push(` SG_ ${clean(s.name)} : ${s.start}|${s.length}@${s.order === 'motorola' ? 0 : 1}${s.signed ? '-' : '+'} (${s.scale},${s.offset}) [${s.min || 0}|${s.max || 0}] "${(s.unit || '').replace(/"/g, '')}" Vector__XXX`);
      }
      out.push('');
      if (l.name) cms.push(`CM_ BO_ ${hexToDbcId(id)} "${String(l.name).replace(/"/g, "'")}";`);
    }
    return out.concat(cms).join('\n') + '\n';
  }

  const api = { parseDbc, exportDbc, idToHex, hexToDbcId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dbc = api;
})(typeof self !== 'undefined' ? self : this);
