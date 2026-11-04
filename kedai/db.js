// Simpanan data dalam telefon (IndexedDB)
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('akaun-kedai', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('sales', { keyPath: 'id', autoIncrement: true });
          d.createObjectStore('buys', { keyPath: 'id', autoIncrement: true });
          d.createObjectStore('kv');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  async function run(stores, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let result;
      const r = fn(t);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => res(result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }
  return {
    all: s => run(s, 'readonly', t => t.objectStore(s).getAll()),
    put: (s, v) => run(s, 'readwrite', t => t.objectStore(s).put(v)),
    del: (s, id) => run(s, 'readwrite', t => t.objectStore(s).delete(id)),
    getKV: k => run('kv', 'readonly', t => t.objectStore('kv').get(k)),
    setKV: (k, v) => run('kv', 'readwrite', t => t.objectStore('kv').put(v, k)),
    // Ganti semua data (untuk pulih backup) dalam satu transaksi
    replaceAll: (data) => run(['sales', 'buys', 'kv'], 'readwrite', t => {
      ['sales', 'buys', 'kv'].forEach(s => t.objectStore(s).clear());
      data.sales.forEach(x => t.objectStore('sales').put(x));
      data.buys.forEach(x => t.objectStore('buys').put(x));
      Object.entries(data.kv).forEach(([k, v]) => t.objectStore('kv').put(v, k));
    })
  };
})();
