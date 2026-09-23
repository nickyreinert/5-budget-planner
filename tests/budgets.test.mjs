import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { budget_category, validate_budget_settings } from '../src/budgets.js';
import { build_main_budget_report, category_color } from '../src/week.js';
import { enrich_row, tx_id, apply_amount_overrides } from '../src/data.js';
import { apply_manual_overrides, classify, classify_all, rule_matches } from '../src/rules.js';
const setting = () => JSON.parse(readFileSync(new URL('../examples/five-budgets.setting.json', import.meta.url)));

test('example settings round-trip five budgets with an unassigned fallback, mappings and limits', () => {
  const s = setting(); s.subBudgetCaps = { lebensmittel: 5000 };
  const imported = validate_budget_settings(JSON.parse(JSON.stringify(s)));
  assert.equal(imported.mainCategories.length, 5);
  assert.equal(budget_category(imported, 'Drogerie'), 'lebensmittel');
  assert.equal(imported.subBudgetCaps.lebensmittel, 5000);
});
test('explicit historical mappings beat rules; unassigned remains unassigned', () => {
  const s = setting();
  s.categoryMappings.Carsharing = 'freizeit';
  assert.equal(budget_category(s, 'Carsharing'), 'freizeit');
  s.categoryMappings.Carsharing = '';
  assert.equal(budget_category(s, 'Carsharing'), null);
  assert.equal(budget_category(s, 'Amazon'), null);
});
test('invalid imports reject duplicates, dangling references, cents and bad regex', () => {
  for (const edit of [s => s.mainCategories.push(s.mainCategories[0]), s => s.categoryMappings.Drogerie = 'missing', s => s.subBudgetCaps = { lebensmittel: -1 }, s => s.subBudgetCaps = { lebensmittel: 1.5 }, s => s.rules[0].namePattern = '[']) {
    const s = setting(); edit(s); assert.throws(() => validate_budget_settings(s));
  }
});
test('legacy settings without budget fields remain importable', () => {
  assert.doesNotThrow(() => validate_budget_settings({groups: [], rules: []}));
});
test('budget bars include uncapped and empty budgets, other income excluded and unmapped spend', () => {
  const s = setting();
  const row = (category, cents) => ({ date: new Date(2026, 8, 20), betrag_cents: cents, in_out: cents > 0 ? 'in' : 'out', _cls: { category, group: 'essential' } });
  const rows = [row('Lebensmittel', -2000), row('Drogerie', -1000), row('Drogerie', 500), row('Unknown', -700)];
  const report = build_main_budget_report(rows, new Date(2026,8,14), s.mainCategories, { lebensmittel: 5000 }, c => budget_category(s,c));
  assert.equal(report[0].spentCents, 3000); assert.equal(report[0].pct, 60); assert.equal(report[0].rows.length, 2);
  assert.equal(report[1].spentCents, 0); assert.equal(report.length, 6);
  assert.equal(report.at(-1).spentCents, 700);
});
test('amount corrections retain identity, classification and reload behavior', () => {
  const source = { Datum: '20.09.2026', Name: 'Example', Verwendungszweck: 'Test', Betrag: '-10.00', Kategorie: '' };
  const row = enrich_row({...source}); const id = tx_id(row);
  apply_amount_overrides([row], { [id]: -2500 });
  assert.equal(tx_id(row), id); assert.equal(row.betrag_cents, -2500);
  classify_all([row], setting()); apply_manual_overrides([row], { [id]: 'Drogerie' }, setting());
  assert.equal(row._cls.category, 'Drogerie');
  const reloaded = enrich_row({...source}); apply_amount_overrides([reloaded], { [id]: 500 });
  assert.equal(reloaded.in_out, 'in'); assert.equal(reloaded.betrag_cents, 500); assert.equal(tx_id(reloaded), id);
});
test('renamed main budget retains general entries and colors stay stable', () => {
  const s = setting(); s.mainCategories[0].entryCategory = 'Lebensmittel'; s.mainCategories[0].label = 'Food';
  assert.equal(budget_category(s, 'Lebensmittel'), 'lebensmittel');
  assert.equal(category_color('Drogerie'), category_color('Drogerie'));
  assert.notEqual(category_color('Drogerie'), category_color('Carsharing'));
});

test('multi-condition income rules exclude travel reimbursements by text and amount', () => {
  const rule = { matchers: [
    { field: 'any', operator: 'contains', value: 'Firma' },
    { field: 'purpose', operator: 'regex', value: 'reise|spesen', exclude: true },
    { field: 'amount', operator: 'gt', value: 2000 }
  ] };
  assert.equal(rule_matches({ name: 'Firma GmbH', verwendungszweck: 'Gehalt', betrag_cents: 350000 }, rule), true);
  assert.equal(rule_matches({ name: 'Firma GmbH', verwendungszweck: 'Reise Spesen', betrag_cents: 350000 }, rule), false);
  assert.equal(rule_matches({ name: 'Firma GmbH', verwendungszweck: 'Gehalt', betrag_cents: 50000 }, rule), false);
});

test('merged contract aliases classify to the same persistent contract id', () => {
  const rules = [{
    id: 'streaming', category: 'Streaming', group: 'fixed',
    matchers: [{ field: 'name', operator: 'regex', value: '(?:Google Play Ireland|Google Play HelpPay)' }],
    contractMerges: [{ id: 'google-play', name: 'Streaming · Google Play', payees: ['Google Play Ireland', 'Google Play HelpPay'] }]
  }];
  const setting = { rules };
  for (const name of ['Google Play Ireland', 'Google Play HelpPay']) {
    const result = classify({ name, betrag_cents: -1799 }, setting);
    assert.equal(result.contractId, 'google-play');
    assert.equal(result.contractName, 'Streaming · Google Play');
  }
});

test('a contract merge with an amountCents reference only applies to transactions near that amount', () => {
  const rules = [{
    id: 'insurance', category: 'Versicherungen', group: 'fixed',
    matchers: [{ field: 'name', operator: 'regex', value: '(?:PayPal Europe|ARAG SE)' }],
    contractMerges: [{ id: 'merge-1', name: 'ARAG SE', payees: ['paypal europe', 'arag se'], amountCents: 27798 }]
  }];
  const setting = { rules };
  // Same payee, close to the merge's amount - merges.
  assert.equal(classify({ name: 'PayPal Europe', betrag_cents: -27798 }, setting).contractId, 'merge-1');
  assert.equal(classify({ name: 'ARAG SE', betrag_cents: -27798 }, setting).contractId, 'merge-1');
  // Same payee, unrelated small purchase routed through the same PayPal
  // account - must NOT be swept into the merge just by name.
  assert.equal(classify({ name: 'PayPal Europe', betrag_cents: -499 }, setting).contractId, undefined);
});

test('a contract merge of two clusters keeps BOTH original reference amounts, not their average', () => {
  // Merging a ~139,05€ cluster with a ~111,23€ one must not collapse to a
  // single averaged ~125,14€ reference - a real booking that varies
  // slightly around 139,05€ (e.g. 150,00€) is within tolerance of the real
  // 139,05€ reference but would fall OUTSIDE a ±15% band centered on the
  // average, silently un-merging a genuine member of the original cluster.
  const rules = [{
    id: 'insurance', category: 'Versicherungen', group: 'fixed',
    matchers: [{ field: 'name', operator: 'regex', value: 'HDI Lebensversicherung AG' }],
    contractMerges: [{ id: 'merge-1', name: 'HDI Lebensversicherung AG', payees: ['hdi lebensversicherung ag'], amountCents: [13905, 11123] }]
  }];
  const setting = { rules };
  assert.equal(classify({ name: 'HDI Lebensversicherung AG', betrag_cents: -13905 }, setting).contractId, 'merge-1');
  assert.equal(classify({ name: 'HDI Lebensversicherung AG', betrag_cents: -11123 }, setting).contractId, 'merge-1');
  // Within 15% of 13905 (up to 15990,75) but OUTSIDE 15% of the old
  // averaged 12514 (up to 14391,1) - must still merge. This is the exact
  // real-world case reported: merging a 139,05€ cluster with a 111,23€ one
  // caused a real 152,96€ booking (part of the original 139,05€ cluster's
  // natural variance) to reappear as its own separate "orphan" cluster
  // under the old averaging logic - it must now merge correctly instead.
  assert.equal(classify({ name: 'HDI Lebensversicherung AG', betrag_cents: -15000 }, setting).contractId, 'merge-1');
  assert.equal(classify({ name: 'HDI Lebensversicherung AG', betrag_cents: -15296 }, setting).contractId, 'merge-1');
  // Genuinely unrelated amount, far from either reference - must not merge.
  assert.equal(classify({ name: 'HDI Lebensversicherung AG', betrag_cents: -30000 }, setting).contractId, undefined);
});

test('a recurring payee interval override is exposed to the budget calculation', () => {
  const result = classify({ name: 'Annual insurer', betrag_cents: -12000 }, {
    rules: [{ id: 'insurance', category: 'Insurance', group: 'fixed', namePattern: 'Annual insurer', recurringOverrides: { 'annual insurer': 12 } }]
  });
  assert.deepEqual(result.recurring, { intervalMonths: 12 });
});
