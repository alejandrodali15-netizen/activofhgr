// Almacenamiento en el teléfono (IndexedDB). Todo lo que la app necesita para trabajar sin señal vive aquí.
(function () {
  const NOMBRE = 'activo-fijo', VERSION = 1;
  const STORES = {
    kv: {keyPath: 'k'},
    bienes: {keyPath: 'folio'},
    grupos: {keyPath: 'id'},
    remotas: {keyPath: 'id'},       // validaciones ya guardadas en el servidor
    sobrantes: {keyPath: 'id'},     // sobrantes ya guardados en el servidor
    cola: {keyPath: 'id'},          // cambios capturados en este teléfono y aún no confirmados
    fotos: {keyPath: 'key'}         // fotos pendientes de subir
  };
  let dbp = null;

  function abrir() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NOMBRE, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        Object.entries(STORES).forEach(([n, o]) => { if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, o); });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(stores, modo, fn) {
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, modo);
      let res;
      t.oncomplete = () => resolve(res);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
      res = fn(t);
    });
  }

  function reqP(r) { return new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); }

  window.DB = {
    async get(store, key) { const db = await abrir(); return reqP(db.transaction(store).objectStore(store).get(key)); },
    async all(store) { const db = await abrir(); return reqP(db.transaction(store).objectStore(store).getAll()); },
    async put(store, val) { return tx([store], 'readwrite', t => { t.objectStore(store).put(val); }); },
    async del(store, key) { return tx([store], 'readwrite', t => { t.objectStore(store).delete(key); }); },
    async count(store) { const db = await abrir(); return reqP(db.transaction(store).objectStore(store).count()); },
    /** Reemplaza el contenido completo de un almacén en una sola transacción. */
    async reemplazar(store, valores) {
      return tx([store], 'readwrite', t => { const s = t.objectStore(store); s.clear(); valores.forEach(v => s.put(v)); });
    },
    /** Guarda un cambio y sus fotos en una sola transacción: o se guarda todo o nada. */
    async guardarCambio(cambio, fotos) {
      return tx(['cola', 'fotos'], 'readwrite', t => {
        t.objectStore('cola').put(cambio);
        fotos.forEach(f => t.objectStore('fotos').put(f));
      });
    },
    async kvGet(k) { const r = await this.get('kv', k); return r ? r.v : undefined; },
    async kvSet(k, v) { return this.put('kv', {k, v}); },
    async borrarTodo() {
      return tx(Object.keys(STORES), 'readwrite', t => Object.keys(STORES).forEach(s => t.objectStore(s).clear()));
    },
    async pedirPersistencia() {
      try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
      return false;
    }
  };
})();
