// Run: node --test tests/week.test.mjs   (Node >= 22 auto-detects ES module syntax)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  week_start, iso_week_number, interval_months, salary_monthly_cents,
  active_contracts, reserve_monthly_cents, build_week_report, top_categories,
  build_budget_basis, build_sub_budget_report
} from '../src/week.js';

const tx = (date, cents, name, group, category = 'X') => ({
  date: new Date(date), betrag_cents: cents, in_out: cents > 0 ? 'in' : 'out', name,
  _cls: { group, category, excluded: false }
});

test('weeks start on Monday, Sunday belongs to the previous week', () => {
  assert.equal(week_start(new Date(2026, 8, 14)).getDate(), 14); // Mo
  assert.equal(week_start(new Date(2026, 8, 20)).getDate(), 14); // So
  assert.equal(week_start(new Date(2026, 8, 21)).getDate(), 21);
});

test('ISO week numbers', () => {
  assert.equal(iso_week_number(new Date(2026, 8, 14)), 38);
  assert.equal(iso_week_number(new Date(2025, 11, 29)), 1);  // KW 1/2026
  assert.equal(iso_week_number(new Date(2020, 11, 28)), 53);
});

test('interval from median gap, null without a measurable gap', () => {
  const d = s => new Date(s);
  assert.equal(interval_months([d('2026-01-01'), d('2026-02-01'), d('2026-03-02')]), 1);
  assert.equal(interval_months([d('2025-12-15'), d('2026-03-16'), d('2026-06-15')]), 3);
  assert.equal(interval_months([d('2024-09-02'), d('2025-09-01')]), 12);
  assert.equal(interval_months([d('2026-04-05'), d('2026-04-05')]), null);
  assert.equal(interval_months([d('2026-04-05')]), null);
});

test('salary: median of last 3 salary bookings ignores a bonus and side income', () => {
  const rows = [
    tx('2026-06-26', 344668, 'VML', 'income', 'Gehalt'),
    tx('2026-07-23', 37400, 'VML', 'income', 'Gehalt'),
    tx('2026-07-27', 344668, 'VML', 'income', 'Gehalt'),
    tx('2026-08-26', 344668, 'VML', 'income', 'Gehalt'),
    tx('2026-08-28', 170000, 'Pegel', 'income', 'Sonstige')
  ];
  assert.equal(salary_monthly_cents(rows), 344668);
});

test('contracts: latest price counts, one-offs and ended contracts do not', () => {
  const ref = new Date('2026-09-19');
  const rows = [
    // rent with price increase -> one contract, latest amount
    tx('2026-06-30', -121005, 'Berlin Towers', 'fixed'),
    tx('2026-07-30', -121005, 'Berlin Towers', 'fixed'),
    tx('2026-05-30', -118005, 'Berlin Towers', 'fixed'),
    // one-off in the same group -> not a contract
    tx('2025-12-04', -35227, 'Berlin Towers', 'fixed'),
    // yearly
    tx('2025-09-01', -26475, 'ARAG SE', 'fixed'),
    tx('2026-09-01', -27798, 'ARAG SE', 'fixed'),
    // two subscriptions at the same payee -> two contracts
    tx('2026-07-29', -1799, 'Google', 'fixed'), tx('2026-08-26', -1799, 'Google', 'fixed'),
    tx('2026-07-31', -2200, 'Google', 'fixed'), tx('2026-08-28', -2200, 'Google', 'fixed'),
    // ended monthly contract
    tx('2025-06-02', -5300, 'Kita', 'fixed'), tx('2025-07-01', -5300, 'Kita', 'fixed')
  ];
  const monthly = active_contracts(rows, ref).map(c => [c.name, c.monthlyCents]);
  assert.deepEqual(monthly, [['Berlin Towers', 121005], ['ARAG SE', 2317], ['Google', 2200], ['Google', 1799]]);
});

test('reserve: net 12-month average', () => {
  const ref = new Date('2026-09-01');
  const rows = [
    tx('2025-08-01', -100000, 'alt', 'reserve'),   // older than 12 months
    tx('2025-10-01', -120000, 'Urlaub', 'reserve'),
    tx('2026-03-01', -24000, 'IKEA', 'reserve'),
    tx('2026-03-10', 4000, 'IKEA', 'reserve')        // refund
  ];
  assert.equal(reserve_monthly_cents(rows, ref), Math.round(140000 / (365 / 30.44)));
});

test('week report: all non-recurring spend counts; other income does not increase allowance', () => {
  const rows = [
    tx('2026-09-14', -3443, 'ALDI', 'essential', 'Supermarkt'),
    tx('2026-09-16', -2726, 'McDonalds', 'discretionary', 'Restaurants'),
    tx('2026-09-17', 1000, 'ALDI', 'essential', 'Supermarkt'),        // refund
    tx('2026-09-15', -9696, 'Decathlon', 'unclassified', 'Paypal'),
    tx('2026-09-15', 50000, 'Privat', 'unclassified', 'Paypal'),        // not a refund
    tx('2026-09-18', -30000, 'Booking', 'reserve', 'Urlaub'),
    tx('2026-09-15', -121005, 'Miete', 'fixed', 'Miete'),
    tx('2026-09-21', -5000, 'Next week', 'essential', 'Supermarkt')
  ];
  const w = build_week_report(rows, week_start(new Date(2026, 8, 16)));
  assert.equal(w.spentCents, 3443 + 2726 + 9696 + 30000);
  assert.equal(w.reserveCents, 0);
  assert.deepEqual(w.categories.map(c => c.category), ['Urlaub', 'Paypal', 'Supermarkt', 'Restaurants']);
});

test('top_categories: ranks by count, excludes fixed/income, respects sinceDate and n', () => {
  const rows = [
    tx('2026-09-01', -1000, 'ALDI', 'essential', 'Supermarkt'),
    tx('2026-09-03', -1200, 'ALDI', 'essential', 'Supermarkt'),
    tx('2026-09-05', -1500, 'ALDI', 'essential', 'Supermarkt'),
    tx('2026-09-06', -800, 'McDonalds', 'discretionary', 'Restaurants'),
    tx('2026-09-07', -900, 'McDonalds', 'discretionary', 'Restaurants'),
    tx('2026-09-08', -500, 'Kino', 'discretionary', 'Freizeit'),
    tx('2026-09-09', -121005, 'Miete', 'fixed', 'Miete'),         // excluded: fixed
    tx('2026-09-10', -30000, 'Booking', 'reserve', 'Urlaub'),     // excluded: reserve
    tx('2026-09-11', 344668, 'VML', 'income', 'Gehalt'),          // excluded: income
    tx('2025-01-01', -2000, 'ALDI', 'essential', 'Supermarkt')    // excluded: before sinceDate
  ];
  assert.deepEqual(
    top_categories(rows, new Date(2026, 0, 1), 2),
    ['Supermarkt', 'Restaurants']
  );
  assert.deepEqual(
    top_categories(rows, new Date(2026, 0, 1), 10),
    ['Supermarkt', 'Restaurants', 'Freizeit', 'Urlaub']
  );
});

test('build_budget_basis: a quick-entry row dated "today" does not push refDate past stale bank data (contracts stay active)', () => {
  const bankRows = [
    tx('2025-10-01', 344668, 'VML', 'income', 'Gehalt'),
    tx('2025-09-01', 344668, 'VML', 'income', 'Gehalt'),
    tx('2025-08-01', 344668, 'VML', 'income', 'Gehalt'),
    tx('2025-09-30', -121005, 'Berlin Towers', 'fixed', 'Miete'),
    tx('2025-10-30', -121005, 'Berlin Towers', 'fixed', 'Miete')
  ];
  const withoutQuickEntry = build_budget_basis(bankRows);
  assert.equal(withoutQuickEntry.fixedCents, 121005);

  const today = tx(new Date().toISOString().slice(0, 10), -1234, 'Supermarkt', 'essential', 'Supermarkt');
  const withQuickEntry = build_budget_basis([...bankRows, today]);
  assert.equal(withQuickEntry.fixedCents, 121005); // contract must still count as active
  assert.equal(withQuickEntry.refDate.getTime(), bankRows[4].date.getTime()); // refDate anchored to bank data, not the quick-entry row
});

test('build_sub_budget_report: only capped categories appear, sorted by how much of the cap is used', () => {
  const monday = week_start(new Date(2026, 8, 16));
  const rows = [
    tx('2026-09-14', -3443, 'ALDI', 'essential', 'Supermarkt'),
    tx('2026-09-16', -2726, 'McDonalds', 'discretionary', 'Restaurants'),
    tx('2026-09-17', -500, 'Kino', 'discretionary', 'Freizeit') // Freizeit has no cap - excluded
  ];
  const caps = { Supermarkt: 5000, Restaurants: 2000 }; // Restaurants already over its cap
  const report = build_sub_budget_report(rows, monday, caps);
  assert.deepEqual(report.map(r => r.category), ['Restaurants', 'Supermarkt']);
  assert.equal(report[0].spentCents, 2726);
  assert.equal(report[0].remainingCents, 2000 - 2726);
  assert.equal(report[0].pct, 100); // clamped, even though 2726/2000 > 100%
  assert.equal(report[1].pct, (3443 / 5000) * 100);
});

test('build_sub_budget_report: a capped category with zero spend still appears at 0%', () => {
  const monday = week_start(new Date(2026, 8, 16));
  const report = build_sub_budget_report([], monday, { Supermarkt: 5000 });
  assert.deepEqual(report, [{ category: 'Supermarkt', capCents: 5000, spentCents: 0, remainingCents: 5000, pct: 0 }]);
});

test('build_sub_budget_report: categoryToMain rolls several transaction categories up into one capped main budget', () => {
  const monday = week_start(new Date(2026, 8, 16));
  const rows = [
    tx('2026-09-14', -1000, 'Lieferando', 'discretionary', 'Lieferdienste'),
    tx('2026-09-15', -1500, 'McDonalds', 'discretionary', 'Restaurants, Bars & Cafés'),
    tx('2026-09-16', -500, 'Kino', 'discretionary', 'Freizeit') // not mapped - falls back to itself, uncapped
  ];
  const categoryToMain = (cat) => ({ 'Lieferdienste': 'gastro', 'Restaurants, Bars & Cafés': 'gastro' }[cat] || null);
  const report = build_sub_budget_report(rows, monday, { gastro: 5000 }, categoryToMain);
  assert.deepEqual(report, [{ category: 'gastro', capCents: 5000, spentCents: 2500, remainingCents: 2500, pct: 50 }]);
});
