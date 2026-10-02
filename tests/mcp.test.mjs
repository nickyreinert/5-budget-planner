import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classified_rows, categories, transactions, propose_rule, propose_rules, propose_assignments } from '../mcp/classification.mjs';

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

test('MCP transaction listing filters by inclusive date range', () => {
  const dated = { importedEntries: [{ ...entry('csv:a', 'A'), Datum: '28.09.2026' }, { ...entry('csv:b', 'B'), Datum: '01.10.2026' }, { ...entry('csv:c', 'C'), Datum: '02.10.2026' }], manualEntries: [], overrides: {} };
  const ids = filters => transactions(settings, dated, filters).rows.map(row => row.id);
  assert.deepEqual(ids({ from: '2026-09-29', to: '2026-10-01' }), ['csv:b']);
  assert.deepEqual(ids({ from: '2026-10-01' }), ['csv:b', 'csv:c']);
  assert.deepEqual(ids({ to: '2026-09-28' }), ['csv:a']);
  assert.throws(() => transactions(settings, dated, { from: '28.09.2026' }), /YYYY-MM-DD/);
});

test('AI category exports never present recurring categories as spending-budget assignments', () => {
  const settings = { rules: [{ id: 'insurance', category: 'Insurance.Legal', group: 'fixed', namePattern: 'Contract' }], mainCategories: [{ id: 'housing', label: 'Housing' }], categoryMappings: { 'Insurance.Legal': 'housing' } };
  const data = { importedEntries: [entry('csv:contract', 'Contract provider')], manualEntries: [], overrides: {} };
  const category = categories(settings, data).find(item => item.category === 'Insurance.Legal');
  assert.equal(category.budget, null);
  assert.equal(category.examples.length, 1);
  assert.equal(classified_rows(settings, data)[0].category, 'Insurance.Legal');
});

test('rule proposal matches unknown rows without changing prior classifications', () => {
  const { candidate, affected } = propose_rule(settings, data, { category: 'Wohnen', field: 'name', text: 'LANDLORD', exact: true });
  assert.equal(affected.length, 1);
  assert.equal(affected[0].id, 'csv:2');
  assert.equal(candidate.rules.length, 2);
  assert.equal(classified_rows(candidate, data)[1].category, 'Wohnen');
  assert.throws(() => propose_rule(settings, data, { category: 'Wohnen', field: 'name', text: 'MARKET' }), /already classified/);
  assert.equal(propose_rules(settings, data, [{ category: 'Wohnen', field: 'name', text: 'LANDLORD' }]).proposals.length, 1);
  const withRefund = { ...data, importedEntries: [...data.importedEntries, entry('csv:4', 'LANDLORD REFUND', '10.00')] };
  assert.throws(() => propose_rule(settings, withRefund, { category: 'Wohnen', field: 'name', text: 'LANDLORD' }), /income or refunds/);
});

test('individual assignments cannot overwrite manual labels or invent categories', () => {
  assert.deepEqual(propose_assignments(settings, data, [{ id: 'csv:2', category: 'Essen' }]), { overrides: { 'csv:2': 'Essen' } });
  assert.throws(() => propose_assignments(settings, data, [{ id: 'csv:3', category: 'Essen' }]), /already has a manual/);
  assert.throws(() => propose_assignments(settings, data, [{ id: 'csv:2', category: 'NotExisting' }]), /Unknown category/);
});

test('MCP reconciles manual duplicates and applies booking-specific edits', () => {
  const changed = {
    importedEntries: [entry('csv:1', 'MARKET')],
    manualEntries: [{ ...entry('manual:1', 'Cash'), _txId: 'manual:1', Kategorie: 'Wohnen', source: 'manual' }],
    overrides: { 'csv:1': 'Wohnen' }, amountOverrides: { 'csv:1': -2500 }, noteOverrides: { 'csv:1': 'edited purpose' }
  };
  const rows = classified_rows(settings, changed);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].category, rows[0].amountCents, rows[0].purpose], ['Wohnen', -2500, 'edited purpose']);
});

test('MCP uses the exported match window and retains manual categories with authoritative bank facts', () => {
  const bank = { ...entry('csv:1', 'MARKET'), Datum: '01.10.2026', Verwendungszweck: 'Bank reference' };
  const manual = { ...entry('manual:1', 'Example purchase'), Datum: '29.09.2026', source: 'manual', _txId: 'manual:1', Kategorie: 'Wohnen' };
  const exported = {
    importedEntries: [bank], manualEntries: [manual], overrides: {},
    noteOverrides: { 'manual:1': 'Personal note' }, dateOverrides: { 'manual:1': '2026-09-30' }
  };
  const rows = classified_rows(settings, exported);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].date, rows[0].amountCents, rows[0].purpose, rows[0].category],
    ['csv:1', '01.10.2026', -1000, 'Bank reference', 'Wohnen']);
  assert.equal(rows[0].transactionSource, 'csv');
  assert.equal(rows[0].reconciliation.status, 'matched');
  assert.equal(rows[0].reconciliation.manualId, 'manual:1');

  const exactDateOnly = classified_rows(settings, { ...exported, manualMatchDays: 0 });
  assert.equal(exactDateOnly.length, 2);
  const pendingManual = exactDateOnly.find(row => row.id === 'manual:1');
  assert.equal(pendingManual.date, '30.09.2026');
  assert.equal(pendingManual.purpose, 'Personal note');
});

test('MCP uses exported import coverage and review decisions without relabeling classifications', () => {
  const exported = {
    importedEntries: [],
    manualEntries: [
      { ...entry('manual:covered', 'Example purchase'), Datum: '15.09.2026', source: 'manual', _txId: 'manual:covered', Kategorie: 'Essen' },
      { ...entry('manual:pending', 'Example purchase'), source: 'manual', _txId: 'manual:pending', Kategorie: 'Wohnen' }
    ], overrides: {},
    importRanges: [{ id: 'range:1', account: 'Checking', from: '2026-09-01', to: '2026-09-30' }]
  };
  const rows = classified_rows(settings, exported);
  assert.deepEqual(rows.map(row => [row.id, row.reconciliation.status, row.category]), [
    ['manual:covered', 'unassigned', 'Essen'], ['manual:pending', 'pending', 'Wohnen']
  ]);
  const cash = classified_rows(settings, {
    ...exported, reconciliationDecisions: { 'manual:covered': { kind: 'cash' } }
  });
  assert.equal(cash.find(row => row.id === 'manual:covered').reconciliation.status, 'cash');
  assert.equal(cash.reduce((sum, row) => sum + row.amountCents, 0), -2000);
});

test('MCP preserves ambiguous duplicates and honors an exported explicit match', () => {
  const exported = {
    importedEntries: [entry('csv:a', 'MARKET'), entry('csv:b', 'Example merchant')],
    manualEntries: [{ ...entry('manual:1', 'Example purchase'), _txId: 'manual:1', source: 'manual', Kategorie: 'Wohnen' }],
    overrides: {}, importRanges: [{ id: 'range:1', account: '', from: '2026-10-01', to: '2026-10-01' }]
  };
  const ambiguous = classified_rows(settings, exported);
  assert.equal(ambiguous.length, 3);
  assert.equal(ambiguous.find(row => row.id === 'manual:1').reconciliation.status, 'ambiguous');
  const reviewed = classified_rows(settings, {
    ...exported, reconciliationDecisions: { 'manual:1': { kind: 'match', importedId: 'csv:b' } }
  });
  assert.equal(reviewed.length, 2);
  assert.equal(reviewed.find(row => row.id === 'csv:b').category, 'Wohnen');
  assert.equal(reviewed.find(row => row.id === 'csv:b').reconciliation.status, 'matched');
});

import { propose_category_maintenance } from '../mcp/classification.mjs';
import { category_maintenance_revision } from '../src/category_maintenance.js';
import { reconcile_transactions } from '../src/transactions.js';
import { classify_all, apply_manual_overrides } from '../src/rules.js';
import { apply_ignored_transactions } from '../src/data.js';
test('MCP maintenance intentionally moves manual labels and records ignored status in its reviewed revision', () => {
  const exported = { ...data, ignoredTransactions: { 'csv:3': true } };
  assert.equal(classified_rows(settings, exported).find(row => row.id === 'csv:3').ignored, true);
  const proposal = propose_category_maintenance(settings, exported, [{ action: 'move', ids: ['csv:3'], target: 'Essen' }]);
  assert.deepEqual(proposal.preview[0].affectedIds, ['csv:3']);
  const browserRows = reconcile_transactions(exported.importedEntries, exported.manualEntries);
  browserRows.forEach(row => { row._ignoreCsvCategories = true; });
  classify_all(browserRows, settings); apply_manual_overrides(browserRows, exported.overrides, settings);
  apply_ignored_transactions(browserRows, exported.ignoredTransactions);
  assert.equal(proposal.revision, category_maintenance_revision(settings, browserRows, exported.overrides));
  assert.equal(data.overrides['csv:3'], 'Wohnen');
});
