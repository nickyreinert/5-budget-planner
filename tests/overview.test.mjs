import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build_timeline, filter_overview_rows, period_start, relative_deviation } from '../src/overview.js';
import { build_budget_basis, salary_monthly_cents, build_main_budget_report } from '../src/week.js';
import { ensure_budget_coverage, budget_category } from '../src/budgets.js';
import { enrich_row, category_transactions, transaction_display_name, tx_id } from '../src/data.js';
import { classify_all } from '../src/rules.js';
import { reconcile_paypal } from '../src/transfers.js';
import { rule_monthly_equivalent } from '../src/week.js';
const row = (month,cents,category,group = 'essential', extra = {}) => ({ date:new Date(2026,month-1,15), name:'Fixture', Account:'DKB', in_out: cents < 0 ? 'out':'in', betrag_cents:cents, _cls:{ category,group,...extra } });
const setting = () => ({ rules:[],mainCategories:[{id:'food',label:'Alltag'}] });
test('budgets roll up, drill to categories and include empty intervening months', () => {
  const rows = [row(1,-100,'food.Groceries'),row(3,-200,'food.Drugstore'),row(3,-500,'Rent','fixed'),row(3,50,'Gift','income')];
  const totals = build_timeline(rows,setting(),'budget');
  assert.deepEqual(totals.series[0].values,[100,0,200]);
  const detail = build_timeline(rows,setting(),'budget','month','food');
  assert.equal(detail.series.length,2); assert.equal(detail.series.flatMap(s=>s.values).reduce((a,b)=>a+b,0),300);
});
test('non-salary positives appear as Other income, never weekly salary', () => {
  const rows = [row(1,300000,'Gehalt','income'),row(2,300000,'Gehalt','income'),row(3,300000,'Gehalt','income'),row(3,900000,'Sale','income'),row(3,500,'food.Groceries')];
  const model = build_timeline(rows,setting(),'income');
  assert.equal(model.series.find(s=>s.key==='Zusätzliche Einnahmen').values[2],900500);
  assert.equal(build_budget_basis(rows).salaryCents,300000);
});
test('multiple income streams sum per salary month before taking median', () => {
  assert.equal(salary_monthly_cents([row(1,200000,'Job A','income',{incomeType:'salary'}),row(1,100000,'Job B','income',{incomeType:'salary'}),row(2,210000,'Job A','income',{incomeType:'salary'}),row(2,100000,'Job B','income',{incomeType:'salary'})]),310000);
});
test('same time and effective-account scope feeds every chart', () => {
  const a=row(1,-100,'food.Groceries'), b=row(2,-200,'food.Groceries');b._effectiveAccount='PayPal';
  assert.deepEqual(filter_overview_rows([a,b],{year:2026,account:'DKB',from:new Date(2026,0,1),to:new Date(2026,1,1)}),[a]);
  assert.equal(period_start(new Date(2026,0,1),'week').getFullYear(),2025);
});
test('unknown and savings/reserve expenses stay visibly unassigned until renamed under a budget', () => {
  const rows = [row(1,-100,'Unknown'),row(1,-500,'Holiday','reserve'),row(1,-200,'Savings','savings')];
  const s=ensure_budget_coverage(setting());
  for (const r of rows) assert.equal(budget_category(s,r._cls.category),null);
  assert.equal(build_budget_basis(rows).reserveCents,0);
});
test('explicit recurring interval includes a new annual contract immediately', () => {
  const rows=[row(3,300000,'Gehalt','income'),row(3,-12000,'Insurance','fixed',{recurring:{intervalMonths:12}})];
  assert.equal(build_budget_basis(rows).fixedCents,1000);
});

test('a budget-prefixed recurring category cannot double-count recurring payments or mix same-named category roles', () => {
  const settings = {
    mainCategories: [{ id: 'daily', label: 'Daily' }],
    rules: [{ id: 'fixed', category: 'daily.Insurance', group: 'fixed' }, { id: 'variable', category: 'daily.Insurance', group: 'essential' }]
  };
  const recurring = row(9, -27000, 'daily.Insurance', 'fixed', { recurring: { intervalMonths: 6 } });
  const purchase = row(9, -2500, 'daily.Insurance');
  const rows = [recurring, purchase, row(9, 300000, 'Gehalt', 'income')];
  const basis = build_budget_basis(rows);
  assert.equal(basis.fixedCents, 4500);
  assert.equal(basis.freeCents, 295500);
  const budgets = build_main_budget_report(rows, new Date(2026, 8, 14), settings.mainCategories, {}, category => budget_category(settings, category));
  assert.equal(budgets[0].spentCents, 2500);
  assert.deepEqual(budgets[0].rows, [purchase]);
  const spending = build_timeline(rows, settings, 'budget', 'month', 'daily');
  assert.deepEqual(spending.series[0].values, [2500]);
  const contracts = build_timeline(rows, settings, 'fixed');
  assert.deepEqual(contracts.series[0].values, [27000]);
});

test('explicit other income overrides a salary-looking category name', () => {
 const rows=[row(1,100000,'Gehalt Erstattung','income',{incomeType:'other'})];
 assert.equal(salary_monthly_cents(rows),0);
 assert.equal(build_timeline(rows,setting(),'income').series[0].key,'Zusätzliche Einnahmen');
});

test('relative chart comparison normalizes every series against its own average or median', () => {
  const values = [100, 200, 0];
  const average = relative_deviation(values, 'average');
  assert.equal(average.reference, 150);
  assert.deepEqual(average.values.map(value => Math.round(value)), [-33, 33, -100]);
  const median = relative_deviation(values, 'median');
  assert.equal(median.reference, 200);
  assert.deepEqual(median.values, [-50, 0, -100]);
});

test('PayPal insurance lists and fixed-cost drilldowns show the merchant once, preserving payment details and interval', () => {
  const category = 'Insurance.Legal';
  const settings = { rules: [{ id: 'insurance', category, group: 'fixed', verwendungPattern: 'Fixture Insurance', recurring: { intervalMonths: 6 } }] };
  const merchant = enrich_row({ Datum: '01.09.2026', Name: 'Fixture Insurance SE', Verwendungszweck: '', Betrag: '-270.00', _account: 'PayPal' });
  const settlement = enrich_row({ Datum: '02.09.2026', Name: 'PayPal Europe S.a.r.l. et Cie S.C.A', Verwendungszweck: '000123/PP.9999.PP/. Fixture Insurance SE, Ihr Einkauf bei Fixture Insurance SE', Betrag: '-270.00', _account: 'Checking' });
  const funding = enrich_row({ Datum: '01.09.2026', Name: 'Bank Account (direct debit)', Verwendungszweck: '', Betrag: '270.00', _account: 'PayPal' });
  const rows = [settlement, merchant, funding];
  const originalIds = rows.map(tx_id);
  classify_all(rows, settings);
  reconcile_paypal(rows);

  const list = category_transactions(rows, category);
  assert.deepEqual(list, [merchant]);
  assert.equal(transaction_display_name(list[0]), 'Fixture Insurance SE');
  assert.equal(list[0].Datum, '01.09.2026');
  assert.equal(list[0].betrag_cents, -27000);
  assert.deepEqual(list[0]._mergeGroup.members, originalIds);
  assert.equal(settlement.Name, 'PayPal Europe S.a.r.l. et Cie S.C.A');
  assert.equal(funding.Name, 'Bank Account (direct debit)');

  // Even a caller accidentally passing all three source bookings cannot
  // inflate the recurring preview or replace its primary merchant label.
  const recurring = rule_monthly_equivalent(rows);
  assert.equal(recurring.totalCents, 4500);
  assert.equal(recurring.clusters.length, 1);
  assert.equal(recurring.clusters[0].name, 'Fixture Insurance SE');
  assert.equal(build_budget_basis(rows).fixedCents, 4500);
  const model = build_timeline(rows, settings, 'fixed', 'month', category);
  assert.deepEqual(model.series.map(s => s.label), ['Fixture Insurance SE']);
  assert.deepEqual(model.series[0].values, [27000]);
  assert.deepEqual([...model.series[0].rowsByStamp.values()].flat(), [merchant]);
});
