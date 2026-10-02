import { test } from 'node:test';
import assert from 'node:assert/strict';
import { category_catalog, fixed_expense_categories, transaction_category_options, sort_categories, split_category, join_category } from '../src/categories.js';
import { classify, classify_all, apply_manual_overrides } from '../src/rules.js';
import { enrich_row, tx_id } from '../src/data.js';
import { default_csv_config, get_csv_config } from '../src/csv_config.js';
const settings = { rules: [{ id: 'food', category: 'Food', group: 'essential', kategoriePattern: 'Groceries' }], mainCategories: [{ id: 'daily', label: 'Daily' }], categoryMappings: { Dining: 'daily' } };

test('only settings names form the catalog, with favorites sorted first', () => {
  assert.deepEqual(sort_categories(category_catalog(settings), ['Food']), ['Unkategorisiert', 'Food', 'Daily', 'Dining', 'Zusätzliche Einnahmen']);
  assert.ok(!category_catalog(settings).includes('Crypto'));
  assert.deepEqual(category_catalog({ rules: [], mainCategories: [] }), ['Unkategorisiert', 'Zusätzliche Einnahmen']);
});

test('recurring-contract picker only offers reusable fixed-expense categories', () => {
  const ruleSet = { rules: [
    { category: 'Rent', group: 'fixed' },
    { category: 'Insurance', group: 'fixed' },
    { category: 'Food', group: 'essential' },
    { category: 'Salary', group: 'income' },
    { category: 'Rent', group: 'fixed' }
  ] };
  assert.deepEqual(fixed_expense_categories(ruleSet, ['Insurance']), ['Insurance', 'Rent']);
});

test('spending pickers exclude legacy recurring mappings, including matching main-budget names', () => {
  const settings = { rules: [{ category: 'Insurance', group: 'fixed' }], mainCategories: [{ id: 'housing', label: 'Insurance' }], categoryMappings: { Insurance: 'housing', Food: 'housing' } };
  assert.ok(category_catalog(settings).includes('Insurance'));
  assert.ok(!category_catalog(settings, true).includes('Insurance'));
  assert.ok(category_catalog(settings, true).includes('Food'));
  assert.deepEqual(fixed_expense_categories(settings), ['Insurance']);
});

test('transaction pickers keep spending, recurring, income and transfers separate', () => {
  const settings = { rules: [
    { category: 'Software & Abos', group: 'fixed' },
    { category: 'Food', group: 'essential' },
    { category: 'Salary', group: 'income' },
    { category: 'Between accounts', group: 'internal_transfer' }
  ], mainCategories: [{ id: 'food', label: 'Food' }] };
  assert.deepEqual(transaction_category_options(settings, 'unclassified'), ['Unkategorisiert', 'Food']);
  assert.deepEqual(transaction_category_options(settings, 'fixed'), ['Unkategorisiert', 'Software & Abos']);
  assert.deepEqual(transaction_category_options(settings, 'income'), ['Unkategorisiert', 'Salary', 'Zusätzliche Einnahmen']);
  assert.deepEqual(transaction_category_options(settings, 'internal_transfer'), ['Unkategorisiert', 'Between accounts']);
});

test('manual overrides retain the classified role when recurring and spending categories have identical names', () => {
  const settings = { rules: [
    { id: 'contract', category: 'Insurance', group: 'fixed', namePattern: 'Contract provider', recurring: { intervalMonths: 6 } },
    { id: 'purchase', category: 'Insurance', group: 'essential', namePattern: 'One-off purchase' }
  ] };
  const rows = ['Contract provider', 'One-off purchase'].map(Name => enrich_row({ Datum: '01.09.2026', Name, Betrag: '-270.00' }));
  classify_all(rows, settings);
  apply_manual_overrides(rows, Object.fromEntries(rows.map(row => [tx_id(row), 'Insurance'])), settings);
  assert.deepEqual(rows.map(row => row._cls.group), ['fixed', 'essential']);
  assert.equal(rows[0]._cls.recurring.intervalMonths, 6);
  assert.equal(rows[1]._cls.recurring, undefined);
  assert.ok(category_catalog(settings, true).includes('Insurance'));
  assert.deepEqual(fixed_expense_categories(settings), ['Insurance']);
});

test('bank labels and obsolete overrides cannot introduce unknown categories', () => {
  const row = enrich_row({ Datum: '20.09.2026', Name: 'Unknown', Kategorie: 'Crypto', Betrag: '-10' });
  assert.equal(classify(row, settings).category, 'Unkategorisiert');
  classify_all([row], settings);
  apply_manual_overrides([row], { [tx_id(row)]: 'Old category' }, settings);
  assert.equal(row._cls.category, 'Unkategorisiert');
});

test('ignore CSV categories blocks category rules and fallback, but keeps merchant rules', () => {
  const row = enrich_row({ Name: 'Shop', Kategorie: 'Groceries', Betrag: '-10' });
  assert.equal(classify(row, settings).category, 'Food');
  row._ignoreCsvCategories = true;
  assert.equal(classify(row, settings).category, 'Unkategorisiert');
  assert.equal(classify(row, { rules: [{ id: 'shop', category: 'Food', namePattern: 'Shop' }] }).category, 'Food');
  row.Kategorie = 'Dining';
  assert.equal(classify(row, settings).category, 'Unkategorisiert');
  row._ignoreCsvCategories = false;
  assert.equal(classify(row, settings).category, 'Dining');
});

test('ignore CSV categories defaults on for new and legacy stored configurations', () => {
  assert.equal(default_csv_config().ignoreCategories, true);
  globalThis.localStorage = { getItem: () => JSON.stringify({ delimiter: ',' }) };
  assert.equal(get_csv_config().ignoreCategories, true);
  globalThis.localStorage = { getItem: () => JSON.stringify({ ignoreCategories: false }) };
  assert.equal(get_csv_config().ignoreCategories, false);
});

test('uncategorized is always a quick-entry option and clears a previous fixed classification', () => {
 assert.deepEqual(category_catalog({rules:[]},true),['Unkategorisiert']);
 const r=enrich_row({Datum:'20.09.2026',Name:'Unknown',Betrag:'-20'});r._cls={group:'fixed',category:'Rent',excluded:false};
 apply_manual_overrides([r],{[tx_id(r)]:'Unkategorisiert'},{rules:[]});
 assert.equal(r._cls.group,'unclassified');assert.equal(r._cls.excluded,false);
});

test('split_category splits on the first dot only, join_category is its inverse', () => {
  assert.deepEqual(split_category('Versicherungen.HDI Leben'), { parent: 'Versicherungen', sub: 'HDI Leben' });
  assert.deepEqual(split_category('Versicherungen'), { parent: 'Versicherungen', sub: null });
  assert.deepEqual(split_category('A.B.C'), { parent: 'A', sub: 'B.C' });
  assert.deepEqual(split_category(''), { parent: '', sub: null });
  assert.equal(join_category('Versicherungen', 'HDI Leben'), 'Versicherungen.HDI Leben');
  assert.equal(join_category('Versicherungen', null), 'Versicherungen');
});
