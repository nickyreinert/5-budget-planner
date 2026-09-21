import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build_timeline, filter_overview_rows, period_start } from '../src/overview.js';
import { build_budget_basis, salary_monthly_cents } from '../src/week.js';
import { ensure_budget_coverage, budget_category } from '../src/budgets.js';
const row = (month,cents,category,group = 'essential', extra = {}) => ({ date:new Date(2026,month-1,15), name:'Fixture', Account:'DKB', in_out: cents < 0 ? 'out':'in', betrag_cents:cents, _cls:{ category,group,...extra } });
const setting = () => ({ rules:[],mainCategories:[{id:'food',label:'Alltag'}],categoryMappings:{Groceries:'food',Drugstore:'food'} });
test('budgets roll up, drill to categories and include empty intervening months', () => {
  const rows = [row(1,-100,'Groceries'),row(3,-200,'Drugstore'),row(3,-500,'Rent','fixed'),row(3,50,'Gift','income')];
  const totals = build_timeline(rows,setting(),'budget');
  assert.deepEqual(totals.series[0].values,[100,0,200]);
  const detail = build_timeline(rows,setting(),'budget','month','food');
  assert.equal(detail.series.length,2); assert.equal(detail.series.flatMap(s=>s.values).reduce((a,b)=>a+b,0),300);
});
test('non-salary positives appear as Other income, never weekly salary', () => {
  const rows = [row(1,300000,'Gehalt','income'),row(2,300000,'Gehalt','income'),row(3,300000,'Gehalt','income'),row(3,900000,'Sale','income'),row(3,500,'Groceries')];
  const model = build_timeline(rows,setting(),'income');
  assert.equal(model.series.find(s=>s.key==='Zusätzliche Einnahmen').values[2],900500);
  assert.equal(build_budget_basis(rows).salaryCents,300000);
});
test('multiple income streams sum per salary month before taking median', () => {
  assert.equal(salary_monthly_cents([row(1,200000,'Job A','income',{incomeType:'salary'}),row(1,100000,'Job B','income',{incomeType:'salary'}),row(2,210000,'Job A','income',{incomeType:'salary'}),row(2,100000,'Job B','income',{incomeType:'salary'})]),310000);
});
test('same time and effective-account scope feeds every chart', () => {
  const a=row(1,-100,'Groceries'), b=row(2,-200,'Groceries');b._effectiveAccount='PayPal';
  assert.deepEqual(filter_overview_rows([a,b],{year:2026,account:'DKB',from:new Date(2026,0,1),to:new Date(2026,1,1)}),[a]);
  assert.equal(period_start(new Date(2026,0,1),'week').getFullYear(),2025);
});
test('unknown and savings/reserve expenses stay visibly unassigned until mapped', () => {
  const rows = [row(1,-100,'Unknown'),row(1,-500,'Holiday','reserve'),row(1,-200,'Savings','savings')];
  const s=ensure_budget_coverage(setting(),rows);
  for (const r of rows) assert.equal(budget_category(s,r._cls.category),null);
  assert.equal(build_budget_basis(rows).reserveCents,0);
});
test('explicit recurring interval includes a new annual contract immediately', () => {
  const rows=[row(3,300000,'Gehalt','income'),row(3,-12000,'Insurance','fixed',{recurring:{intervalMonths:12}})];
  assert.equal(build_budget_basis(rows).fixedCents,1000);
});

test('explicit other income overrides a salary-looking category name', () => {
 const rows=[row(1,100000,'Gehalt Erstattung','income',{incomeType:'other'})];
 assert.equal(salary_monthly_cents(rows),0);
 assert.equal(build_timeline(rows,setting(),'income').series[0].key,'Zusätzliche Einnahmen');
});
