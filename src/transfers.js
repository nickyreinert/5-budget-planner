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

import { tx_id } from './data.js';

const STORAGE_KEY = 'internalTransferMaxDays';
const DEFAULT_MAX_DAYS = 3;
// A reversal ist meist deutlich später gebucht als das Original, deshalb ein
// eigenes, größeres Fenster statt des engen Transfer-Fensters.
const REVERSAL_STORAGE_KEY = 'reversalMaxDays';
const DEFAULT_REVERSAL_MAX_DAYS = 14;
const SPLIT_STORAGE_KEY = 'mergeSplitIds';

export function get_transfer_max_days() {
  const stored = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  return Number.isFinite(stored) && stored >= 0 ? stored : DEFAULT_MAX_DAYS;
}

export function save_transfer_max_days(days) {
  localStorage.setItem(STORAGE_KEY, String(Math.max(0, Math.round(days) || 0)));
}

export function get_reversal_max_days() {
  const stored = parseInt(localStorage.getItem(REVERSAL_STORAGE_KEY), 10);
  return Number.isFinite(stored) && stored >= 0 ? stored : DEFAULT_REVERSAL_MAX_DAYS;
}

export function save_reversal_max_days(days) {
  localStorage.setItem(REVERSAL_STORAGE_KEY, String(Math.max(0, Math.round(days) || 0)));
}

// Transactions the user explicitly pulled OUT of an automatic merge ("wait,
// this one doesn't belong here") - they never take part in any pairing again.
export function get_merge_split_ids() {
  try {
    const stored = JSON.parse(localStorage.getItem(SPLIT_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(stored) ? stored : []);
  } catch { return new Set(); }
}

export function save_merge_split_ids(ids) {
  localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify([...ids]));
}

// Every automatically linked set of transactions carries the same
// `_mergeGroup`, so the UI can show "this is one merged booking" and list
// its members. Derived per reclassify, never persisted.
export function clear_merge_groups(rows) {
  rows.forEach(r => { delete r._mergeGroup; });
}

function tag_merge_group(members, kind) {
  const ids = members.map(tx_id);
  const id = `${kind}:${[...ids].sort().join('|')}`;
  members.forEach(r => { r._mergeGroup = { id, kind, members: ids }; });
}

function days_between(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 86400000;
}

// Returns [{a, b, days}], `a` always the earlier leg, sorted by that date.
export function find_internal_transfer_pairs(rows, maxDays, splitIds = new Set()) {
  const candidates = rows.filter(r => r.betrag_cents && r._cls?.group === 'internal_transfer' && !splitIds.has(tx_id(r)) && !/paypal|bank account/i.test(`${r.name} ${r.verwendungszweck} ${account_key(r)}`));
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
      if (account_key(r) === 'Konto unbekannt' || account_key(other) === 'Konto unbekannt' || account_key(r) === account_key(other)) continue;
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
  pairs.forEach(p => tag_merge_group([p.a, p.b], 'transfer'));
}

// --- Reversals / failed transfers -------------------------------------
// A booking and its later cancellation land on the SAME account (unlike the
// two-account transfer pair above): a top-up that never went through, a
// refunded purchase, a returned direct debit. Both legs cancel each other
// out to exactly zero, so counting either one distorts the budget - while
// the real expense they were meant to cover is a separate transaction with
// a different counterparty that must stay untouched.
//
// Deliberately NOT keyed off any wording like "failed transfer" (that's
// bank/processor specific and would never generalise). The evidence used is
// purely structural: same account, exactly opposite amounts, same
// counterparty, within `maxDays`.
function text_key(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function name_key(row) {
  return text_key(row.name || row.Name || '');
}

// "Bank Account" vs "Bank Account (direct debit)": the reversal leg is
// usually the same counterparty, just with an extra qualifier appended.
function same_counterparty(a, b) {
  const x = name_key(a), y = name_key(b);
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export function find_reversal_pairs(rows, maxDays = DEFAULT_REVERSAL_MAX_DAYS, splitIds = new Set()) {
  const candidates = rows.filter(r => r.betrag_cents && !splitIds.has(tx_id(r)));
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
      if (other.betrag_cents !== -r.betrag_cents) continue;
      if (account_key(r) !== account_key(other)) continue;
      if (!same_counterparty(r, other)) continue;
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

export function apply_reversal_pairs(rows, pairs) {
  pairs.forEach(p => {
    [p.a, p.b].forEach(r => {
      r._cls = { ...(r._cls || {}), group: 'internal_transfer', excluded: true, source: 'reversal-detection' };
    });
    tag_merge_group([p.a, p.b], 'reversal');
  });
}


export function account_key(row) {
  return row._account || row.Kontoname || row.Account || row['Eigenes Konto'] || (row.source === 'manual' ? 'Manuell' : 'Konto unbekannt');
}
export function is_paypal_account(row) { return /paypal/i.test(account_key(row)); }
const funding = row => is_paypal_account(row) && /bank account|bankkonto|guthaben.*(ein|aus)zahlung/i.test(row.name || row.Name || '');
// Some banks never write the word "PayPal" anywhere on the settlement line -
// it just shows the underlying MERCHANT's name (e.g. "Decathlon
// Deutschland") because PayPal passes that through, with only two
// PayPal-specific technical markers left to go on:
// 1. PayPal (Europe) S.à r.l. et Cie, S.C.A.'s own, official, publicly
//    documented SEPA direct-debit creditor ID for ALL its EU collections -
//    "LU96ZZZ0000000000000000058" - unambiguous and never changes,
//    regardless of which merchant the underlying purchase was with.
// 2. PayPal's own documented 17-character transaction ID format (a digit
//    followed by 16 more upper-case letters/digits, e.g.
//    "1TW73003SD8960608"), which shows up on the OTHER (PayPal-account)
//    leg rather than the bank leg, but is checked here too in case a bank
//    passes it through instead of the Gläubiger-ID.
// Both are structural/official identifiers, not brand-name guesses, and
// are only ever used as a PRE-FILTER here - the actual pairing decision
// below still requires an exact amount match via pick_bundle() within
// maxDays, which is what actually prevents false positives.
const PAYPAL_SEPA_CREDITOR_ID = /lu96zzz0000000000000000058/i;
const PAYPAL_TX_ID = /\b\d[A-Z0-9]{16}\b/;
const settlement = row => {
  if (is_paypal_account(row)) return false;
  const text = `${row.name || row.Name || ''} ${row.verwendungszweck || ''}`;
  return /paypal/i.test(text) || PAYPAL_TX_ID.test(text) || PAYPAL_SEPA_CREDITOR_ID.test(text);
};

// A settlement line that could NOT be linked (no purchase export imported for
// that period) stays visible - but with the collector's legal name
// ("PayPal Europe S.a.r.l. et Cie S.C.A") it is unidentifiable. Its own text
// almost always carries the real merchant, just buried behind a booking
// reference ("1053077432981/. ALDI Nord , Ihr Einkauf bei ALDI Nord").
const REFERENCE_PREFIX = /^[\s\d/.:;#-]+/;
const clean_segment = value => String(value || '').split(',')[0].replace(REFERENCE_PREFIX, '').trim();

export function settlement_payee(row) {
  // Whichever segment does NOT itself look like a collector line is the
  // merchant - reuses settlement()'s own markers instead of a brand list.
  return [clean_segment(row.name || row.Name), clean_segment(row.verwendungszweck)]
    .find(segment => /\p{L}{3}/u.test(segment) && !settlement({ name: segment, verwendungszweck: '' })) || '';
}

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

// The settlement line usually repeats the merchant PayPal collected for
// ("... / ALDI Nord, Ihr Einkauf bei ALDI Nord"). Comparing the two rows'
// OWN texts is data-driven, not a brand list, and is only ever used to
// break a tie between equally-plausible same-amount candidates.
function counterparty_mentioned(purchase, bank) {
  const payee = name_key(purchase);
  if (payee.length < 4) return false;
  return text_key(`${bank.name || bank.Name || ''} ${bank.verwendungszweck || ''}`).includes(payee);
}

// One settlement almost always covers exactly ONE purchase; bundling several
// is the rare exception. Checking the single exact match FIRST matters: a
// week of PayPal purchases very often contains some other subset that also
// adds up to the same total (e.g. 20,00 + 14,43 = 34,43), which made
// unique_bundle() declare the whole thing ambiguous and leave the obvious
// 34,43 purchase unlinked - the reported bug.
function pick_bundle(candidates, bank) {
  const target = Math.abs(bank.betrag_cents);
  const exact = candidates.filter(r => Math.abs(r.betrag_cents) === target);
  if (exact.length === 1) return exact;
  if (exact.length > 1) {
    const named = exact.filter(r => counterparty_mentioned(r, bank));
    return named.length === 1 ? named : null;
  }
  return unique_bundle(candidates, target);
}
export function reconcile_paypal(rows, maxDays = 7, splitIds = new Set()) {
  rows.forEach(r => { delete r._effectiveAccount; delete r._paypalLinked; delete r._paypalUnmatched; delete r._displayName; });
  const eligible = r => !splitIds.has(tx_id(r)) && r._mergeGroup?.kind !== 'reversal';
  const purchases = rows.filter(r => is_paypal_account(r) && !funding(r) && r.betrag_cents && eligible(r));
  const used = new Set();
  const fundingLegs = rows.filter(r => funding(r) && eligible(r));
  fundingLegs.forEach(r => { r._cls = { ...r._cls, group: 'internal_transfer', excluded: true, source: 'paypal-funding' }; });
  const usedFunding = new Set();
  for (const bank of rows.filter(r => settlement(r) && eligible(r)).sort((a,b) => a.date-b.date)) {
    const candidates = purchases.filter(r => !used.has(r) && Math.sign(r.betrag_cents) === Math.sign(bank.betrag_cents) && days_between(r.date, bank.date) <= maxDays);
    const bundle = pick_bundle(candidates, bank);
    if (!bundle) {
      // A settlement rule alone is not evidence that the matching PayPal
      // export exists. Never silently discard a bank-only purchase.
      if (bank._cls?.group === 'internal_transfer') bank._cls = { category: 'Unkategorisiert', group: 'unclassified', excluded: false, source: 'paypal-unmatched' };
      bank._paypalUnmatched = true;
      bank._displayName = settlement_payee(bank) || undefined;
      continue;
    }
    const manualClassification = bank._cls?.source === 'manual' ? { ...bank._cls } : null;
    bank._cls = { ...bank._cls, excluded: true, group: 'internal_transfer', source: 'paypal-settlement' };
    bank._paypalLinked = true;
    for (const purchase of bundle) {
      if (bundle.length === 1 && manualClassification && purchase._cls?.source !== 'manual') {
        purchase._cls = { ...manualClassification, excluded: false };
        purchase._matchedManualId = bank._matchedManualId;
        purchase._matchedManualTxId = bank._matchedManualTxId;
      }
      used.add(purchase); purchase._effectiveAccount = account_key(bank); purchase._paypalLinked = true;
    }
    // The wallet top-up that funded exactly this purchase is the third leg of
    // the same real payment - group it too, so the UI shows one booking
    // instead of an unexplained plus/minus pair on the intermediary account.
    const total = bundle.reduce((sum, r) => sum + r.betrag_cents, 0);
    const topUp = fundingLegs.find(f => !usedFunding.has(f) && f.betrag_cents === -total
      && bundle.some(p => account_key(p) === account_key(f))
      && days_between(f.date, bank.date) <= maxDays);
    if (topUp) { usedFunding.add(topUp); topUp._paypalLinked = true; }
    tag_merge_group([bank, ...bundle, ...(topUp ? [topUp] : [])], 'paypal');
  }
  return rows;
}
