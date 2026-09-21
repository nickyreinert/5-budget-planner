// --- transfers.js ---
// Detects transaction pairs that represent the SAME real-world expense/income
// counted twice because the export mixes two ledgers together - e.g. a
// PayPal purchase, then the bank statement showing PayPal collecting that
// exact amount from the "real" account a few days later. Counting both
// would double the spend.
//
// Heuristic: two transactions are a pair when their amounts are exact
// opposites (one debits what the other credits) and they happen within a
// configurable number of days of each other. Greedy nearest-gap matching;
// each transaction is used in at most one pair.

const STORAGE_KEY = 'internalTransferMaxDays';
const DEFAULT_MAX_DAYS = 3;

export function get_transfer_max_days() {
  const stored = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  return Number.isFinite(stored) && stored >= 0 ? stored : DEFAULT_MAX_DAYS;
}

export function save_transfer_max_days(days) {
  localStorage.setItem(STORAGE_KEY, String(Math.max(0, Math.round(days) || 0)));
}

function days_between(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 86400000;
}

// Returns [{a, b, days}], `a` always the earlier leg, sorted by that date.
export function find_internal_transfer_pairs(rows, maxDays) {
  const candidates = rows.filter(r => r.betrag_cents && r._cls?.group === 'internal_transfer' && !/paypal|bank account/i.test(`${r.name} ${r.verwendungszweck} ${account_key(r)}`));
  const byAbsAmount = new Map();
  candidates.forEach((r, idx) => {
    const key = Math.abs(r.betrag_cents);
    if (!byAbsAmount.has(key)) byAbsAmount.set(key, []);
    byAbsAmount.get(key).push(idx);
  });

  const used = new Set();
  const pairs = [];
  candidates.forEach((r, idx) => {
    if (used.has(idx)) return;
    let best = null;
    for (const otherIdx of byAbsAmount.get(Math.abs(r.betrag_cents)) || []) {
      if (otherIdx === idx || used.has(otherIdx)) continue;
      const other = candidates[otherIdx];
      if (!account_key(r) || !account_key(other) || account_key(r) === account_key(other)) continue;
      if (other.betrag_cents !== -r.betrag_cents) continue;
      const gap = days_between(r.date, other.date);
      if (gap > maxDays) continue;
      if (!best || gap < best.gap) best = { idx: otherIdx, gap };
    }
    if (!best) return;
    used.add(idx); used.add(best.idx);
    const other = candidates[best.idx];
    const [a, b] = r.date <= other.date ? [r, other] : [other, r];
    pairs.push({ a, b, days: best.gap });
  });

  return pairs.sort((x, y) => x.a.date - y.a.date);
}

// Marks both legs of every detected pair as an excluded internal transfer -
// call after classify_all() but before apply_manual_overrides() so an
// explicit per-transaction choice still wins over this heuristic.
export function apply_internal_transfer_pairs(rows, pairs) {
  const rowsInPairs = new Set();
  pairs.forEach(p => { rowsInPairs.add(p.a); rowsInPairs.add(p.b); });
  rowsInPairs.forEach(r => {
    if (!r._cls) return;
    r._cls = { ...r._cls, group: 'internal_transfer', excluded: true, source: 'transfer-detection' };
  });
}


export function account_key(row) {
  return row._account || row.Kontoname || row.Account || row['Eigenes Konto'] || (row.source === 'manual' ? 'Manuell' : 'Konto unbekannt');
}
export function is_paypal_account(row) { return /paypal/i.test(account_key(row)); }
const funding = row => is_paypal_account(row) && /bank account|bankkonto|guthaben.*(ein|aus)zahlung/i.test(row.name || row.Name || '');
const settlement = row => !is_paypal_account(row) && /paypal/i.test(`${row.name || row.Name || ''} ${row.verwendungszweck || ''}`);

// Find a unique exact combination, bounded to keep CSV imports responsive.
// Ambiguous or oversized candidate sets stay visible for review.
function unique_bundle(candidates, target) {
  if (candidates.length > 20) return null;
  const sums = new Map([[0, [[]]]]);
  for (const row of candidates) {
    for (const [sum, combinations] of [...sums]) {
      const next = sum + Math.abs(row.betrag_cents);
      if (next > target) continue;
      const existing = sums.get(next) || [];
      sums.set(next, [...existing, ...combinations.map(c => [...c, row])].slice(0, 2));
    }
    if (sums.size > 10000) return null;
  }
  const matches = sums.get(target);
  return matches?.length === 1 ? matches[0] : null;
}
export function reconcile_paypal(rows, maxDays = 7) {
  rows.forEach(r => { delete r._effectiveAccount; delete r._paypalLinked; delete r._paypalUnmatched; });
  const purchases = rows.filter(r => is_paypal_account(r) && !funding(r) && r.betrag_cents);
  const used = new Set();
  rows.filter(funding).forEach(r => { r._cls = { ...r._cls, group: 'internal_transfer', excluded: true, source: 'paypal-funding' }; });
  for (const bank of rows.filter(settlement).sort((a,b) => a.date-b.date)) {
    const candidates = purchases.filter(r => !used.has(r) && Math.sign(r.betrag_cents) === Math.sign(bank.betrag_cents) && days_between(r.date, bank.date) <= maxDays);
    const bundle = unique_bundle(candidates, Math.abs(bank.betrag_cents));
    if (!bundle) {
      // A settlement rule alone is not evidence that the matching PayPal
      // export exists. Never silently discard a bank-only purchase.
      if (bank._cls?.group === 'internal_transfer') bank._cls = { category: 'Sonstige Ausgaben', group: 'unclassified', excluded: false, source: 'paypal-unmatched' };
      bank._paypalUnmatched = true;
      continue;
    }
    bank._cls = { ...bank._cls, excluded: true, group: 'internal_transfer', source: 'paypal-settlement' };
    bank._paypalLinked = true;
    for (const purchase of bundle) {
      used.add(purchase); purchase._effectiveAccount = account_key(bank); purchase._paypalLinked = true;
    }
  }
  return rows;
}
