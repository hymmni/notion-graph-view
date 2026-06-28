(() => {
  const DB_NAME    = 'notionGraphCache';
  const DB_VERSION = 1;
  const STORE_NAME = 'graphs';

  const openDatabase = () => new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'pageId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });

  const run = async (mode, handler) => {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let req;
      try { req = handler(store); } catch (err) { reject(err); return; }
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  };

  const getGraphFromCache = async (pageId) => {
    if (!pageId) return null;
    try {
      const entry = await run('readonly', s => s.get(pageId));
      return entry?.data ?? null;
    } catch (err) {
      console.warn('[graph-cache] read error', err);
      return null;
    }
  };

  const saveGraphToCache = async (pageId, data) => {
    if (!pageId || !data) return;
    try {
      await run('readwrite', s => s.put({ pageId, data }));
    } catch (err) {
      console.warn('[graph-cache] write error', err);
    }
  };

  const removeGraphFromCache = async (pageId) => {
    if (!pageId) return;
    try { await run('readwrite', s => s.delete(pageId)); } catch {}
  };

  const clearGraphCache = async () => {
    try { await run('readwrite', s => s.clear()); } catch {}
  };

  self.graphCache = { getGraphFromCache, saveGraphToCache, removeGraphFromCache, clearGraphCache };
})();
