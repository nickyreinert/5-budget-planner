// Recurring bookings keep their bank date, but may receive a derived
// reporting date when a delayed/early settlement straddles a period boundary.
// This prevents one billing period being counted twice without changing the
// underlying ledger. Automatic moves are deliberately conservative; callers
// can always supply a transaction-id keyed manual date override.

import { tx_id } from './data.js';
import { add_days, week_start } from './week.js';

const DAY_MS = 86400000;
const AMOUNT_TOLERANCE = 0.15;

export function reporting_date(row) {
  return row._effectiveDate || row.date;
}

function date_from_iso(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function day_gap(a, b) {
  return Math.round((b - a) / DAY_MS);
}

function recurrence_candidate(row) {
  const cls = row._cls || {};
  return cls.group === 'fixed' || (cls.group === 'income' && (cls.incomeType === 'salary' || cls.recurring));
}

function contract_key(row) {
  const cls = row._cls || {};
  if (cls.contractId) return `contract:${cls.contractId}`;
  return `rule:${cls.ruleId || cls.category || ''}|payee:${String(row.name || '').trim().toLocaleLowerCase()}`;
}

// Like the contract calculation, keep differently priced subscriptions from
// the same payee apart. A modest price change remains in the same cluster.
function recurring_clusters(rows) {
  const byContract = new Map();
  rows.filter(recurrence_candidate).forEach(row => {
    const key = contract_key(row);
    if (!byContract.has(key)) byContract.set(key, []);
    byContract.get(key).push(row);
  });
  return [...byContract.values()].flatMap(group => {
    const clusters = [];
    [...group].sort((a, b) => b.date - a.date).forEach(row => {
      const amount = Math.abs(row.betrag_cents || 0);
      const cluster = clusters.find(item => Math.abs(amount - item.amount) <= item.amount * AMOUNT_TOLERANCE);
      if (cluster) cluster.rows.push(row);
      else clusters.push({ amount, rows: [row] });
    });
    return clusters.map(cluster => cluster.rows);
  });
}

function frequency_for(rows) {
  const explicitDays = rows.map(row => Number(row._cls?.recurring?.intervalDays)).find(days => Number.isFinite(days) && days >= 7);
  if (explicitDays) return explicitDays % 7 === 0 ? { kind: 'week', weeks: Math.max(1, Math.round(explicitDays / 7)) } : null;
  const explicitMonths = rows.map(row => Number(row._cls?.recurring?.intervalMonths)).find(months => [1, 3, 6, 12].includes(months));
  if (explicitMonths) return { kind: 'calendar', months: explicitMonths };

  // Infer only with a stable enough history. One-off income/refunds must
  // never be moved merely because they happen near a boundary.
  if (rows.length < 3) return null;
  const dates = [...new Set(rows.map(row => +row.date))].sort((a, b) => a - b).map(value => new Date(value));
  const gaps = dates.slice(1).map((date, index) => day_gap(dates[index], date)).filter(gap => gap >= 2);
  const gap = median(gaps);
  if (gap >= 5 && gap <= 10) return { kind: 'week', weeks: 1 };
  if (gap >= 20 && gap <= 45) return { kind: 'calendar', months: 1 };
  if (gap >= 70 && gap <= 110) return { kind: 'calendar', months: 3 };
  if (gap >= 150 && gap <= 220) return { kind: 'calendar', months: 6 };
  if (gap >= 300 && gap <= 430) return { kind: 'calendar', months: 12 };
  return null;
}

function date_in_month(monthIndex, day) {
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

function apply_calendar_corrections(rows, months, manualIds) {
  // A late-period schedule (rent on the 30th, for example) can have a lone
  // delayed debit on the 1st plus the regular debit later in the same cycle.
  // Moving the first one back is safe only when the previous expected cycle
  // is otherwise empty and enough history establishes a late-month anchor.
  if (rows.length < 3) return;
  const anchorDay = median(rows.map(row => row.date.getDate()).filter(day => day >= 10));
  if (!anchorDay || anchorDay < 15) return;
  const buckets = new Map();
  rows.forEach(row => {
    const index = Math.floor((row.date.getFullYear() * 12 + row.date.getMonth()) / months);
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push(row);
  });
  buckets.forEach((entries, cycle) => {
    if (entries.length < 2 || buckets.has(cycle - 1)) return;
    const early = entries.filter(row => row.date.getDate() <= 5 && !manualIds.has(tx_id(row))).sort((a, b) => a.date - b.date)[0];
    const regular = entries.some(row => row !== early && row.date.getDate() >= Math.max(15, anchorDay - 7));
    if (!early || !regular) return;
    // The terminal month of the preceding calendar cycle handles monthly,
    // quarterly, half-yearly and annual boundaries (including February).
    early._effectiveDate = date_in_month(cycle * months - 1, anchorDay);
    early._effectiveDateSource = 'automatic';
  });
}

function monday_weekday(date) {
  return (date.getDay() + 6) % 7; // Monday=0 … Sunday=6
}

function apply_weekly_corrections(rows, weeks, manualIds) {
  if (rows.length < 3) return;
  const anchorDay = median(rows.map(row => monday_weekday(row.date)).filter(day => day >= 3));
  // Only a clearly late-week schedule is safely distinguishable from a
  // genuine second weekly booking near the start of a week.
  if (anchorDay === null || anchorDay < 4) return;
  const buckets = new Map();
  rows.forEach(row => {
    const key = Math.floor(+week_start(row.date) / DAY_MS / weeks);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  });
  buckets.forEach((entries, cycle) => {
    if (entries.length < 2 || buckets.has(cycle - 1)) return;
    const early = entries.filter(row => monday_weekday(row.date) <= 1 && !manualIds.has(tx_id(row))).sort((a, b) => a.date - b.date)[0];
    const regular = entries.some(row => row !== early && monday_weekday(row.date) >= Math.max(3, anchorDay - 1));
    if (!early || !regular) return;
    early._effectiveDate = add_days(week_start(early.date), -7 * weeks + anchorDay);
    early._effectiveDateSource = 'automatic';
  });
}

// Mutates only derived `_effectiveDate` fields. `overrides` maps a
// transaction id to an explicit YYYY-MM-DD reporting date and always wins.
export function apply_effective_periods(rows, overrides = {}) {
  const manualIds = new Set();
  rows.forEach(row => {
    const override = date_from_iso(overrides[tx_id(row)]);
    row._effectiveDate = override || new Date(row.date);
    row._effectiveDateSource = override ? 'manual' : 'booked';
    if (override) manualIds.add(tx_id(row));
  });
  recurring_clusters(rows).forEach(cluster => {
    const frequency = frequency_for(cluster);
    if (!frequency) return;
    if (frequency.kind === 'week') apply_weekly_corrections(cluster, frequency.weeks, manualIds);
    else apply_calendar_corrections(cluster, frequency.months, manualIds);
  });
  return rows;
}
