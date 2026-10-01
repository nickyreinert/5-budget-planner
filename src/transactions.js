import { enrich_row, tx_id, apply_amount_overrides, is_real_cashflow } from './data.js';
import { t } from './i18n.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MATCH_DAYS_KEY = 'manualMatchDays';

function match_days(value) {
  if (value === undefined || value === null || value === '') return 3;
  const days = Number(value);
  return Number.isFinite(days) ? Math.max(0, Math.min(14, Math.trunc(days))) : 3;
}

export function get_manual_match_days() {
  try { return match_days(typeof localStorage === 'undefined' ? undefined : localStorage.getItem(MATCH_DAYS_KEY)); }
  catch { return 3; }
}

export function save_manual_match_days(value) {
  const days = match_days(value);
  if (typeof localStorage !== 'undefined') localStorage.setItem(MATCH_DAYS_KEY, String(days));
  return days;
}

// Compare local calendar dates through UTC day numbers. Subtracting local
// timestamps would turn a three-day window into 71/73 hours at DST changes.
function calendar_day(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  utc.setUTCHours(0, 0, 0, 0);
  return utc.getTime() / DAY_MS;
}

function iso_day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY_MS;
}

function day_iso(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function datum_day(value) {
  const parts = typeof value === 'string' && value.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return parts ? iso_day(`${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`) : null;
}

function source_account(row) {
  return String(row._account || row.Kontoname || row.Account || '').trim();
}

function account_identity(account) { return String(account || '').trim().toLowerCase(); }
function currency(row) { return String(row.Währung || 'EUR').trim().toUpperCase(); }

// Each upload establishes its own intervals: two uploads with a gap never
// imply that the intervening days were imported. Konto/Bank describe the
// recipient in many CSV formats and are deliberately not source accounts.
export function csv_import_ranges(records, { from, to, account = '' } = {}) {
  const supplied = value => value !== undefined && value !== null && value !== '';
  const explicit = supplied(from) || supplied(to);
  const first = iso_day(from), last = iso_day(to);
  if (explicit && (first === null || last === null || first > last)) throw new Error('Invalid CSV import date range');
  const ranges = new Map();
  for (const record of records) {
    const day = datum_day(record.Datum);
    if (day === null) throw new Error('Invalid CSV transaction date');
    if (explicit && (day < first || day > last)) throw new Error('CSV import range must include every transaction date');
    const name = source_account(record) || String(account || '').trim();
    const existing = ranges.get(name);
    if (existing) {
      existing.first = Math.min(existing.first, day);
      existing.last = Math.max(existing.last, day);
    } else ranges.set(name, { first: day, last: day });
  }
  if (!records.length && explicit) {
    const name = String(account || '').trim();
    if (!name) throw new Error('An empty CSV import range needs a source account');
    ranges.set(name, { first, last });
  }
  return [...ranges].map(([name, range]) => {
    const rangeFrom = day_iso(explicit ? first : range.first);
    const rangeTo = day_iso(explicit ? last : range.last);
    return { id: `csv-range:${JSON.stringify([name, rangeFrom, rangeTo])}`, account: name, from: rangeFrom, to: rangeTo };
  });
}

// Occurrence numbers preserve two genuinely identical bookings in a file,
// while overlapping exports upsert the same occurrences again.
export function csv_records(rows) {
  const counts = new Map(), legacyCounts = new Map();
  return rows.map(row => {
    const legacyKey = tx_id(row);
    const legacyOccurrence = (legacyCounts.get(legacyKey) || 0) + 1;
    legacyCounts.set(legacyKey, legacyOccurrence);
    const account = row._account || row.Kontoname || row.Account || '';
    const accountKey = account ? [legacyKey, account].join('|') : legacyKey;
    // Preserve EUR identities used by existing overrides while separating
    // a numerically identical booking in another currency.
    const key = currency(row) === 'EUR' ? accountKey : `${accountKey}|currency:${currency(row)}`;
    const occurrence = (counts.get(key) || 0) + 1;
    counts.set(key, occurrence);
    return { Datum: row.Datum, Name: row.Name, Verwendungszweck: row.Verwendungszweck,
      Kategorie: row.Kategorie, Betrag: row.Betrag, _account: account, Konto: row.Konto || '', Bank: row.Bank || '', Währung: row.Währung || 'EUR', source: 'csv',
      legacyId: `csv:${JSON.stringify([legacyKey, legacyOccurrence])}`,
      id: `csv:${JSON.stringify([key, occurrence])}` };
  });
}

function compatible_amount(left, right) {
  return Number.isSafeInteger(left.betrag_cents) && Number.isSafeInteger(right.betrag_cents) &&
    left.betrag_cents === right.betrag_cents && currency(left) === currency(right);
}

function nearby_date(left, right, maxDays) {
  const a = calendar_day(left.date), b = calendar_day(right.date);
  return a !== null && b !== null && Math.abs(a - b) <= maxDays;
}

function candidate_graph(manualRows, bankRows, compatible) {
  const candidates = new Map(), claimants = new Map();
  const amountBuckets = new Map();
  const amountKey = row => `${currency(row)}|${row.betrag_cents}`;
  for (const bank of bankRows) {
    const key = amountKey(bank);
    if (!amountBuckets.has(key)) amountBuckets.set(key, []);
    amountBuckets.get(key).push(bank);
  }
  for (const row of manualRows) {
    const choices = (amountBuckets.get(amountKey(row)) || []).filter(bank => compatible(row, bank));
    candidates.set(row, choices);
    for (const bank of choices) claimants.set(bank, (claimants.get(bank) || 0) + 1);
  }
  return { candidates, claimants };
}

// Match only pairs that are unique from both directions. An equal amount
// alone cannot decide between two purchases, even if input order is stable.
// The persisted records are never changed; CSV facts remain authoritative.
export function reconcile_transactions(imported, manual, amounts = {}, options = {}) {
  const { dateOverrides = {}, importRanges = [], decisions = {} } = options;
  const maxDays = match_days(options.maxDays);
  const rows = imported.map(rec => enrich_row({ ...rec, _txId: rec.id, source: rec.source || 'csv' }));
  const storedRows = manual.map(rec => enrich_row({ ...rec, source: rec.source || 'manual',
    ...(rec.source === 'gocardless' ? {} : { _manualId: rec.id }), _txId: rec._txId }));

  // Historical GoCardless records are bank imports despite their storage
  // location. Their bank amount/date are not manual expense edits. Legacy
  // account IDs and CSV account labels differ, so retain the established
  // PayPal/non-PayPal account distinction for cross-source bank duplicates.
  const syncedRows = storedRows.filter(row => row.source === 'gocardless');
  const bankGraph = candidate_graph(syncedRows, rows, (bank, csv) =>
    compatible_amount(bank, csv) && nearby_date(bank, csv, 0) &&
    /paypal/i.test(source_account(bank)) === /paypal/i.test(source_account(csv)));
  for (const bank of syncedRows) {
    const choices = bankGraph.candidates.get(bank);
    const match = choices.length === 1 && bankGraph.claimants.get(choices[0]) === 1 ? choices[0] : null;
    if (match) {
      match._sources = [match.source, bank.source];
      match._matchedBankTxId = tx_id(bank);
    } else rows.push(bank);
  }
  const bankRows = [...rows];

  const manualRows = storedRows.filter(row => row.source !== 'gocardless');
  const originals = new Map(manualRows.map(row => [row, {
    id: row.id, txId: tx_id(row), Datum: row.Datum, Name: row.Name,
    Verwendungszweck: row.Verwendungszweck, Kategorie: row.Kategorie,
    Betrag: row.Betrag, cents: row.betrag_cents, account: source_account(row), currency: currency(row)
  }]));
  apply_amount_overrides(manualRows, amounts);
  for (const row of manualRows) {
    const override = dateOverrides[tx_id(row)] ?? dateOverrides[tx_id({ ...row, _txId: undefined })];
    const day = iso_day(override);
    if (day !== null) {
      const [year, month, date] = override.split('-').map(Number);
      row._originalDate = row.date;
      row.date = new Date(year, month - 1, date);
    }
  }
  const compatible = (entry, bank) => compatible_amount(entry, bank) && nearby_date(entry, bank, maxDays) &&
    (!source_account(entry) || account_identity(source_account(entry)) === account_identity(source_account(bank)));
  const covered = row => {
    const day = calendar_day(row.date), account = account_identity(source_account(row));
    return day !== null && importRanges.some(range => {
      const first = iso_day(range.from), last = iso_day(range.to);
      return first !== null && last !== null && first <= day && day <= last &&
        (!account || account === account_identity(range.account));
    });
  };

  const matched = new Set(), consumed = new Set();
  const allCandidates = candidate_graph(manualRows, bankRows, compatible).candidates;
  function match_entry(row, bank) {
    bank._matchedManualTxId = tx_id(row);
    bank._matchedManualId = row.id;
    bank._matchedManualCategory = row.Kategorie || null;
    bank._matchedManual = { ...originals.get(row), effectiveCents: row.betrag_cents, effectiveDate: day_iso(calendar_day(row.date)) };
    bank._sources = [...(bank._sources || [bank.source]), row.source];
    bank._reconciliation = { status: 'matched', manualId: row.id, importedId: tx_id(bank), candidateIds: [tx_id(bank)] };
    matched.add(row);
    consumed.add(bank);
  }

  // Decisions are replayed before automatic matching. A stale decision or
  // two decisions claiming the same bank booking stays unresolved instead
  // of silently choosing another booking or letting input order win.
  const explicit = new Map(), explicitClaims = new Map();
  for (const row of manualRows) {
    const decision = decisions[row.id];
    if (row.reconciliationMode === 'forecast' || decision?.kind !== 'match') continue;
    if (typeof decision.importedId !== 'string' || !decision.importedId) continue;
    const choices = allCandidates.get(row).filter(bank => decision.importedId === tx_id(bank) ||
      decision.importedId === bank.id || decision.importedId === bank._matchedBankTxId);
    if (choices.length !== 1) continue;
    explicit.set(row, choices[0]);
    explicitClaims.set(choices[0], (explicitClaims.get(choices[0]) || 0) + 1);
  }
  for (const [row, bank] of explicit) if (explicitClaims.get(bank) === 1) match_entry(row, bank);

  const automaticRows = manualRows.filter(row => row.reconciliationMode !== 'forecast' && !matched.has(row) && !decisions[row.id]?.kind);
  const available = bankRows.filter(bank => !consumed.has(bank) && (explicitClaims.get(bank) || 0) < 2);
  const graph = candidate_graph(automaticRows, available, compatible);
  for (const row of automaticRows) {
    const choices = graph.candidates.get(row);
    if (choices.length === 1 && graph.claimants.get(choices[0]) === 1) match_entry(row, choices[0]);
  }

  for (const row of manualRows) {
    if (matched.has(row)) continue;
    if (row.reconciliationMode === 'forecast') {
      row._reconciliation = { status: 'forecast', candidateIds: [], decisionKind: null };
      rows.push(row);
      continue;
    }
    const decision = decisions[row.id];
    const choices = decision?.kind === 'cash' ? [] : allCandidates.get(row).filter(bank => !consumed.has(bank));
    const ambiguous = decision?.kind !== 'separate' && (choices.length > 1 ||
      choices.some(bank => (graph.claimants.get(bank) || 0) > 1 || (explicitClaims.get(bank) || 0) > 1));
    const status = decision?.kind === 'cash' ? 'cash' : !covered(row) ? 'pending' : ambiguous ? 'ambiguous' : 'unassigned';
    row._reconciliation = { status, candidateIds: choices.map(tx_id).sort(), decisionKind: decision?.kind || null };
    rows.push(row);
  }
  return rows;
}

export function reconciliation_summary(rows) {
  const unresolved = rows.filter(row => row.source === 'manual' && row.betrag_cents < 0 && is_real_cashflow(row) &&
    ['unassigned', 'ambiguous'].includes(row._reconciliation?.status));
  return { count: unresolved.length, cents: unresolved.reduce((sum, row) => sum + Math.abs(row.betrag_cents), 0), rows: unresolved };
}

export function transaction_source_label(row) {
  if (row._matchedManualId) return t('reconciliation.sourceMatched');
  if (row._sources?.length > 1) return t('reconciliation.sourceBankMatched');
  // Explain the excluded leg of a linked PayPal payment in the ledger.
  if (row._paypalLinked) return t(row._cls?.source === 'paypal-settlement' || row._cls?.source === 'paypal-funding' ? 'reconciliation.sourcePayPalExcluded' : 'reconciliation.sourcePayPalLinked');
  if (row._cls?.source === 'reversal-detection') return t('reconciliation.sourceReversal');
  if (row._mergeGroup) return t('reconciliation.sourceMerged');
  const statusKey = { pending: 'sourcePending', unassigned: 'sourceUnassigned', ambiguous: 'sourceAmbiguous', cash: 'sourceCash', forecast: 'sourceForecast' }[row._reconciliation?.status];
  if (statusKey) return t(`reconciliation.${statusKey}`);
  return t(row.source === 'manual' ? 'reconciliation.sourceManual' : row.source === 'gocardless' ? 'reconciliation.sourceBank' : 'reconciliation.sourceCsv');
}
