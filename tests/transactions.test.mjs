import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich_row, tx_id, apply_amount_overrides } from '../src/data.js';
import { csv_records, reconcile_transactions } from '../src/transactions.js';
import { classify_all, apply_manual_overrides } from '../src/rules.js';
const row = (fields = {}) => enrich_row({ Datum: '20.09.2026', Name: 'Shop', Verwendungszweck: 'Ref 1', Kategorie: '', Betrag: '-12.34', ...fields });

test('overlapping imports upsert occurrences and preserve earlier history', () => {
  const store = new Map();
  const upsert = rows => csv_records(rows).forEach(r => store.set(r.id, r));
  upsert([row(), row(), row({ Datum: '19.09.2026' })]);
  upsert([row(), row()]);
  assert.equal(store.size, 3);
  upsert([row({ Kategorie: 'Changed' })]);
  assert.equal(store.size, 3);
  assert.equal([...store.values()][0].Kategorie, 'Changed');
});

test('manual and import match exact signed cents and date one-to-one', () => {
  const imports = csv_records([row()]);
  const manual = [row({ id: 'a', Name: 'Manual A' }), row({ id: 'b', Name: 'Manual B' }), row({ id: 'c', Betrag: '12.34' }), row({ id: 'd', Datum: '21.09.2026' })];
  const result = reconcile_transactions(imports, manual);
  assert.equal(result.length, 4);
  assert.equal(result[0]._matchedManualId, 'a');
  assert.equal(result.reduce((sum, r) => sum + r.betrag_cents, 0), -2468);
  assert.deepEqual(reconcile_transactions(imports, manual), result);
  assert.equal(imports[0]._matchedManualId, undefined);
});

test('matched rows retain manual category and imported amount edits across rebuilds', () => {
  const manual = row({ id: 'a', _txId: 'manual:a', Name: 'Lunch' });
  const imports = csv_records([row()]);
  const rows = reconcile_transactions(imports, [manual]);
  const settings = { rules: [{ id: 'food', category: 'Food', group: 'essential' }] };
  classify_all(rows, settings);
  apply_manual_overrides(rows, { [tx_id(manual)]: 'Food' }, settings);
  assert.equal(rows[0]._cls.category, 'Food');
  apply_amount_overrides(rows, { [tx_id(rows[0])]: -1500 });
  const rebuilt = reconcile_transactions(imports, [manual]);
  apply_amount_overrides(rebuilt, { [tx_id(rows[0])]: -1500 });
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].betrag_cents, -1500);
});

test('manual-only bookings stay separate and legacy override identities survive CSV migration', () => {
  const manual = [row({ id: 'a', _txId: 'manual:a' }), row({ id: 'b', _txId: 'manual:b' })];
  const result = reconcile_transactions([], manual);
  assert.equal(result.length, 2);
  assert.notEqual(tx_id(result[0]), tx_id(result[1]));
  const legacy = row();
  const migrated = reconcile_transactions(csv_records([legacy]), []);
  apply_amount_overrides(migrated, { [tx_id(legacy)]: -2000 });
  assert.equal(migrated[0].betrag_cents, -2000);
});

test('bank sync, CSV and manual sources reconcile to one booking regardless of store order', () => {
  const bank = row({ id: 'gc:a', source: 'gocardless' });
  const manual = row({ id: 'a', _txId: 'manual:a' });
  for (const inputs of [[manual, bank], [bank, manual]]) {
    assert.equal(reconcile_transactions([], inputs).length, 1);
    const result = reconcile_transactions(csv_records([row()]), inputs);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]._sources, ['csv', 'gocardless', 'manual']);
  }
});


test('CSV identity preserves accounts across storage and distinguishes identical cross-account bookings', () => {
  const raw = { Datum:'20.09.2026',Name:'Shop',Verwendungszweck:'',Kategorie:'',Betrag:'-10' };
  const records=csv_records([enrich_row({...raw,Bank:'DKB',Account:'Checking',Konto:'Checking'}),enrich_row({...raw,Bank:'PayPal',Account:'PayPal',Konto:'Wallet'})]);
  assert.notEqual(records[0].id,records[1].id);
  assert.equal(reconcile_transactions(records,[])[1].Bank,'PayPal');
});

test('recipient Konto/Bank are never used as the source account', async () => {
 const {parse_csv_rows,default_csv_config}=await import('../src/csv_config.js');
 const {account_key}=await import('../src/transfers.js');
 const text='Datum;Name;Verwendungszweck;Betrag;Konto;Bank\n20.09.2026;Shop;Purchase;-10,00;DE123;BICCODE';
 assert.equal(account_key(parse_csv_rows(text,default_csv_config())[0]),'Konto unbekannt');
 assert.equal(account_key(parse_csv_rows(text,{...default_csv_config(),accountName:'DKB Giro'})[0]),'DKB Giro');
 assert.equal(account_key(parse_csv_rows(text.replace('Konto;Bank','Kontoname;Bank').replace('DE123','PayPal'),default_csv_config())[0]),'PayPal');
});
