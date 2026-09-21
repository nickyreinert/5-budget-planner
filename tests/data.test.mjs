// Run: node --test tests/data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich_row, tx_id } from '../src/data.js';

test('enrich_row derives date/in_out/cents/name from a synthetic (manual-entry) row', () => {
  const row = enrich_row({ Datum: '19.09.2026', Name: 'Supermarkt', Verwendungszweck: '', Kategorie: '', Betrag: '-12.34' });
  assert.equal(row.date.getFullYear(), 2026);
  assert.equal(row.date.getMonth(), 8); // September
  assert.equal(row.date.getDate(), 19);
  assert.equal(row.in_out, 'out');
  assert.equal(row.betrag_cents, -1234);
  assert.equal(row.name, 'Supermarkt');
  assert.deepEqual(row.categories, ['Other']);
});

test('enrich_row output is stable enough for tx_id to key an override', () => {
  const row = enrich_row({ Datum: '19.09.2026', Name: 'Supermarkt', Verwendungszweck: '', Kategorie: '', Betrag: '-12.34' });
  assert.equal(tx_id(row), '19.09.2026|Supermarkt||-1234');
});
