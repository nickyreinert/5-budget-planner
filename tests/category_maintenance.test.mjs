import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan_category_maintenance, category_maintenance_revision } from '../src/category_maintenance.js';
import { budget_category } from '../src/budgets.js';
import { enrich_row, tx_id } from '../src/data.js';
import { classify_all, apply_manual_overrides } from '../src/rules.js';
const empty = (id, category) => ({ id, category, label: category, group: 'discretionary', matchers: [{ field: 'any', operator: 'contains', value: '', exclude: false }] });
const settings = () => ({ groups: [], mainCategories: [{ id: 'food', label: 'Food' }],
  subBudgetCaps: { food: 10000 }, rules: [
    { id: 'market', category: 'food.Grocery', label: 'food.Grocery', group: 'discretionary', namePattern: 'MARKET' },
    { id: 'insurance', category: 'Insurance', group: 'fixed', namePattern: 'ARAG', contractId: 'contract:1', recurring: { intervalMonths: 12 } },
    empty('groceries', 'food.Groceries'), empty('empty', 'Empty')
  ] });
const row = (id, category, name = 'Purchase') => ({ ...enrich_row({ _txId: id, Datum: '01.10.2026', Name: name, Betrag: '-10.00' }), _cls: { category, group: category === 'Insurance' ? 'fixed' : 'discretionary' } });

test('merging duplicates updates existing CSV/manual assignments and future rules without changing bookings', () => {
  const original = settings(), rows = [row('csv:1', 'food.Grocery', 'MARKET'), row('manual:1', 'food.Grocery')];
  const before = structuredClone(rows);
  const plan = plan_category_maintenance(original, rows, { 'manual:1': 'food.Grocery', 'old-booking': 'food.Grocery' }, [{ action: 'merge', category: 'food.Grocery', target: 'food.Groceries' }]);
  assert.deepEqual(plan.overrides, { 'csv:1': 'food.Groceries', 'manual:1': 'food.Groceries', 'old-booking': 'food.Groceries' });
  assert.equal(plan.settings.rules[0].id, 'market');
  assert.equal(plan.settings.rules[0].category, 'food.Groceries');
  assert.deepEqual(plan.changes[0].affectedIds, ['csv:1', 'manual:1']);
  assert.deepEqual(rows, before);
  assert.equal(original.rules[0].category, 'food.Grocery');
  const future = row('csv:future', 'Unkategorisiert', 'MARKET');
  classify_all([future], plan.settings); assert.equal(future._cls.category, 'food.Groceries');
});

test('recurring rename preserves contract identity and never acquires a spending budget', () => {
  const plan = plan_category_maintenance(settings(), [row('csv:insurance', 'Insurance')], {}, [{ action: 'rename', category: 'Insurance', target: 'Insurance.Legal' }]);
  const rule = plan.settings.rules.find(rule => rule.id === 'insurance');
  assert.equal(rule.contractId, 'contract:1'); assert.deepEqual(rule.recurring, { intervalMonths: 12 });
  assert.equal(budget_category(plan.settings, 'Insurance.Legal'), null);
  assert.equal(plan.overrides['csv:insurance'], 'Insurance.Legal');
});

test('reviewed moves replace earlier manual assignments and compose with category renames', () => {
  const rows = [row('manual:1', 'food.Grocery')];
  const plan = plan_category_maintenance(settings(), rows, { 'manual:1': 'food.Grocery' }, [
    { action: 'move', ids: ['manual:1'], target: 'food.Groceries' }, { action: 'rename', category: 'food.Groceries', target: 'food.Fresh food' }
  ]);
  assert.equal(plan.overrides['manual:1'], 'food.Fresh food');
  apply_manual_overrides(rows, plan.overrides, plan.settings);
  assert.equal(rows[0]._cls.category, 'food.Fresh food'); assert.equal(tx_id(rows[0]), 'manual:1');
});

test('create and delete support unused categories; used/protected/unknown and cross-role cleanup is rejected', () => {
  const rows = [row('csv:1', 'food.Grocery'), row('csv:insurance', 'Insurance')];
  const plan = plan_category_maintenance(settings(), rows, {}, [{ action: 'create', category: 'Snacks', budgetId: 'food' }, { action: 'delete', category: 'Empty' }]);
  assert.ok(plan.settings.rules.some(rule => rule.category === 'food.Snacks' && budget_category(plan.settings, rule.category) === 'food'));
  assert.ok(!plan.settings.rules.some(rule => rule.category === 'Empty'));
  for (const operation of [
    { action: 'delete', category: 'food.Grocery' }, { action: 'delete', category: 'food' }, { action: 'rename', category: 'food', target: 'Eating' },
    { action: 'rename', category: 'Unkategorisiert', target: 'Unknown' },
    { action: 'merge', category: 'Insurance', target: 'food.Groceries' },
    { action: 'move', ids: ['csv:insurance'], target: 'food.Groceries' },
    { action: 'move', ids: ['missing'], target: 'food.Groceries' },
    { action: 'create', category: '__proto__' }, { action: 'create', category: 'Snacks', budgetId: 'missing' }
  ]) assert.throws(() => plan_category_maintenance(settings(), rows, {}, [operation]));
});

test('revision is independent of key/order/display metadata, but changes with budgets, edits, ignore or assignments', () => {
  const original = settings(), rows = [row('csv:1', 'food.Grocery'), row('manual:1', 'food.Groceries')], overrides = {};
  const rev = category_maintenance_revision(original, rows, overrides);
  assert.equal(category_maintenance_revision({ ...original, _compiled: 'browser-only' }, [...rows].reverse(), overrides), rev);
  const changed = settings(); changed.subBudgetCaps.food = 20000;
  assert.notEqual(category_maintenance_revision(changed, rows, overrides), rev);
  assert.notEqual(category_maintenance_revision(original, rows, { 'csv:1': 'food.Groceries' }), rev);
  rows[0]._ignored = true; assert.notEqual(category_maintenance_revision(original, rows, overrides), rev);
  rows[0]._ignored = false; rows[0].Verwendungszweck = 'Edited'; assert.notEqual(category_maintenance_revision(original, rows, overrides), rev);
});
