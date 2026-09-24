import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich_row } from '../src/data.js';
import { reconcile_paypal, find_internal_transfer_pairs, apply_internal_transfer_pairs, find_reversal_pairs, apply_reversal_pairs, account_key } from '../src/transfers.js';
import { tx_id } from '../src/data.js';
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
test('a settlement leg is recognized by PayPal\'s own 17-char transaction ID format even when the bank never writes the word "PayPal" anywhere', () => {
  const purchase = row('Shop','-20','PayPal'), bank = row('1TW73003SD8960608 / Payment','-20','DKB');
  reconcile_paypal([purchase,bank]);
  assert.equal(purchase._paypalLinked,true); assert.equal(bank._cls.excluded,true);
});
test('a settlement leg showing only the underlying MERCHANT name (not "PayPal") is still recognized via PayPal\'s official SEPA creditor ID', () => {
  const purchase = row('1TW73003SD8960608 / Payment','-27.16','PayPal');
  const bank = { ...enrich_row({ Datum: '16.09.2026', Name: '1053073282674/. Decathlon Deutschland', Betrag: '-27.16', Bank: 'DKB', Account: 'DKB', Konto: 'DKB',
    Verwendungszweck: 'Ihr Einkauf bei Decathlon Deutschland, Umsatzart: Folgelastschrift, Referenz: 1053073282674, Mandat: 5B2J224N9V3LJ, Gl\u00e4ubiger-ID: LU96ZZZ0000000000000000058' }),
    _cls: { category: 'Sport', group: 'essential', excluded: false } };
  reconcile_paypal([purchase,bank]);
  assert.equal(purchase._paypalLinked,true); assert.equal(bank._cls.excluded,true);
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

test('manual bank category survives merging its PayPal merchant purchase', () => {
 const purchase=row('Shop','-20','PayPal'), bank=row('PayPal Europe','-20','DKB');
 bank._cls={category:'Dining',group:'essential',source:'manual',excluded:false};bank._matchedManualId='manual-1';
 reconcile_paypal([bank,purchase]);
 assert.equal(purchase._cls.category,'Dining');assert.equal(purchase._matchedManualId,'manual-1');assert.equal(bank._cls.excluded,true);
});

test('a failed top-up and its reversal cancel out while the real purchase stays', () => {
  const topUp = row('Bank Account (direct debit)','43.51','PayPal','19.09.2026');
  const purchase = row('Netto ApS & Co. KG','-43.51','PayPal','19.09.2026');
  const reversal = row('Bank Account','-43.51','PayPal','24.09.2026');
  const rows = [topUp, purchase, reversal];
  const pairs = find_reversal_pairs(rows, 14);
  assert.equal(pairs.length, 1);
  apply_reversal_pairs(rows, pairs);
  assert.equal(topUp._cls.excluded, true);
  assert.equal(reversal._cls.excluded, true);
  assert.equal(purchase._cls.excluded, false);
  assert.equal(topUp._mergeGroup.id, reversal._mergeGroup.id);
  assert.deepEqual(topUp._mergeGroup.members, [tx_id(topUp), tx_id(reversal)]);
});
test('reversals need the same account, a related counterparty and the date window', () => {
  const sameAmountDifferentPayee = [row('Miete','-500','DKB','01.09.2026'), row('Gehalt','500','DKB','03.09.2026')];
  assert.equal(find_reversal_pairs(sameAmountDifferentPayee, 14).length, 0);
  const differentAccounts = [row('Bank Account','-20','PayPal','01.09.2026'), row('Bank Account','20','DKB','03.09.2026')];
  assert.equal(find_reversal_pairs(differentAccounts, 14).length, 0);
  const tooFarApart = [row('Bank Account','-20','PayPal','01.09.2026'), row('Bank Account','20','PayPal','30.09.2026')];
  assert.equal(find_reversal_pairs(tooFarApart, 14).length, 0);
});
test('a transaction split out by hand is never merged again', () => {
  const topUp = row('Bank Account (direct debit)','43.51','PayPal','19.09.2026');
  const reversal = row('Bank Account','-43.51','PayPal','24.09.2026');
  assert.equal(find_reversal_pairs([topUp, reversal], 14, new Set([tx_id(reversal)])).length, 0);
});
test('merged PayPal legs are grouped so the UI can list them together', () => {
  const purchase = row('Shop','-20','PayPal'), bank = row('PayPal Europe','-20','DKB');
  reconcile_paypal([purchase, bank]);
  assert.equal(purchase._mergeGroup.kind, 'paypal');
  assert.equal(purchase._mergeGroup.id, bank._mergeGroup.id);
});
test('an exact single match wins over an unrelated subset that happens to add up to the same total', () => {
  const aldi = row('ALDI Nord','-34.43','PayPal','15.09.2026');
  const topUp = row('Bank Account (direct debit)','34.43','PayPal','15.09.2026');
  const other1 = row('Shop A','-20','PayPal','14.09.2026');
  const other2 = row('Shop B','-14.43','PayPal','14.09.2026');
  const bank = { ...enrich_row({ Datum: '16.09.2026', Name: 'PayPal Europe S.a.r.l. et Cie S.C.A', Betrag: '-34.43', Bank: 'DKB', Account: 'DKB', Konto: 'DKB',
    Verwendungszweck: '1053077432981/. ALDI Nord , Ihr Einkauf bei ALDI Nord' }),
    _cls: { category: 'Lebensmittel', group: 'essential', excluded: false } };
  const rows = [aldi, topUp, other1, other2, bank];
  reconcile_paypal(rows);
  assert.equal(bank._cls.excluded, true);
  assert.equal(aldi._paypalLinked, true);
  assert.equal(aldi._cls.excluded, false);
  assert.equal(other1._cls.excluded, false);
  assert.equal(other2._cls.excluded, false);
  // Settlement, purchase and wallet top-up are one booking.
  assert.deepEqual(new Set(aldi._mergeGroup.members), new Set([tx_id(bank), tx_id(aldi), tx_id(topUp)]));
  assert.equal(topUp._mergeGroup.id, bank._mergeGroup.id);
});
test('several same-amount purchases are disambiguated by the merchant the settlement line names', () => {
  const aldi = row('ALDI Nord','-34.43','PayPal','15.09.2026');
  const netto = row('Netto Marken-Discount','-34.43','PayPal','15.09.2026');
  const bank = { ...enrich_row({ Datum: '16.09.2026', Name: 'PayPal Europe S.a.r.l. et Cie S.C.A', Betrag: '-34.43', Bank: 'DKB', Account: 'DKB', Konto: 'DKB',
    Verwendungszweck: '1053077432981/. ALDI Nord , Ihr Einkauf bei ALDI Nord' }),
    _cls: { category: 'Lebensmittel', group: 'essential', excluded: false } };
  reconcile_paypal([aldi, netto, bank]);
  assert.equal(aldi._paypalLinked, true);
  assert.equal(netto._paypalLinked, undefined);
  assert.equal(bank._cls.excluded, true);
});
