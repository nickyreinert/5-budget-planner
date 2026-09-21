import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich_row } from '../src/data.js';
import { reconcile_paypal, find_internal_transfer_pairs, apply_internal_transfer_pairs, account_key } from '../src/transfers.js';
const row = (Name, Betrag, Bank, Datum = '10.09.2026', group = 'essential') => ({ ...enrich_row({ Datum, Name, Betrag, Bank, Account: Bank, Konto: Bank, Verwendungszweck: '' }), _cls: { category: 'Lebensmittel', group, excluded: group === 'internal_transfer' } });

test('PayPal merchant, funding and bank debit count once with bank account attribution', () => {
  const purchase = row('Shop','-20','PayPal'), funding = row('Bank Account (direct debit)','20','PayPal'), bank = row('PayPal Europe','-20','DKB','12.09.2026','internal_transfer');
  reconcile_paypal([purchase,funding,bank]);
  assert.equal(purchase._cls.excluded,false); assert.equal(purchase._effectiveAccount,account_key(bank));
  assert.equal(funding._cls.excluded,true); assert.equal(bank._cls.excluded,true);
});
test('unique bundled debit preserves every merchant and excludes only settlement', () => {
  const a = row('Shop A','-12','PayPal'), b = row('Shop B','-8','PayPal'), bank = row('PayPal Europe','-20','DKB');
  reconcile_paypal([a,b,bank]);
  assert.equal(a._paypalLinked,true); assert.equal(b._paypalLinked,true); assert.equal(bank._cls.excluded,true);
});
test('missing PayPal history never drops the bank expense', () => {
  const bank = row('PayPal Europe','-20','DKB','12.09.2026','internal_transfer');
  reconcile_paypal([bank]); assert.equal(bank._cls.excluded,false); assert.equal(bank._paypalUnmatched,true);
});
test('ambiguous equal purchases stay visible instead of guessing', () => {
  const rows = [row('Shop A','-20','PayPal'),row('Shop B','-20','PayPal'),row('PayPal Europe','-20','DKB')];
  reconcile_paypal(rows); assert.equal(rows[2]._paypalUnmatched,true); assert.ok(rows.every(r => !r._cls.excluded));
});
test('refunds reconcile separately from purchases and matching is one-to-one', () => {
  const purchase = row('Shop','-20','PayPal'), refund = row('Shop','20','PayPal'), bank = row('PayPal Europe','20','DKB'), second = row('PayPal Europe','20','DKB');
  reconcile_paypal([purchase,refund,bank,second]);
  assert.equal(refund._paypalLinked,true); assert.equal(purchase._paypalLinked,undefined); assert.equal(second._paypalUnmatched,true);
});
test('unrelated opposite amounts and same-account payments never become transfers', () => {
  assert.equal(find_internal_transfer_pairs([row('Shop','-20','DKB'),row('Gift','20','PayPal')],3).length,0);
  assert.equal(find_internal_transfer_pairs([row('Move','-20','DKB',undefined,'internal_transfer'),row('Move','20','DKB',undefined,'internal_transfer')],3).length,0);
});
test('explicit internal transfers need distinct accounts and respect the date window', () => {
  const a = row('Umbuchung','-20','DKB','10.09.2026','internal_transfer'), b = row('Umbuchung','20','Savings','12.09.2026','internal_transfer');
  assert.equal(find_internal_transfer_pairs([a,b],1).length,0);
  const pairs = find_internal_transfer_pairs([a,b],3); assert.equal(pairs.length,1);
  apply_internal_transfer_pairs([a,b],pairs); assert.equal(a._cls.source,'transfer-detection');
});
