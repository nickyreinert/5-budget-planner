import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich_row } from '../src/data.js';
import { reconcile_paypal, find_internal_transfer_pairs, apply_internal_transfer_pairs, find_reversal_pairs, apply_reversal_pairs, account_key, clear_merge_groups } from '../src/transfers.js';
import { tx_id } from '../src/data.js';
import { classify_all } from '../src/rules.js';
import { build_budget_basis, rule_monthly_equivalent } from '../src/week.js';
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
test('an unlinkable settlement leg is shown under the merchant it names, not the collector', () => {
  const aldi = { ...enrich_row({ Datum: '16.09.2026', Name: 'PayPal Europe S.a.r.l. et Cie S.C.A', Betrag: '-34.43', Bank: 'DKB', Account: 'DKB', Konto: 'DKB',
    Verwendungszweck: '1053077432981/. ALDI Nord , Ihr Einkauf bei ALDI Nord' }), _cls: { category: 'Lebensmittel', group: 'essential', excluded: false } };
  const decathlon = { ...enrich_row({ Datum: '16.09.2026', Name: '1053073282674/. Decathlon Deutschland', Betrag: '-27.16', Bank: 'DKB', Account: 'DKB', Konto: 'DKB',
    Verwendungszweck: 'Ihr Einkauf bei Decathlon Deutschland, Umsatzart: Folgelastschrift, Gl\u00e4ubiger-ID: LU96ZZZ0000000000000000058' }), _cls: { category: 'Sport', group: 'essential', excluded: false } };
  reconcile_paypal([aldi, decathlon]);
  assert.equal(aldi._displayName, 'ALDI Nord');
  assert.equal(decathlon._displayName, 'Decathlon Deutschland');
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
 bank._matchedManual={Name:'Original manual purchase',Datum:'12.09.2026'};
 bank._reconciliation={status:'matched',importedId:tx_id(bank),candidateIds:[tx_id(bank)]};
 reconcile_paypal([bank,purchase]);
 assert.equal(purchase._cls.category,'Dining');assert.equal(purchase._matchedManualId,'manual-1');assert.equal(bank._cls.excluded,true);
 assert.equal(purchase._reconciliation.importedId,tx_id(bank));assert.equal(purchase._matchedManual.Name,'Original manual purchase');
});

const arag_payment = () => {
  const purchase = enrich_row({ Datum: '01.09.2026', Name: 'ARAG SE', Betrag: '-270.00', Account: 'PayPal',
    Verwendungszweck: '1TW73003SD8960608 / Payment, Umsatzart: Payment' });
  const funding = enrich_row({ Datum: '01.09.2026', Name: 'Bank Account (direct debit)', Betrag: '270.00', Account: 'PayPal', Verwendungszweck: 'Wallet funding' });
  const bank = enrich_row({ Datum: '02.09.2026', Name: 'PayPal Europe S.a.r.l. et Cie S.C.A', Betrag: '-270.00', Account: 'DKB',
    Verwendungszweck: '000123/PP.9999.PP/. Arag SE, Ihr Einkauf bei Arag SE, Umsatzart: Folgelastschrift' });
  const ruleSet = { rules: [{ id: 'arag-bank', category: 'Versicherungen.Rechtsschutz', group: 'fixed', recurring: { intervalMonths: 6 },
    matchers: [{ field: 'name', operator: 'contains', value: 'PayPal Europe' }, { field: 'purpose', operator: 'contains', value: 'Arag SE' }],
    contractMerges: [{ id: 'arag-contract', name: 'ARAG SE', payees: ['paypal europe'], amountCents: 27000 }] }] };
  return { purchase, funding, bank, rows: [bank, purchase, funding], ruleSet };
};

test('a bank-only ARAG rule classifies the real merchant and labels its settlement and funding legs without changing raw data', () => {
  const { purchase, funding, bank, rows, ruleSet } = arag_payment();
  const originals = rows.map(r => ({ id: tx_id(r), Name: r.Name, name: r.name, Verwendungszweck: r.Verwendungszweck, verwendungszweck: r.verwendungszweck }));
  classify_all(rows, ruleSet);
  const classification = { ...bank._cls };
  assert.equal(purchase._cls.group, 'unclassified');
  reconcile_paypal(rows);
  assert.deepEqual(purchase._cls, classification);
  assert.equal(purchase._cls.group, 'fixed');
  assert.equal(purchase._cls.recurring.intervalMonths, 6);
  assert.equal(purchase._cls.contractId, 'arag-contract');
  assert.equal(bank._cls.excluded, true);
  assert.equal(funding._cls.excluded, true);
  assert.equal(bank._displayName, 'ARAG SE');
  assert.equal(funding._displayName, 'ARAG SE');
  assert.equal(purchase._displayName, undefined);
  assert.deepEqual(rows.map(r => ({ id: tx_id(r), Name: r.Name, name: r.name, Verwendungszweck: r.Verwendungszweck, verwendungszweck: r.verwendungszweck })), originals);
});

test('settlement rules fill missing and bank-fallback categories, while merchant rules and manual categories win', () => {
  const cases = [
    [{ source: 'none', category: 'Unkategorisiert', group: 'unclassified' }, true],
    [{ source: 'bank', category: 'Shopping', group: 'essential' }, true],
    [{ source: 'rule', category: 'Unkategorisiert', group: 'unclassified' }, true],
    [{ source: 'rule', ruleId: 'merchant', category: 'Own rule', group: 'fixed' }, false],
    [{ source: 'manual', category: 'Own manual', group: 'essential' }, false],
    [{ source: 'manual', category: 'Unkategorisiert', group: 'unclassified' }, false]
  ];
  for (const [merchantClassification, inherits] of cases) {
    const { purchase, bank, rows, ruleSet } = arag_payment();
    classify_all(rows, ruleSet);
    purchase._cls = { ...merchantClassification, excluded: false };
    reconcile_paypal(rows);
    assert.equal(purchase._cls.category, inherits ? 'Versicherungen.Rechtsschutz' : merchantClassification.category);
    assert.equal(bank._cls.excluded, true);
  }
});

test('merchant interval overrides apply to inherited rule and manual classifications and keep the budget basis in sync', () => {
  for (const source of ['rule', 'manual']) {
    const { purchase, bank, rows, ruleSet } = arag_payment();
    ruleSet.rules[0].recurringOverrides = { 'arag se': 3 };
    classify_all(rows, ruleSet);
    assert.equal(bank._cls.recurring.intervalMonths, 6);
    if (source === 'manual') { bank._cls.source = 'manual'; bank._cls.ruleId = null; }
    reconcile_paypal(rows, 7, new Set(), ruleSet);
    assert.equal(purchase._cls.recurring.intervalMonths, 3);
    assert.equal(bank._cls.recurring.intervalMonths, 6, 'copying must not change the original bank interval');
    assert.equal(build_budget_basis(rows).fixedCents, 9000);
    assert.equal(rule_monthly_equivalent(rows, ruleSet.rules[0].recurringOverrides).totalCents, 9000);
  }
});

test('missing or invalid merchant interval overrides preserve the inherited bank interval', () => {
  for (const override of [undefined, 0, -1, 2, 18, 'invalid']) {
    const { purchase, rows, ruleSet } = arag_payment();
    ruleSet.rules[0].recurringOverrides = { 'arag se': override };
    classify_all(rows, ruleSet);
    reconcile_paypal(rows, 7, new Set(), ruleSet);
    assert.equal(purchase._cls.recurring.intervalMonths, 6);
  }
});

test('manual settlement category precedence is preserved, and a manual merchant still wins', () => {
  for (const merchantSource of ['rule', 'manual']) {
    const { purchase, bank, rows, ruleSet } = arag_payment();
    classify_all(rows, ruleSet);
    bank._cls = { category: 'Settlement manual', group: 'essential', source: 'manual', excluded: false };
    purchase._cls = { category: 'Merchant category', group: 'fixed', source: merchantSource, excluded: false };
    reconcile_paypal(rows);
    assert.equal(purchase._cls.category, merchantSource === 'manual' ? 'Merchant category' : 'Settlement manual');
  }
});

test('excluded, transfer and unclassified settlement rules never classify a real payment', () => {
  for (const donor of [{ group: 'fixed', excluded: true }, { group: 'internal_transfer', excluded: false }, { group: 'unclassified', excluded: false }]) {
    const { purchase, bank, rows } = arag_payment();
    purchase._cls = { category: 'Unkategorisiert', group: 'unclassified', source: 'none', excluded: false };
    bank._cls = { source: 'rule', category: 'Settlement category', ...donor };
    reconcile_paypal(rows);
    assert.equal(purchase._cls.category, 'Unkategorisiert');
    assert.equal(purchase._cls.excluded, false);
  }
});

test('a bundled settlement keeps distinct merchant classifications and does not invent a single merchant label', () => {
  const a = row('Shop A', '-12', 'PayPal'), b = row('Shop B', '-8', 'PayPal'), bank = row('PayPal Europe', '-20', 'DKB');
  const funding = row('Bank Account (direct debit)', '20', 'PayPal');
  a._cls = { category: 'Unkategorisiert', group: 'unclassified', source: 'none', excluded: false };
  b._cls = { category: 'Other shopping', group: 'essential', source: 'rule', excluded: false };
  bank._cls = { category: 'Insurance', group: 'fixed', source: 'rule', excluded: false, recurring: { intervalMonths: 6 } };
  reconcile_paypal([bank, a, b, funding]);
  assert.equal(a._cls.category, 'Unkategorisiert');
  assert.equal(b._cls.category, 'Other shopping');
  assert.equal(a._cls.excluded, false);
  assert.equal(b._cls.excluded, false);
  assert.equal(bank._cls.excluded, true);
  assert.equal(bank._displayName, undefined);
  assert.equal(funding._displayName, undefined);
});

test('splitting and reclassifying removes derived merchant labels and restores each original classification', () => {
  const { purchase, funding, bank, rows, ruleSet } = arag_payment();
  classify_all(rows, ruleSet);
  reconcile_paypal(rows);
  assert.equal(bank._displayName, 'ARAG SE');
  assert.equal(funding._displayName, 'ARAG SE');
  classify_all(rows, ruleSet);
  clear_merge_groups(rows);
  reconcile_paypal(rows, 7, new Set([tx_id(bank)]));
  assert.equal(bank._displayName, undefined);
  assert.equal(funding._displayName, undefined);
  assert.equal(bank.name, 'PayPal Europe S.a.r.l. et Cie S.C.A');
  assert.equal(bank._cls.group, 'fixed');
  assert.equal(bank._cls.excluded, false);
  assert.equal(purchase._cls.group, 'unclassified');
  assert.equal(purchase._mergeGroup, undefined);
  classify_all(rows, { rules: [] });
  clear_merge_groups(rows);
  reconcile_paypal(rows);
  assert.equal(purchase._cls.group, 'unclassified');
  assert.equal(bank._displayName, 'ARAG SE');
  assert.equal(funding._displayName, 'ARAG SE');
});

test('a bank-only ARAG booking strips PayPal references from its merchant label while preserving its raw purpose', () => {
  for (const purpose of [
    '000123/PP.9999.PP/. Arag SE, Ihr Einkauf bei Arag SE, Umsatzart: Folgelastschrift',
    '000123/PP.9999.PP/. Arag SE, Umsatzart: Folgelastschrift',
    'PayPal collection, Ihr Einkauf bei Arag SE, Umsatzart: Folgelastschrift'
  ]) {
    const bank = enrich_row({ Datum: '02.09.2026', Name: 'PayPal Europe S.a.r.l. et Cie S.C.A', Betrag: '-270.00', Account: 'DKB', Verwendungszweck: purpose });
    bank._cls = { category: 'Insurance', group: 'fixed', source: 'rule', excluded: false };
    const id = tx_id(bank);
    reconcile_paypal([bank]);
    assert.equal(bank._displayName, 'Arag SE');
    assert.equal(bank.Verwendungszweck, purpose);
    assert.equal(bank.verwendungszweck, purpose);
    assert.equal(tx_id(bank), id);
    assert.equal(bank._cls.excluded, false);
  }
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
test('without any account column, PayPal ledger lines are still recognized by their booking reference', () => {
  const plain = (Datum, Name, Betrag, Verwendungszweck) => ({ ...enrich_row({ Datum, Name, Betrag, Verwendungszweck }), _cls: { category: 'Lebensmittel', group: 'essential', excluded: false } });
  const purchase = plain('15.09.2026', 'ALDI Nord', '-34.43', '33J907732G7745748 / Payment, Umsatzart: Payment');
  const bank = plain('16.09.2026', 'PayPal Europe S.a.r.l. et Cie S.C.A', '-34.43', '1053077432981/. ALDI Nord , Ihr Einkauf bei ALDI Nord, Umsatzart: Folgelastschrift');
  reconcile_paypal([purchase, bank]);
  assert.equal(account_key(purchase), 'PayPal'); assert.equal(account_key(bank), 'Konto unbekannt');
  assert.equal(purchase._paypalLinked, true); assert.equal(bank._cls.excluded, true); assert.equal(purchase._cls.excluded, false);
});
