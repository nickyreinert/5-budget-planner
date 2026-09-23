import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply_effective_periods, reporting_date } from '../src/recurrence.js';

const recurring = (date, cents, group = 'fixed', recurringRule = { intervalMonths: 1 }) => ({
  date: new Date(date), betrag_cents: cents, name: group === 'income' ? 'Employer' : 'Landlord',
  Datum: date.split('-').reverse().join('.'), Name: group === 'income' ? 'Employer' : 'Landlord', Verwendungszweck: '',
  _cls: { group, category: group === 'income' ? 'Salary' : 'Rent', ruleId: group, incomeType: group === 'income' ? 'salary' : undefined, recurring: recurringRule }
});
const iso_date = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

test('a delayed monthly debit at the start of a double-booked month counts in the prior month', () => {
  const rows = ['2026-03-01', '2026-03-30', '2026-04-30', '2026-05-30'].map(date => recurring(date, -120000));
  apply_effective_periods(rows);
  assert.equal(iso_date(reporting_date(rows[0])), '2026-02-28');
  assert.equal(iso_date(reporting_date(rows[1])), '2026-03-30');
});

test('the same correction works for salary income and an explicit annual contract', () => {
  const salary = ['2026-03-01', '2026-03-30', '2026-04-30', '2026-05-30'].map(date => recurring(date, 300000, 'income'));
  const annual = ['2026-01-02', '2026-12-30', '2027-12-30'].map(date => recurring(date, -25000, 'fixed', { intervalMonths: 12 }));
  apply_effective_periods([...salary, ...annual]);
  assert.equal(iso_date(reporting_date(salary[0])), '2026-02-28');
  assert.equal(iso_date(reporting_date(annual[0])), '2025-12-30');
});

test('a stable Sunday payment delayed to Monday is counted in the previous ISO week', () => {
  const rows = ['2026-03-02', '2026-03-08', '2026-03-15', '2026-03-22'].map(date => recurring(date, -1000, 'fixed', { intervalDays: 7 }));
  apply_effective_periods(rows);
  assert.equal(iso_date(reporting_date(rows[0])), '2026-03-01');
});

test('an explicit reporting-date override wins over automatic correction', () => {
  const rows = ['2026-03-01', '2026-03-30', '2026-04-30'].map(date => recurring(date, -120000));
  const id = `${rows[0].Datum}|${rows[0].Name}|${rows[0].Verwendungszweck}|${rows[0].betrag_cents}`;
  apply_effective_periods(rows, { [id]: '2026-03-01' });
  assert.equal(iso_date(reporting_date(rows[0])), '2026-03-01');
});
