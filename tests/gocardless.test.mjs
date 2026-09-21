// Run: node --test tests/gocardless.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transaction_to_row, transaction_key } from '../src/gocardless.js';
import { enrich_row, tx_id } from '../src/data.js';

test('transaction_to_row: an outgoing payment uses the creditor as the name', () => {
  const tx = {
    bookingDate: '2026-09-15',
    transactionAmount: { amount: '-12.34', currency: 'EUR' },
    creditorName: 'REWE Markt',
    debtorName: 'Max Mustermann',
    remittanceInformationUnstructured: 'Einkauf REWE'
  };
  assert.deepEqual(transaction_to_row(tx), {
    Datum: '15.09.2026',
    Name: 'REWE Markt',
    Verwendungszweck: 'Einkauf REWE',
    Kategorie: '',
    Betrag: '-12.34'
  });
});

test('transaction_to_row: an incoming payment uses the debtor as the name, falls back to valueDate and the unstructured array', () => {
  const tx = {
    valueDate: '2026-09-01',
    transactionAmount: { amount: '3446.68', currency: 'EUR' },
    debtorName: 'Arbeitgeber GmbH',
    remittanceInformationUnstructuredArray: ['Gehalt', 'September 2026']
  };
  assert.deepEqual(transaction_to_row(tx), {
    Datum: '01.09.2026',
    Name: 'Arbeitgeber GmbH',
    Verwendungszweck: 'Gehalt September 2026',
    Kategorie: '',
    Betrag: '3446.68'
  });
});

test('transaction_to_row output round-trips correctly through enrich_row (matches a real CSV row)', () => {
  const tx = { bookingDate: '2026-09-15', transactionAmount: { amount: '-12.34' }, creditorName: 'REWE' };
  const row = enrich_row(transaction_to_row(tx));
  assert.equal(row.date.getFullYear(), 2026);
  assert.equal(row.date.getMonth(), 8);
  assert.equal(row.date.getDate(), 15);
  assert.equal(row.betrag_cents, -1234);
  assert.equal(row.in_out, 'out');
  assert.equal(tx_id(row), '15.09.2026|REWE||-1234');
});

test('transaction_key: prefers a stable GoCardless id when present', () => {
  const tx = { transactionId: 'abc123', bookingDate: '2026-09-15', transactionAmount: { amount: '-12.34' }, creditorName: 'REWE' };
  assert.equal(transaction_key(tx, 'acc-1'), 'gc_acc-1_abc123');
});

test('transaction_key: falls back to internalTransactionId, then a composite key, and is deterministic', () => {
  const withInternal = { internalTransactionId: 'xyz789' };
  assert.equal(transaction_key(withInternal, 'acc-1'), 'gc_acc-1_xyz789');

  const noStableId = { bookingDate: '2026-09-15', transactionAmount: { amount: '-12.34' }, creditorName: 'REWE' };
  const key1 = transaction_key(noStableId, 'acc-1');
  const key2 = transaction_key({ ...noStableId }, 'acc-1');
  assert.equal(key1, key2); // same transaction fetched twice -> same key (dedup on re-sync)
  assert.equal(key1, 'gc_acc-1_2026-09-15_-12.34_REWE');
});
