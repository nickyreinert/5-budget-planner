// Weekly allowance uses recurring salary minus current monthly contract costs.
// All other outgoing payments belong to budgets; other income stays in cashflow.
// Legacy reserve_monthly_cents remains available for historical reporting.

import { is_real_cashflow } from './data.js';
import { reporting_date } from './recurrence.js';

const DAY_MS = 86400000;
// Exported so the Settings > Budgets cap editor can offer only categories
// this weekly-budget model actually applies to (capping rent doesn't make
// sense here).
export const NON_WEEKLY_GROUPS = new Set(['fixed', 'income', 'internal_transfer']);
// Incoming money only reduces weekly spend if it is a classified refund;
// unclassified incoming money (private transfers, side income) is not.
const SALARY_PATTERN = /gehalt|\blohn\b|salary/i;
// Bookings to the same payee within ±15% of each other are treated as the
// same contract (covers price increases, separates e.g. two Google Play subs).
const AMOUNT_TOLERANCE = 0.15;

export function week_start(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return d;
}

export function add_days(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// ISO 8601: the week belongs to the year its Thursday falls into.
export function iso_week_number(monday) {
  const thursday = add_days(monday, 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  return 1 + Math.floor(Math.round((thursday - jan1) / DAY_MS) / 7);
}

function days_between(a, b) {
  return Math.round((b - a) / DAY_MS);
}

function latest_date(rows) {
  return rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date);
}

function earliest_date(rows) {
  return rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date);
}

export function salary_monthly_cents(rows) {
  const months = new Map();
  rows.filter(r => r.in_out === 'in' && is_real_cashflow(r) && r._cls?.group === 'income' &&
    (r._cls.incomeType === 'salary' || (!r._cls.incomeType && SALARY_PATTERN.test(r._cls.category)))).forEach(r => {
      const date = reporting_date(r);
      const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2, '0')}`;
      months.set(key, (months.get(key) || 0) + r.betrag_cents);
    });
  const last3 = [...months.entries()].sort(([a],[b]) => b.localeCompare(a)).slice(0,3).map(([,v]) => v).sort((a,b) => a-b);
  return last3.length ? last3[Math.floor(last3.length / 2)] : 0;
}

function payee_key(r) {
  if (r._cls?.contractId) return `contract:${r._cls.contractId}`;
  return `${r._cls?.category || ''}|${(r.name || '').trim().toLowerCase()}`;
}

// Median gap between bookings (same-day duplicates ignored) mapped to a
// payment interval in months, or null if there is no gap to measure.
export function interval_months(dates) {
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    const gap = days_between(dates[i - 1], dates[i]);
    if (gap > 7) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median < 45) return 1;
  if (median < 120) return 3;
  if (median < 240) return 6;
  return 12;
}

// All contracts (payee + amount cluster) of the 'fixed' group that are
// still running at `refDate`, each with its monthly equivalent.
export function active_contracts(rows, refDate) {
  const clusters = cluster_by_payee(rows.filter(r => r.in_out === 'out' && is_real_cashflow(r) && r._cls && r._cls.group === 'fixed'));

  return clusters
    .map(c => {
      const latest = c.rows[0];
      const months = latest._cls?.recurring?.intervalMonths || interval_months(c.rows.map(r => r.date).reverse());
      if (months === null) return null;
      return {
        name: latest._cls?.contractName || latest.name || '(ohne Namen)',
        category: latest._cls.category,
        months,
        amountCents: c.latestCents,
        monthlyCents: Math.round(c.latestCents / months),
        lastDate: latest.date
      };
    })
    .filter(c => c && days_between(c.lastDate, refDate) <= c.months * 30.44 * 1.5 + 30)
    .sort((a, b) => b.monthlyCents - a.monthlyCents);
}

// Groups rows by payee name + broadly similar amount (see AMOUNT_TOLERANCE),
// most-recent-first within each cluster - shared by active_contracts() above
// and rule_monthly_equivalent() below. `keyFn` lets callers scope the
// cluster key further (active_contracts also folds in the category, since
// the same payee name could in theory recur under a different one).
export function cluster_by_payee(rows, keyFn = payee_key) {
  const byKey = {};
  [...rows].sort((a, b) => b.date - a.date).forEach(r => {
    const clusters = byKey[keyFn(r)] = byKey[keyFn(r)] || [];
    const amount = Math.abs(r.betrag_cents);
    const cluster = clusters.find(c => Math.abs(amount - c.latestCents) <= c.latestCents * AMOUNT_TOLERANCE);
    if (cluster) cluster.rows.push(r);
    else clusters.push({ latestCents: amount, rows: [r] });
  });
  return Object.values(byKey).flat();
}

// Monthly-equivalent for one Fix Expense/Income rule's matches, clustered by
// payee (name + amount) so a category mixing different billing rhythms
// (e.g. one monthly and one annual insurance policy under "Versicherungen")
// isn't flattened into a single misleading average - each cluster gets its
// own detected (or manually overridden) interval, then contributes
// amount/interval, not a raw sum. `overrides` is an optional
// { payeeName: intervalMonths } manual map (Settings > Fix Expense/Income)
// that wins over auto-detection from the booking dates. Rows already tied
// together by a manual contract merge (rule.contractMerges, e.g. a PayPal
// settlement leg + the actual merchant charge it pays for) cluster by that
// shared contractId instead of by name, so they count as ONE expense.
export function rule_monthly_equivalent(rows, overrides = {}) {
  const clusters = cluster_by_payee(rows, r => r._cls?.contractId ? `contract:${r._cls.contractId}` : (r.name || '').trim().toLowerCase());
  const items = clusters.map(c => {
    const latest = c.rows[0];
    const payee = (latest.name || '').trim().toLowerCase();
    const autoMonths = interval_months(c.rows.map(r => r.date).reverse()) || 1;
    const months = overrides[payee] || autoMonths;
    return {
      payee,
      name: latest._cls?.contractName || latest.name || '(ohne Namen)',
      months,
      autoMonths,
      amountCents: c.latestCents,
      monthlyCents: Math.round(c.latestCents / months),
      lastDate: latest.date,
      rows: c.rows
    };
  }).sort((a, b) => b.lastDate - a.lastDate);
  return { totalCents: items.reduce((sum, c) => sum + c.monthlyCents, 0), clusters: items };
}

// Net 'reserve' spend over the last 12 months (or less if the data is
// shorter), as a monthly average.
export function reserve_monthly_cents(rows, refDate) {
  const spanDays = Math.min(365, days_between(earliest_date(rows), refDate));
  if (spanDays <= 0) return 0;
  const from = add_days(refDate, -spanDays);
  const netCents = rows
    .filter(r => is_real_cashflow(r) && r._cls && r._cls.group === 'reserve' && r.date > from && r.date <= refDate)
    .reduce((sum, r) => sum - r.betrag_cents, 0);
  return Math.max(0, Math.round(netCents / (spanDays / 30.44)));
}

// "As of" date for the whole basis calculation - in particular, the anchor
// active_contracts()/reserve_monthly_cents() use to decide whether a
// contract has ended. Deliberately the latest date among salary/fixed/
// reserve rows only, NOT the latest row overall: quick-entry (manual)
// spend is always dated "today" regardless of how stale the last CSV
// import is, and would otherwise drag refDate forward past every real
// contract's last payment, making every one of them look "ended".
const BANK_DATA_GROUPS = new Set(['income', 'fixed', 'reserve']);
function bank_data_ref_date(rows) {
  const bankRows = rows.filter(r => BANK_DATA_GROUPS.has(r._cls && r._cls.group));
  return bankRows.length ? latest_date(bankRows) : latest_date(rows);
}

export function build_budget_basis(rows) {
  if (!rows.length) return { refDate: new Date(), salaryCents: 0, contracts: [], fixedCents: 0, reserveCents: 0, freeCents: 0, weeklyCents: 0 };
  const refDate = bank_data_ref_date(rows);
  const salaryCents = salary_monthly_cents(rows);
  const contracts = active_contracts(rows, refDate);
  const fixedCents = contracts.reduce((sum, c) => sum + c.monthlyCents, 0);
  const reserveCents = 0; // Non-recurring spending is tracked in budgets, not deducted twice.
  const freeCents = salaryCents - fixedCents - reserveCents;
  return {
    refDate,
    salaryCents,
    contracts,
    fixedCents,
    reserveCents,
    freeCents,
    weeklyCents: Math.round(freeCents * 12 / 52)
  };
}

// Weekly spend per category for the week starting at `monday`. Spend paid
// from reserves is reported separately and not counted against the budget.
export function build_week_report(rows, monday) {
  const end = add_days(monday, 7);
  const byCategory = {};
  let reserveCents = 0;
  rows.forEach(r => {
    if (!is_real_cashflow(r) || r.date < monday || r.date >= end) return;
    const group = (r._cls && r._cls.group) || 'unclassified';

    if (NON_WEEKLY_GROUPS.has(group)) return;
    if (r.in_out === 'in') return; // Other income never increases the weekly allowance.
    const category = (r._cls && r._cls.category) || 'Unklassifiziert';
    const entry = byCategory[category] = byCategory[category] || { category, group, cents: 0, rows: [] };
    entry.cents -= r.betrag_cents;
    entry.rows.push(r);
  });
  const categories = Object.values(byCategory).sort((a, b) => b.cents - a.cents);
  categories.forEach(c => c.rows.sort((a, b) => a.date - b.date));
  return {
    categories,
    spentCents: categories.reduce((sum, c) => sum + c.cents, 0),
    reserveCents
  };
}

// The curated "sub-budgets" list shown on the Week tab: one row per MAIN
// budget category the user has given a weekly cap (see src/budgets.js) -
// uncapped ones are deliberately left out, that's what keeps this list
// short. Many fine-grained transaction categories (see ruleSet.rules[].
// category) can share one main category (ruleSet.mainCategories) - caps are
// set and tracked at that coarser level, since a handful of "main" budgets
// is what's actually manageable, not one per transaction category.
// `categoryToMain(leafCategory)` maps a transaction category to its main
// category id; if omitted (or a leaf category has no mapping), the leaf
// category name is used as its own bucket, so this still degrades
// gracefully to the old one-cap-per-category behaviour. Reuses
// build_week_report for the actual spend numbers rather than re-deriving
// them. Sorted by how much of the cap is used, so the tightest/most-over-
// budget mains surface first.
export function build_sub_budget_report(rows, monday, caps, categoryToMain) {
  const { categories } = build_week_report(rows, monday);
  const spentByMain = {};
  categories.forEach(c => {
    const main = (categoryToMain && categoryToMain(c.category)) || c.category;
    spentByMain[main] = (spentByMain[main] || 0) + c.cents;
  });
  return Object.entries(caps)
    .filter(([, capCents]) => capCents > 0)
    .map(([category, capCents]) => {
      const spentCents = spentByMain[category] || 0;
      return {
        category,
        capCents,
        spentCents,
        remainingCents: capCents - spentCents,
        pct: Math.min(100, (spentCents / capCents) * 100)
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

// The categories the quick-entry sheet offers as one-tap buttons: whichever
// categories the weekly budget actually applies to (same NON_WEEKLY_GROUPS
// exclusion as build_week_report - no point offering a quick button for a
// fixed contract or a reserve), ranked by how often they were booked since
// `sinceDate` so the buttons track recent habits rather than all-time totals.
export function top_categories(rows, sinceDate, n) {
  const counts = {};
  rows.forEach(r => {
    if (r.in_out !== 'out' || !is_real_cashflow(r) || r.date < sinceDate) return;
    const group = (r._cls && r._cls.group) || 'unclassified';
    if (NON_WEEKLY_GROUPS.has(group)) return;
    const category = (r._cls && r._cls.category) || 'Unklassifiziert';
    counts[category] = (counts[category] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([category]) => category);
}

// Main budgets summarize the same weekly transactions as the overall total.
// Keep zero-spend budgets visible; keep unmapped spend visible in its own row.
export function build_main_budget_report(rows, monday, mains, caps, categoryToMain) {
  const { categories } = build_week_report(rows, monday);
  const buckets = mains.map(m => ({ ...m, capCents: caps[m.id] || 0, categories: [] }));
  const unassigned = { id: '__unassigned', label: 'Nicht zugeordnet', capCents: 0, categories: [] };
  categories.forEach(c => {
    const bucket = buckets.find(m => m.id === categoryToMain(c.category)) || unassigned;
    bucket.categories.push(c);
  });
  buckets.push(unassigned);
  return buckets.map(m => {
    const spentCents = m.categories.reduce((sum, c) => sum + c.cents, 0);
    return { ...m, spentCents, remainingCents: m.capCents - spentCents,
      pct: m.capCents ? Math.max(0, Math.min(100, spentCents / m.capCents * 100)) : 0,
      rows: m.categories.flatMap(c => c.rows).sort((a, b) => b.date - a.date) };
  });
}

export function category_color(category) {
  let hash = 0;
  for (const char of category) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360} 58% 42%)`;
}
