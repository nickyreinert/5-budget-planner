// --- data.js ---
import { parse_csv_rows, default_csv_config } from './csv_config.js';

export let data = [];
export let filtered_data = [];
export let current_path = [];

// `config` follows the shape of csv_config.js's default_csv_config(); if
// omitted, the classic MoneyMoney/DKB defaults are used (";" delimiter,
// German decimal comma, fixed Datum/Name/Verwendungszweck/Betrag/Kategorie
// header names).
// Derives the fields every row needs regardless of where it came from (a
// parsed CSV line, or a manually logged quick-entry spend built to look like
// one - see src/db.js's manualEntries store): parsed date, integer cents,
// lowercase mirrors for regex matching. Mutates and returns `obj`.
export function enrich_row(obj) {
  obj.date = parse_date(obj.Datum);
  obj.categories = obj.Kategorie ? obj.Kategorie.split(' - ') : ['Other'];
  // Betrag is already normalized to "1234.56" form by parse_csv_rows
  obj.in_out = parseFloat(obj.Betrag || '0') > 0 ? 'in' : 'out';
  // store amounts as integer cents to avoid floating point accumulation
  const parsed = Math.round(parseFloat(obj.Betrag || '0') * 100);
  obj.betrag_cents = Number.isNaN(parsed) ? 0 : parsed;
  // Store name and verwendungszweck for regex matching
  obj.name = obj.Name || '';
  obj.verwendungszweck = obj.Verwendungszweck || '';
  return obj;
}

export function parse_csv(csv, config) {
  const cfg = config || default_csv_config();
  const rows = parse_csv_rows(csv, cfg);
  data = rows.map(enrich_row);
  filtered_data = [...data];
}

export function parse_date(s) {
  const [d,m,y] = (s||'01.01.1970').split('.');
  return new Date(y, m-1, d);
}

// Stable identifier for a transaction row, used as the IndexedDB key for
// manual category overrides (see db.js). Datum+Name+Verwendungszweck+cents
// is unique enough in practice since bank exports embed a per-booking
// Referenz inside Verwendungszweck.
export function tx_id(r) {
  if (r._txId) return r._txId;
  return `${r.Datum}|${r.Name}|${r.Verwendungszweck}|${r._originalAmountCents ?? r.betrag_cents}`;
}

// Rows classified (via rules.js classify_all) as excludeFromTotals are
// internal transfers (e.g. PayPal wallet funding legs) that have zero real
// cashflow impact — the actual expense/income already shows up as its own
// transaction elsewhere. They must be excluded from every sum, otherwise
// income and expenses both get inflated by the same internal amount.
export function is_real_cashflow(r) {
  return !(r._cls && r._cls.excluded);
}

// The whole app drills through one shared 3-level expense tree, built from
// the rule-engine classification rather than the raw bank Kategorie split
// (that split has "AUSGABEN", "Paypal", "Other" etc. as unrelated top-level
// siblings, since Paypal-Kategorie rows are literally "Paypal" with no
// "AUSGABEN -" prefix and blank ones fall back to "Other" — nonsensical for
// browsing "where does my money go", since PayPal is a payment method, not
// a spending category). A `path` is always a prefix of:
//   ['Ausgaben', <group id>, <category>]
// path.length 0 = every real-cashflow expense; 1 = one group's rows; 2 =
// one category's rows within a group. Categories are leaves - nothing to
// drill into beyond path.length 2.
export function expense_matches_path(r, path) {
  if (path.length >= 2 && ((r._cls && r._cls.group) || 'unclassified') !== path[1]) return false;
  if (path.length >= 3 && ((r._cls && r._cls.category) || 'Unklassifiziert') !== path[2]) return false;
  return true;
}

// The key identifying which node a row falls into at the *next* level below
// `path` (i.e. what current_path.push(...) should receive on a click).
function expense_child_key(r, path) {
  if (path.length === 0) return 'Ausgaben';
  if (path.length === 1) return (r._cls && r._cls.group) || 'unclassified';
  return (r._cls && r._cls.category) || 'Unklassifiziert';
}

export function group_data(rows, currentPath) {
  const out = {};
  const inData = {};

  // For expenses (out) - apply filtering based on mode
  let filteredOut = rows.filter(r => r.in_out === 'out' && is_real_cashflow(r));

  if (currentPath.length > 0) {
    filteredOut = filteredOut.filter(r => expense_matches_path(r, currentPath));
  }

  filteredOut.forEach(r => {
    const key = `${r.date.getFullYear()}-${String(r.date.getMonth()+1).padStart(2,'0')}`;
    const cat = expense_child_key(r, currentPath);
    out[key] = out[key] || {};
    out[key][cat] = (out[key][cat] || 0) + Math.abs(r.betrag_cents);
  });

  // For income (in) always aggregate from all rows provided (year-filtered), ignore current_path
  rows.forEach(r => {
    if (r.in_out === 'in' && is_real_cashflow(r)) {
      const key = `${r.date.getFullYear()}-${String(r.date.getMonth()+1).padStart(2,'0')}`;
      inData[key] = (inData[key] || 0) + r.betrag_cents;
    }
  });

  return { out, in: inData };
}

export function calculate_monthly_averages(rows) {
  const monthStats = Array(12).fill(0).map(() => ({ in: 0, out: 0 }));
  let totalIn = 0;
  let totalOut = 0;

  // Calculate date range to determine divisor for each month
  if (rows.length === 0) return { monthlyAverages: [], globalAverage: { in: 0, out: 0 } };

  // Sort by date to find min/max
  const sorted = [...rows].sort((a,b) => a.date - b.date);
  const minDate = sorted[0].date;
  const maxDate = sorted[sorted.length - 1].date;

  // Count how many times each month index actually occurred in the timespan
  const monthCounts = Array(12).fill(0);
  let curr = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  const end = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);

  let totalMonths = 0;
  while (curr <= end) {
    monthCounts[curr.getMonth()]++;
    totalMonths++;
    curr.setMonth(curr.getMonth() + 1);
  }

  rows.forEach(r => {
    if (!is_real_cashflow(r)) return;
    const m = r.date.getMonth();
    if (r.in_out === 'in') {
      monthStats[m].in += r.betrag_cents;
      totalIn += r.betrag_cents;
    } else {
      monthStats[m].out += Math.abs(r.betrag_cents);
      totalOut += Math.abs(r.betrag_cents);
    }
  });

  const monthlyAverages = monthStats.map((stat, idx) => ({
    in: monthCounts[idx] ? (stat.in / monthCounts[idx]) : 0,
    out: monthCounts[idx] ? (stat.out / monthCounts[idx]) : 0
  }));

  const globalAverage = {
    in: totalMonths ? (totalIn / totalMonths) : 0,
    out: totalMonths ? (totalOut / totalMonths) : 0
  };

  return { monthlyAverages, globalAverage };
}

// Monthly average of a single classified category (e.g. the "fixed" group
// total, or one leak category), for overlaying as a reference line on the
// combined chart. `matchGroupOrCategory` is compared against r._cls.group
// and r._cls.category.
export function calculate_classified_average(rows, matchGroupOrCategory) {
  if (!matchGroupOrCategory) return null;

  const matching = rows.filter(r => r.in_out === 'out' && is_real_cashflow(r) &&
    r._cls && (r._cls.group === matchGroupOrCategory || r._cls.category === matchGroupOrCategory));

  if (matching.length === 0) return null;

  const allMonths = new Set();
  rows.forEach(r => {
    const key = `${r.date.getFullYear()}-${String(r.date.getMonth()+1).padStart(2,'0')}`;
    allMonths.add(key);
  });

  const monthCount = allMonths.size;
  if (monthCount === 0) return null;

  const total = matching.reduce((sum, r) => sum + Math.abs(r.betrag_cents), 0);
  const monthlyAvgEuros = (total / monthCount) / 100;

  const avgData = {};
  allMonths.forEach(month => { avgData[month] = monthlyAvgEuros; });
  return avgData;
}

// Ranks classified spending categories by total amount ("wo fließt das
// Geld hin") for the given rows (already date/year filtered by the caller).
// Requires classify_all(rows, ruleSet) to have been called first so each
// row carries r._cls.
export function build_leak_report(rows) {
  const byCategory = {};
  rows.forEach(r => {
    if (r.in_out !== 'out' || !is_real_cashflow(r)) return;
    const cls = r._cls || { category: 'Unklassifiziert', group: 'unclassified' };
    const key = cls.category;
    byCategory[key] = byCategory[key] || { category: key, group: cls.group, cents: 0, count: 0 };
    byCategory[key].cents += Math.abs(r.betrag_cents);
    byCategory[key].count += 1;
  });
  return Object.values(byCategory).sort((a, b) => b.cents - a.cents);
}

// Sums expenses per top-level group (fixed / essential / discretionary /
// unclassified / ...) plus total income, so the UI can show a savings-rate
// style overview ("Fixkosten vs. frei verfügbares Geld vs. Sparen").
export function build_group_summary(rows) {
  const byGroup = {};
  let totalIncome = 0;
  rows.forEach(r => {
    if (!is_real_cashflow(r)) return;
    if (r.in_out === 'in') {
      totalIncome += r.betrag_cents;
      return;
    }
    const cls = r._cls || { group: 'unclassified' };
    byGroup[cls.group] = (byGroup[cls.group] || 0) + Math.abs(r.betrag_cents);
  });
  const totalExpenses = Object.values(byGroup).reduce((a, b) => a + b, 0);
  return { byGroup, totalIncome, totalExpenses, net: totalIncome - totalExpenses };
}

// Aggregates the still-unclassified expenses (group === 'unclassified') by
// counterparty name, so an LLM (or a human) can review a short, dense list
// instead of thousands of raw rows and propose new/extended rules for the
// biggest gaps first. Expense-only by design — income ("Lohn") doesn't need
// per-transaction classification.
export function build_unclassified_report(rows) {
  const byName = {};
  rows.forEach(r => {
    if (r.in_out !== 'out' || !is_real_cashflow(r)) return;
    const cls = r._cls || { group: 'unclassified' };
    if (cls.group !== 'unclassified') return;
    const key = r.name || '(ohne Namen)';
    if (!byName[key]) {
      byName[key] = {
        name: key,
        count: 0,
        totalCents: 0,
        dateFrom: r.date,
        dateTo: r.date,
        bankKategorien: new Set(),
        sampleVerwendungszweck: new Set()
      };
    }
    const entry = byName[key];
    entry.count += 1;
    entry.totalCents += Math.abs(r.betrag_cents);
    if (r.date < entry.dateFrom) entry.dateFrom = r.date;
    if (r.date > entry.dateTo) entry.dateTo = r.date;
    if (r.Kategorie) entry.bankKategorien.add(r.Kategorie);
    if (entry.sampleVerwendungszweck.size < 3 && r.verwendungszweck) {
      entry.sampleVerwendungszweck.add(r.verwendungszweck.slice(0, 140));
    }
  });

  const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return Object.values(byName)
    .map(e => ({
      name: e.name,
      count: e.count,
      totalEUR: round2(e.totalCents / 100),
      dateFrom: fmtDate(e.dateFrom),
      dateTo: fmtDate(e.dateTo),
      bankKategorien: [...e.bankKategorien],
      sampleVerwendungszweck: [...e.sampleVerwendungszweck]
    }))
    .sort((a, b) => b.totalEUR - a.totalEUR);
}

export function reset_state() { current_path = []; localStorage.removeItem('currentPath'); }

function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

// Local amount edits preserve the original identity so category overrides and
// edits survive reloads and re-importing the same bank file.
export function apply_amount_overrides(rows, amounts) {
  rows.forEach(row => {
    const legacyId = tx_id({ ...row, _txId: undefined });
    const value = amounts[tx_id(row)] ?? amounts[row._matchedManualTxId] ?? amounts[legacyId];
    if (!Number.isSafeInteger(value)) return;
    row._originalAmountCents ??= row.betrag_cents;
    row.betrag_cents = value;
    row.Betrag = (value / 100).toFixed(2);
    row.in_out = value > 0 ? 'in' : 'out';
  });
  return rows;
}

// Local note (Verwendungszweck) edits - also feeds rule matching, since
// rules.js reads the same verwendungszweck/Verwendungszweck fields.
export function apply_note_overrides(rows, notes) {
  rows.forEach(row => {
    const legacyId = tx_id({ ...row, _txId: undefined });
    const value = notes[tx_id(row)] ?? notes[row._matchedManualTxId] ?? notes[legacyId];
    if (value === undefined) return;
    row._originalVerwendungszweck ??= row.verwendungszweck;
    row.verwendungszweck = value;
    row.Verwendungszweck = value;
  });
  return rows;
}

// Local date edits, stored as "YYYY-MM-DD" strings - only `date` (the Date
// object every grouping/sorting computation actually reads) is touched;
// the original Datum stays untouched since it (or tx_id) is the storage key.
export function apply_date_overrides(rows, dates) {
  rows.forEach(row => {
    const legacyId = tx_id({ ...row, _txId: undefined });
    const value = dates[tx_id(row)] ?? dates[row._matchedManualTxId] ?? dates[legacyId];
    if (!value) return;
    const [y, m, d] = value.split('-').map(Number);
    if (!y || !m || !d) return;
    row._originalDate ??= row.date;
    row.date = new Date(y, m - 1, d);
  });
  return rows;
}
