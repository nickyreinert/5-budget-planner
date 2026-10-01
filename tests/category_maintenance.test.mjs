import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan_category_maintenance, category_maintenance_revision } from '../src/category_maintenance.js';
import { enrich_row, tx_id } from '../src/data.js';
import { classify_all, apply_manual_overrides } from '../src/rules.js';
const settings = () => ({ groups: [], mainCategories: [{ id: 'food', label: 'Food' }], categoryMappings: { Groceries: 'food', Grocery: 'food', Empty: '' },
  subBudgetCaps: { food: 10000 }, rules: [
    { id: 'market', category: 'Grocery', label: 'Grocery', group: 'discretionary', namePattern: 'MARKET' },
    { id: 'insurance', category: 'Insurance', group: 'fixed', namePattern: 'ARAG', contractId: 'contract:1', recurring: { intervalMonths: 12 } }
  ] });
const row = (id, category, name = 'Purchase') => ({ ...enrich_row({ _txId: id, Datum: '01.10.2026', Name: name, Betrag: '-10.00' }), _cls: { category, group: category === 'Insurance' ? 'fixed' : 'discretionary' } });

test('merging duplicates updates existing CSV/manual assignments and future rules without changing bookings', () => {
  const original = settings(), rows = [row('csv:1', 'Grocery', 'MARKET'), row('manual:1', 'Grocery')];
  const before = structuredClone(rows);
  const plan = plan_category_maintenance(original, rows, { 'manual:1': 'Grocery', 'old-booking': 'Grocery' }, [{ action: 'merge', category: 'Grocery', target: 'Groceries' }]);
  assert.deepEqual(plan.overrides, { 'csv:1': 'Groceries', 'manual:1': 'Groceries', 'old-booking': 'Groceries' });
  assert.equal(plan.settings.rules[0].id, 'market');
  assert.equal(plan.settings.rules[0].category, 'Groceries');
  assert.equal(plan.settings.categoryMappings.Grocery, undefined);
  assert.deepEqual(plan.changes[0].affectedIds, ['csv:1', 'manual:1']);
  assert.deepEqual(rows, before);
  assert.equal(original.rules[0].category, 'Grocery');
  const future = row('csv:future', 'Unkategorisiert', 'MARKET');
  classify_all([future], plan.settings); assert.equal(future._cls.category, 'Groceries');
});

test('recurring rename preserves contract identity and never acquires a spending budget', () => {
  const plan = plan_category_maintenance(settings(), [row('csv:insurance', 'Insurance')], {}, [{ action: 'rename', category: 'Insurance', target: 'Insurance.Legal' }]);
  const rule = plan.settings.rules.find(rule => rule.id === 'insurance');
  assert.equal(rule.contractId, 'contract:1'); assert.deepEqual(rule.recurring, { intervalMonths: 12 });
  assert.equal(plan.settings.categoryMappings['Insurance.Legal'], undefined);
  assert.equal(plan.overrides['csv:insurance'], 'Insurance.Legal');
});

test('reviewed moves replace earlier manual assignments and compose with category renames', () => {
  const rows = [row('manual:1', 'Grocery')];
  const plan = plan_category_maintenance(settings(), rows, { 'manual:1': 'Grocery' }, [
    { action: 'move', ids: ['manual:1'], target: 'Groceries' }, { action: 'rename', category: 'Groceries', target: 'Fresh food' }
  ]);
  assert.equal(plan.overrides['manual:1'], 'Fresh food');
  apply_manual_overrides(rows, plan.overrides, plan.settings);
  assert.equal(rows[0]._cls.category, 'Fresh food'); assert.equal(tx_id(rows[0]), 'manual:1');
});

test('create and delete support unused categories; used/protected/unknown and cross-role cleanup is rejected', () => {
  const rows = [row('csv:1', 'Grocery'), row('csv:insurance', 'Insurance')];
  const plan = plan_category_maintenance(settings(), rows, {}, [{ action: 'create', category: 'Snacks', budgetId: 'food' }, { action: 'delete', category: 'Empty' }]);
  assert.equal(plan.settings.categoryMappings.Snacks, 'food'); assert.equal(plan.settings.categoryMappings.Empty, undefined);
  for (const operation of [
    { action: 'delete', category: 'Grocery' }, { action: 'delete', category: 'Food' },
    { action: 'rename', category: 'Unkategorisiert', target: 'Unknown' },
    { action: 'merge', category: 'Insurance', target: 'Groceries' },
    { action: 'move', ids: ['csv:insurance'], target: 'Groceries' },
    { action: 'move', ids: ['missing'], target: 'Groceries' },
    { action: 'create', category: '__proto__' }, { action: 'create', category: 'Snacks', budgetId: 'missing' }
  ]) assert.throws(() => plan_category_maintenance(settings(), rows, {}, [operation]));
});

test('revision is independent of key/order/display metadata, but changes with budgets, edits, ignore or assignments', () => {
  const original = settings(), rows = [row('csv:1', 'Grocery'), row('manual:1', 'Groceries')], overrides = {};
  const rev = category_maintenance_revision(original, rows, overrides);
  assert.equal(category_maintenance_revision({ ...original, _compiled: 'browser-only' }, [...rows].reverse(), overrides), rev);
  const changed = settings(); changed.subBudgetCaps.food = 20000;
  assert.notEqual(category_maintenance_revision(changed, rows, overrides), rev);
  assert.notEqual(category_maintenance_revision(original, rows, { 'csv:1': 'Groceries' }), rev);
  rows[0]._ignored = true; assert.notEqual(category_maintenance_revision(original, rows, overrides), rev);
  rows[0]._ignored = false; rows[0].Verwendungszweck = 'Edited'; assert.notEqual(category_maintenance_revision(original, rows, overrides), rev);
});
