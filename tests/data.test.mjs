// Run: node --test tests/data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich_row, tx_id, apply_amount_overrides, apply_note_overrides, apply_date_overrides } from '../src/data.js';

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

test('matched manual edits cannot replace authoritative imported booking details', () => {
  for (const source of ['csv', 'gocardless']) {
    const row = enrich_row({ _txId: `${source}:booking`, source, _matchedManualTxId: 'manual:entry',
      Datum: '19.09.2026', Name: 'Example merchant', Verwendungszweck: 'Bank reference', Betrag: '-12.34' });
    apply_amount_overrides([row], { 'manual:entry': -2200 });
    apply_note_overrides([row], { 'manual:entry': 'Personal note' });
    apply_date_overrides([row], { 'manual:entry': '2026-09-17' });
    assert.equal(row.betrag_cents, -1234);
    assert.equal(row.Verwendungszweck, 'Bank reference');
    assert.equal(row.date.getDate(), 19);

    apply_amount_overrides([row], { [`${source}:booking`]: -1500 });
    apply_note_overrides([row], { [`${source}:booking`]: 'Booking edit' });
    apply_date_overrides([row], { [`${source}:booking`]: '2026-09-18' });
    assert.equal(row.betrag_cents, -1500);
    assert.equal(row.Verwendungszweck, 'Booking edit');
    assert.equal(row.date.getDate(), 18);
    assert.equal(tx_id(row), `${source}:booking`);
  }
});

test('unmatched manual bookings still apply their own amount, note and date corrections', () => {
  const row = enrich_row({ _txId: 'manual:entry', source: 'manual',
    Datum: '19.09.2026', Name: 'Example purchase', Verwendungszweck: '', Betrag: '-12.34' });
  apply_amount_overrides([row], { 'manual:entry': -2200 });
  apply_note_overrides([row], { 'manual:entry': 'Personal note' });
  apply_date_overrides([row], { 'manual:entry': '2026-09-17' });
  assert.equal(row.betrag_cents, -2200);
  assert.equal(row.Verwendungszweck, 'Personal note');
  assert.equal(row.date.getDate(), 17);
  assert.equal(tx_id(row), 'manual:entry');
});

import { apply_ignored_transactions, is_real_cashflow, is_visible_transaction, category_transactions, transaction_list_order } from '../src/data.js';
test('ignore follows a reconciled manual expense, remains visible and can be restored explicitly', () => {
  const bank = enrich_row({ _txId: 'csv:1', _matchedManualTxId: 'manual:1', Datum: '01.10.2026', Name: 'Shop', Betrag: '-10.00' });
  bank._cls = { group: 'discretionary', category: 'Food' };
  apply_ignored_transactions([bank], { 'manual:1': true });
  assert.equal(is_real_cashflow(bank), false);
  assert.equal(is_visible_transaction(bank), true);
  assert.deepEqual(category_transactions([bank], 'Food'), []);
  assert.deepEqual(category_transactions([bank], 'Food', { includeIgnored: true }), [bank]);
  apply_ignored_transactions([bank], { 'manual:1': true, 'csv:1': false });
  assert.equal(is_real_cashflow(bank), true);
  bank._cls.excluded = true;
  assert.equal(is_visible_transaction(bank), false);
});

test('ignored transactions follow all active rows, regardless of booking date', () => {
  const rows = [ { date: new Date('2026-10-02'), _ignored: true }, { date: new Date('2026-09-30') }, { date: new Date('2026-10-01') } ];
  assert.deepEqual([...rows].sort(transaction_list_order), [rows[2], rows[1], rows[0]]);
});
