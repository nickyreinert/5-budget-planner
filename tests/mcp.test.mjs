import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classified_rows, categories, transactions, propose_rule, propose_assignments } from '../mcp/classification.mjs';

const settings = {
  groups: [{ id: 'discretionary', label: 'Budget' }],
  mainCategories: [{ id: 'food', label: 'Lebensmittel' }],
  categoryMappings: { Essen: 'food', Wohnen: '' },
  rules: [{ id: 'market', label: 'Essen', category: 'Essen', group: 'discretionary', namePattern: 'MARKET', priority: 10 }]
};
const entry = (id, name, amount = '-10.00') => ({ id, Datum: '01.10.2026', Name: name, Verwendungszweck: '', Betrag: amount });
const data = {
  importedEntries: [entry('csv:1', 'MARKET'), entry('csv:2', 'LANDLORD'), entry('csv:3', 'MARKET OTHER')],
  manualEntries: [], overrides: { 'csv:3': 'Wohnen' }
};

test('MCP reads existing rule and manual classifications with transaction IDs', () => {
  assert.deepEqual(classified_rows(settings, data).map(row => [row.id, row.category, row.source]), [
    ['csv:1', 'Essen', 'rule'], ['csv:2', 'Unkategorisiert', 'none'], ['csv:3', 'Wohnen', 'manual']
  ]);
  assert.equal(categories(settings, data).find(item => item.category === 'Essen').budget, 'Lebensmittel');
  assert.equal(transactions(settings, data, { category: 'Unkategorisiert' }).rows[0].id, 'csv:2');
});

test('rule proposal matches unknown rows without changing prior classifications', () => {
  const { candidate, affected } = propose_rule(settings, data, { category: 'Wohnen', field: 'name', text: 'LANDLORD', exact: true });
  assert.equal(affected.length, 1);
  assert.equal(affected[0].id, 'csv:2');
  assert.equal(candidate.rules.length, 2);
  assert.equal(classified_rows(candidate, data)[1].category, 'Wohnen');
  assert.throws(() => propose_rule(settings, data, { category: 'Wohnen', field: 'name', text: 'MARKET' }), /already categorized/);
});

test('individual assignments cannot overwrite manual labels or invent categories', () => {
  assert.deepEqual(propose_assignments(settings, data, [{ id: 'csv:2', category: 'Essen' }]), { overrides: { 'csv:2': 'Essen' } });
  assert.throws(() => propose_assignments(settings, data, [{ id: 'csv:3', category: 'Essen' }]), /already has a manual/);
  assert.throws(() => propose_assignments(settings, data, [{ id: 'csv:2', category: 'NotExisting' }]), /Unknown category/);
});