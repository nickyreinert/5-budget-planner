// --- db.js ---
// IndexedDB-backed storage for manual per-transaction category overrides,
// and for manually logged ("quick-entry") spends.
// Uses IndexedDB instead of localStorage because the number of transactions
// (and thus overrides) can grow into the thousands over time - far beyond
// what's comfortable to keep as one big JSON blob in localStorage.

const DB_NAME = 'fiveBudgets';
const DB_VERSION = 4;
const IMPORT_STORE = 'importedEntries';
const RANGE_STORE = 'importRanges';
const RECONCILIATION_STORE = 'reconciliationDecisions';
// Namespaced numeric entries reuse the existing store, avoiding upgrades that
// would block while an older app tab is still open. Category values are strings.
const AMOUNT_PREFIX = 'amount:';
const NOTE_PREFIX = 'note:';
const DATE_PREFIX = 'date:';
const PERIOD_PREFIX = 'period:';
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
      if (!db.objectStoreNames.contains(RANGE_STORE)) db.createObjectStore(RANGE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(RECONCILIATION_STORE)) db.createObjectStore(RECONCILIATION_STORE);
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
        const key = String(cursor.key);
        const isNamespaced = key.startsWith(AMOUNT_PREFIX) || key.startsWith(NOTE_PREFIX) || key.startsWith(DATE_PREFIX) || key.startsWith(PERIOD_PREFIX);
        if (!isNamespaced && typeof cursor.value === 'string') overrides[cursor.key] = cursor.value;
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
    const tx = db.transaction([MANUAL_STORE, STORE, RECONCILIATION_STORE], 'readwrite');
    tx.objectStore(MANUAL_STORE).delete(id);
    tx.objectStore(RECONCILIATION_STORE).delete(id);
    if (txId) {
      const store = tx.objectStore(STORE);
      [txId, AMOUNT_PREFIX + txId, NOTE_PREFIX + txId, DATE_PREFIX + txId, PERIOD_PREFIX + txId].forEach(key => store.delete(key));
    }
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

// Manual note (Verwendungszweck) edits, namespaced the same way as amount
// overrides so they share the categoryOverrides store without colliding.
export async function load_note_overrides() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const result = {};
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(result);
      if (String(cursor.key).startsWith(NOTE_PREFIX) && typeof cursor.value === 'string') result[cursor.key.slice(NOTE_PREFIX.length)] = cursor.value;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function save_note_override(id, note) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(String(note || ''), NOTE_PREFIX + id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Manual date edits, stored as "YYYY-MM-DD" strings.
export async function load_date_overrides() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const result = {};
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(result);
      if (String(cursor.key).startsWith(DATE_PREFIX) && typeof cursor.value === 'string') result[cursor.key.slice(DATE_PREFIX.length)] = cursor.value;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function save_date_override(id, isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) throw new Error('Invalid date');
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(isoDate, DATE_PREFIX + id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// A reporting-period date never changes the bank booking date. It is used
// solely by recurring-income/fixed-cost analytics and can override an
// automatic boundary correction for one transaction.
export async function load_effective_period_overrides() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const result = {};
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(result);
      if (String(cursor.key).startsWith(PERIOD_PREFIX) && /^\d{4}-\d{2}-\d{2}$/.test(cursor.value || '')) result[String(cursor.key).slice(PERIOD_PREFIX.length)] = cursor.value;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function save_effective_period_override(id, isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) throw new Error('Invalid reporting period date');
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(isoDate, PERIOD_PREFIX + id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clear_effective_period_override(id) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(PERIOD_PREFIX + id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Imports have their own durable store; put() is an upsert by source identity.
export async function upsert_imported_entries(records, ranges = []) {
  // Coverage belongs to a file/account, never to the combined history. Keeping
  // ranges separate preserves gaps between uploads and empty export periods.
  ranges.forEach(validate_import_range);
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([IMPORT_STORE, STORE, RANGE_STORE, RECONCILIATION_STORE], 'readwrite');
    const imports = tx.objectStore(IMPORT_STORE), overrides = tx.objectStore(STORE);
    const redirects = new Map();
    let remaining = records.filter(record => record.legacyId && record.legacyId !== record.id).length;
    function migrate_decision_ids() {
      if (--remaining || !redirects.size) return;
      const cursorRequest = tx.objectStore(RECONCILIATION_STORE).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const target = redirects.get(cursor.value?.importedId);
        if (target && cursor.value.kind === 'match') cursor.update({ kind: 'match', importedId: target });
        cursor.continue();
      };
    }
    ranges.forEach(range => tx.objectStore(RANGE_STORE).put(range));
    records.forEach(record => {
      imports.put(record);
      if (!record.legacyId || record.legacyId === record.id) return;
      const request = imports.get(record.legacyId);
      request.onsuccess = () => {
        const oldCurrency = String(request.result?.Währung || 'EUR').trim().toUpperCase();
        const newCurrency = String(record.Währung || 'EUR').trim().toUpperCase();
        if (!request.result || request.result._account || oldCurrency !== newCurrency) { migrate_decision_ids(); return; }
        imports.delete(record.legacyId);
        redirects.set(record.legacyId, record.id);
        for (const prefix of ['', AMOUNT_PREFIX, NOTE_PREFIX, DATE_PREFIX, PERIOD_PREFIX]) {
          const old = overrides.get(prefix + record.legacyId);
          old.onsuccess = () => { if (old.result !== undefined) { overrides.put(old.result, prefix + record.id); overrides.delete(prefix + record.legacyId); } };
        }
        migrate_decision_ids();
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

function valid_iso_date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function validate_import_range(range) {
  if (!range || typeof range.id !== 'string' || typeof range.account !== 'string' ||
      !valid_iso_date(range.from) || !valid_iso_date(range.to) || range.from > range.to) {
    throw new Error('Invalid import period');
  }
}

export async function load_import_ranges() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const req = db.transaction(RANGE_STORE, 'readonly').objectStore(RANGE_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function load_reconciliation_decisions() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const result = {};
    const req = db.transaction(RECONCILIATION_STORE, 'readonly').objectStore(RECONCILIATION_STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(result);
      Object.defineProperty(result, cursor.key, { value: cursor.value, enumerable: true });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// A null decision restores automatic matching. The raw manual record remains.
export async function save_reconciliation_decision(manualId, decision) {
  if (typeof manualId !== 'string' || !manualId || (decision !== null &&
      (!decision || !['cash', 'separate', 'match'].includes(decision.kind) ||
      (decision.kind === 'match' && (typeof decision.importedId !== 'string' || !decision.importedId))))) {
    throw new Error('Invalid reconciliation decision');
  }
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECONCILIATION_STORE, 'readwrite');
    const store = tx.objectStore(RECONCILIATION_STORE);
    if (decision === null) store.delete(manualId);
    else store.put({ kind: decision.kind, ...(decision.kind === 'match' ? { importedId: decision.importedId } : {}) }, manualId);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Reconciliation aborted'));
  });
}
