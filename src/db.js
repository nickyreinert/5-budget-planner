// --- db.js ---
// IndexedDB-backed storage for manual per-transaction category overrides,
// and for manually logged ("quick-entry") spends.
// Uses IndexedDB instead of localStorage because the number of transactions
// (and thus overrides) can grow into the thousands over time - far beyond
// what's comfortable to keep as one big JSON blob in localStorage.

const DB_NAME = 'moneyMoneyAnalyzer';
const DB_VERSION = 3;
const IMPORT_STORE = 'importedEntries';
// Namespaced numeric entries reuse the existing store, avoiding upgrades that
// would block while an older app tab is still open. Category values are strings.
const AMOUNT_PREFIX = 'amount:';
const STORE = 'categoryOverrides';
const MANUAL_STORE = 'manualEntries';

let dbPromise = null;

function open_db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMPORT_STORE)) db.createObjectStore(IMPORT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE); // keyed by transaction id (see data.js#tx_id)
      }
      if (!db.objectStoreNames.contains(MANUAL_STORE)) {
        db.createObjectStore(MANUAL_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

// Loads every stored override as a plain { txId: category } map, so
// classification can look overrides up synchronously per row.
export async function load_all_overrides() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const overrides = {};
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (typeof cursor.value === 'string') overrides[cursor.key] = cursor.value;
        cursor.continue();
      } else {
        resolve(overrides);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Persists one or more (txId, category) overrides in a single transaction -
// used for both single-row edits and bulk assignment to selected rows.
export async function save_overrides(idCategoryPairs) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    idCategoryPairs.forEach(([id, category]) => store.put(category, id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Quick-entry spends: a manually logged transaction, stored in the shape of
// a synthetic CSV row (Datum/Name/Verwendungszweck/Kategorie/Betrag) so it
// can be run through the same enrich_row() as an imported one. Its category
// is NOT stored here - it goes through save_overrides() above, keyed by
// tx_id(), exactly like a manual recategorization of an imported row, so it
// survives reclassify() the same way.
export async function add_manual_entry(record) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MANUAL_STORE, 'readwrite');
    tx.objectStore(MANUAL_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function load_manual_entries() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const store = db.transaction(MANUAL_STORE, 'readonly').objectStore(MANUAL_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Removes a manual entry and its category override together, so deleting a
// mistaken quick-entry doesn't leave an orphaned override behind.
export async function delete_manual_entry(id, txId) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([MANUAL_STORE, STORE], 'readwrite');
    tx.objectStore(MANUAL_STORE).delete(id);
    if (txId) { tx.objectStore(STORE).delete(txId); tx.objectStore(STORE).delete(AMOUNT_PREFIX + txId); }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function load_amount_overrides() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const result = {};
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(result);
      if (String(cursor.key).startsWith(AMOUNT_PREFIX) && Number.isSafeInteger(cursor.value)) result[cursor.key.slice(AMOUNT_PREFIX.length)] = cursor.value;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function save_amount_override(id, cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('Invalid amount');
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(cents, AMOUNT_PREFIX + id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Imports have their own durable store; put() is an upsert by source identity.
export async function upsert_imported_entries(records) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([IMPORT_STORE, STORE], 'readwrite');
    const imports = tx.objectStore(IMPORT_STORE), overrides = tx.objectStore(STORE);
    records.forEach(record => {
      imports.put(record);
      if (!record.legacyId || record.legacyId === record.id) return;
      const request = imports.get(record.legacyId);
      request.onsuccess = () => {
        if (!request.result || request.result._account) return;
        imports.delete(record.legacyId);
        for (const prefix of ['', AMOUNT_PREFIX]) {
          const old = overrides.get(prefix + record.legacyId);
          old.onsuccess = () => { if (old.result !== undefined) { overrides.put(old.result, prefix + record.id); overrides.delete(prefix + record.legacyId); } };
        }
      };
    });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Import aborted'));
  });
}

export async function load_imported_entries() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IMPORT_STORE, 'readonly').objectStore(IMPORT_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
