import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrich_row, tx_id, apply_amount_overrides, build_group_summary } from '../src/data.js';
import { csv_records, csv_import_ranges, reconcile_transactions, reconciliation_summary,
  get_manual_match_days, save_manual_match_days, transaction_source_label } from '../src/transactions.js';
import { classify_all, apply_manual_overrides } from '../src/rules.js';
import { set_language } from '../src/i18n.js';
const row = (fields = {}) => enrich_row({ Datum: '20.09.2026', Name: 'Shop', Verwendungszweck: 'Ref 1', Kategorie: '', Betrag: '-12.34', ...fields });
const manualRow = (id, fields = {}) => row({ id, _txId: `manual:${id}`, source: 'manual', ...fields });
const coverage = (from = '2026-09-01', to = '2026-09-30', account = '') => [{ id: 'range', account, from, to }];

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

test('two manual entries claiming one bank booking remain ambiguous instead of choosing the first', () => {
  const imports = csv_records([row()]);
  const manual = [manualRow('a', { Name: 'Manual A' }), manualRow('b', { Name: 'Manual B' }), manualRow('c', { Betrag: '12.34' }), manualRow('d', { Datum: '24.09.2026' })];
  const options = { importRanges: coverage() };
  const result = reconcile_transactions(imports, manual, {}, options);
  assert.equal(result.length, 5);
  assert.equal(result[0]._matchedManualId, undefined);
  assert.deepEqual(result.slice(1).map(r => r._reconciliation.status), ['ambiguous', 'ambiguous', 'unassigned', 'unassigned']);
  assert.deepEqual(result[1]._reconciliation.candidateIds, [imports[0].id]);
  assert.equal(result.reduce((sum, r) => sum + r.betrag_cents, 0), -3702);
  assert.deepEqual(reconcile_transactions(imports, manual, {}, options), result);
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

test('booked DKB sync matches a manual entry by date and signed cents and retains its category', async () => {
  const {transaction_to_row}=await import('../src/gocardless.js');
  const bank={...transaction_to_row({bookingDate:'2026-09-20',transactionAmount:{amount:'-12.34'},creditorName:'Bank merchant'}),id:'gc_dkb_1',source:'gocardless',_account:'DKB'};
  const manual=row({id:'manual-1',_txId:'manual:1',source:'manual',Kategorie:'Dining'});
  const settings={rules:[{id:'bank',category:'Food',group:'essential',namePattern:'Bank merchant'},{id:'dining',category:'Dining',group:'essential',matchers:[{field:'any',operator:'contains',value:'',exclude:false}]}],mainCategories:[{id:'daily',label:'Daily'}]};
  const result=reconcile_transactions([], [bank,manual]);
  classify_all(result,settings);apply_manual_overrides(result,{},settings);
  assert.equal(result.length,1);assert.equal(result[0]._cls.category,'Dining');assert.equal(result[0]._matchedManualId,'manual-1');
  // An overlapping CSV later still leaves one booking with the same manual choice.
  const withCSV=reconcile_transactions(csv_records([enrich_row({...bank})]),[bank,manual]);
  classify_all(withCSV,settings);apply_manual_overrides(withCSV,{},settings);
  assert.equal(withCSV.length,1);assert.equal(withCSV[0]._cls.category,'Dining');
});

test('unmatched bank imports follow rules then uncategorized/additional-income fallbacks', () => {
  const rows=reconcile_transactions([], [row({id:'gc1',source:'gocardless',Name:'Shop'}),row({id:'gc2',source:'gocardless',Name:'Unknown',Betrag:'-8'}),row({id:'gc3',source:'gocardless',Name:'Gift',Betrag:'25'})]);
  classify_all(rows,{rules:[{id:'food',category:'Food',group:'essential',namePattern:'Shop'}]});
  assert.deepEqual(rows.map(r=>r._cls.category),['Food','Unkategorisiert','Zusätzliche Einnahmen']);
  assert.equal(rows[2]._cls.incomeType,'other');
});

test('one manual entry with multiple matching bank bookings remains unresolved', () => {
  const imports=csv_records([row(),row(),row({Betrag:'12.34'}),row({Datum:'21.09.2026'})]);
  const manual=[row({id:'m',_txId:'manual:m',source:'manual',Kategorie:'Unkategorisiert'})];
  const result=reconcile_transactions(imports,manual,{}, {importRanges:coverage()});
  assert.equal(result.length,5);assert.equal(result.filter(r=>r._matchedManualId).length,0);
  assert.equal(result[4]._reconciliation.status,'ambiguous');
  assert.deepEqual(result[4]._reconciliation.candidateIds,[imports[0].id,imports[1].id,imports[3].id].sort());
  classify_all(result,{rules:[]});apply_manual_overrides(result,{}, {rules:[]});
  assert.equal(result[4]._cls.category,'Unkategorisiert');
});

test('unique signed-cent matches retain bank facts and only inherit the manual classification', () => {
  const imports = csv_records([row({ Datum: '23.09.2026', Name: 'Bank merchant', Verwendungszweck: 'Bank reference', Kategorie: 'Imported category' })]);
  const manual = manualRow('lunch', { Name: 'Lunch', Verwendungszweck: 'Original manual note', Kategorie: 'Dining' });
  const [matched] = reconcile_transactions(imports, [manual]);
  assert.equal(matched._matchedManualId, 'lunch');
  assert.equal(matched.Datum, '23.09.2026');
  assert.equal(matched.Name, 'Bank merchant');
  assert.equal(matched.Verwendungszweck, 'Bank reference');
  assert.equal(matched.betrag_cents, -1234);
  assert.equal(matched.Kategorie, 'Imported category');
  assert.equal(matched._matchedManualCategory, 'Dining');
  assert.equal(matched._matchedManual.Datum, '20.09.2026');
  assert.equal(matched._matchedManual.Verwendungszweck, 'Original manual note');
  assert.equal(matched._matchedManual.cents, -1234);
  assert.equal(matched._reconciliation.status, 'matched');
  assert.deepEqual(matched._sources, ['csv', 'manual']);
  assert.equal(manual._reconciliation, undefined);
});

test('matching uses corrected manual amount and date without transferring edits to bank facts', () => {
  const imports = csv_records([row({ Datum: '25.09.2026', Betrag: '-15', Verwendungszweck: 'Bank note' })]);
  const manual = manualRow('m');
  const options = { dateOverrides: { 'manual:m': '2026-09-23' } };
  const [matched] = reconcile_transactions(imports, [manual], { 'manual:m': -1500 }, options);
  assert.equal(matched._matchedManualId, 'm');
  assert.equal(matched.betrag_cents, -1500);
  assert.equal(matched.Datum, '25.09.2026');
  assert.equal(matched.date.getDate(), 25);
  assert.equal(matched.Verwendungszweck, 'Bank note');
  assert.equal(matched._matchedManual.cents, -1234);
  assert.equal(matched._matchedManual.effectiveCents, -1500);
  assert.equal(matched._matchedManual.effectiveDate, '2026-09-23');
  assert.equal(manual.date.getDate(), 20);
  assert.equal(manual.betrag_cents, -1234);
});

test('day tolerance is inclusive in both directions and configurable down to exact date', () => {
  for (const date of ['17.09.2026', '23.09.2026']) {
    const imports = csv_records([row({ Datum: date })]);
    assert.equal(reconcile_transactions(imports, [manualRow('m')]).length, 1);
    assert.equal(reconcile_transactions(imports, [manualRow('m')], {}, { maxDays: 2 }).length, 2);
  }
  assert.equal(reconcile_transactions(csv_records([row({ Datum: '21.09.2026' })]), [manualRow('m')], {}, { maxDays: 0 }).length, 2);
  assert.equal(reconcile_transactions(csv_records([row({ Datum: '24.09.2026' })]), [manualRow('m')]).length, 2);
});

test('date tolerance compares calendar days across the daylight-saving boundary', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    const manual = manualRow('m', { Datum: '23.10.2026' });
    const imports = csv_records([row({ Datum: '26.10.2026' })]);
    assert.equal(reconcile_transactions(imports, [manual], {}, { maxDays: 3 }).length, 1);
    assert.equal(reconcile_transactions(imports, [manual], {}, { maxDays: 2 }).length, 2);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('currency, sign, and a known manual source account constrain candidates', () => {
  const imports = csv_records([row({ _account: 'Checking' })]);
  const mismatches = [manualRow('positive', { Betrag: '12.34' }), manualRow('currency', { Währung: 'USD' }), manualRow('account', { _account: 'Savings' })];
  assert.equal(reconcile_transactions(imports, mismatches).length, 4);
  assert.ok(reconcile_transactions(imports, mismatches).slice(1).every(r => r._reconciliation.candidateIds.length === 0));
  assert.equal(reconcile_transactions(imports, [manualRow('known', { _account: 'Checking' })]).length, 1);
  assert.equal(reconcile_transactions(imports, [manualRow('unknown')]).length, 1);
  assert.equal(reconcile_transactions(csv_records([row({ _account: '' })]), [manualRow('known', { _account: 'Checking' })]).length, 2);
});

test('same-number bank bookings in different currencies retain separate identities across uploads', () => {
  const eur = csv_records([row({ _account: 'Checking', Währung: 'EUR' })])[0];
  const usd = csv_records([row({ _account: 'Checking', Währung: 'USD' })])[0];
  assert.notEqual(eur.id, usd.id);
  assert.equal(csv_records([row({ _account: 'Checking' })])[0].id, eur.id);
  assert.equal(new Map([[eur.id, eur], [usd.id, usd]]).size, 2);
});

test('coverage is inclusive, keeps upload gaps, and respects known manual accounts', () => {
  const ranges = [...coverage('2026-09-01', '2026-09-05', 'Checking'), ...coverage('2026-09-20', '2026-09-25', 'Checking')];
  const manual = [manualRow('start', { Datum: '01.09.2026', _account: 'Checking' }), manualRow('end', { Datum: '25.09.2026', _account: 'Checking' }),
    manualRow('gap', { Datum: '10.09.2026' }), manualRow('other', { _account: 'Savings' }), manualRow('unknown')];
  const result = reconcile_transactions([], manual, {}, { importRanges: ranges });
  assert.deepEqual(result.map(r => r._reconciliation.status), ['unassigned', 'unassigned', 'pending', 'pending', 'unassigned']);
  assert.ok(result.every(r => r._reconciliation.candidateIds.length === 0));
});

test('uncovered ambiguity stays pending until the corresponding import range exists', () => {
  const imports = csv_records([row(), row()]);
  const result = reconcile_transactions(imports, [manualRow('m')]);
  assert.equal(result[2]._reconciliation.status, 'pending');
  assert.equal(result[2]._reconciliation.candidateIds.length, 2);
  assert.equal(reconciliation_summary(result).count, 0);
});

test('separate and cash decisions prevent automatic matching and retain their meaning after reload', () => {
  const imports = csv_records([row()]);
  const manual = [manualRow('cash'), manualRow('separate')];
  const options = { importRanges: coverage(), decisions: { cash: { kind: 'cash' }, separate: { kind: 'separate' } } };
  const result = reconcile_transactions(imports, manual, {}, options);
  assert.equal(result.length, 3);
  assert.deepEqual(result.slice(1).map(r => r._reconciliation.status), ['cash', 'unassigned']);
  assert.equal(result[1]._reconciliation.decisionKind, 'cash');
  assert.equal(result[2]._reconciliation.decisionKind, 'separate');
  assert.deepEqual(result[2]._reconciliation.candidateIds, [imports[0].id]);
  assert.deepEqual(reconcile_transactions(JSON.parse(JSON.stringify(imports)), JSON.parse(JSON.stringify(manual)), {}, JSON.parse(JSON.stringify(options))), result);
  const outside = reconcile_transactions(imports, [manual[1]], {}, { decisions: options.decisions });
  assert.equal(outside[1]._reconciliation.status, 'pending');
});

test('an explicit choice resolves bank ambiguity and cannot consume the same booking twice', () => {
  const imports = csv_records([row(), row({ Name: 'Second shop' })]);
  const manual = [manualRow('a'), manualRow('b')];
  const options = { importRanges: coverage(), decisions: { a: { kind: 'match', importedId: imports[1].id } } };
  const result = reconcile_transactions(imports, manual, {}, options);
  assert.equal(result.length, 2);
  assert.equal(result[1]._matchedManualId, 'a');
  assert.equal(result[0]._matchedManualId, 'b');
  const conflict = { importRanges: coverage(), decisions: { a: { kind: 'match', importedId: imports[0].id }, b: { kind: 'match', importedId: imports[0].id } } };
  const unresolved = reconcile_transactions(imports, manual, {}, conflict);
  assert.equal(unresolved.length, 4);
  assert.ok(unresolved.slice(2).every(r => r._reconciliation.status === 'ambiguous'));
  assert.equal(unresolved.filter(r => r._matchedManualId).length, 0);
});

test('stale or invalid explicit matches do not silently fall back to another bank booking', () => {
  const imports = csv_records([row(), row({ Name: 'Wrong sign', Betrag: '12.34' }), row({ Name: 'Wrong date', Datum: '10.09.2026' }),
    row({ Name: 'Wrong currency', Währung: 'USD' }), row({ Name: 'Wrong account', _account: 'Savings' })]);
  const manual = manualRow('m', { _account: 'Checking' });
  imports[0]._account = 'Checking';
  for (const importedId of [undefined, 'deleted-booking', ...imports.slice(1).map(r => r.id)]) {
    const result = reconcile_transactions(imports, [manual], {}, { importRanges: coverage('2026-09-01', '2026-09-30', 'Checking'), decisions: { m: { kind: 'match', importedId } } });
    assert.equal(result.length, 6);
    assert.equal(result.at(-1)._reconciliation.status, 'unassigned');
    assert.deepEqual(result.at(-1)._reconciliation.candidateIds, [imports[0].id]);
  }
});

test('conflicting explicit claims reserve the disputed bank booking for review', () => {
  const imports = csv_records([row()]);
  const manual = [manualRow('a'), manualRow('b'), manualRow('automatic')];
  const options = { importRanges: coverage(), decisions: {
    a: { kind: 'match', importedId: imports[0].id }, b: { kind: 'match', importedId: imports[0].id }
  } };
  const result = reconcile_transactions(imports, manual, {}, options);
  assert.equal(result.length, 4);
  assert.ok(result.slice(1).every(r => r._reconciliation.status === 'ambiguous'));
  assert.equal(result.filter(r => r._matchedManualId).length, 0);
});

test('accepted matches remain stable when a later import adds another amount candidate', () => {
  const original = csv_records([row()]);
  const manual = [manualRow('m')];
  const first = reconcile_transactions(original, manual);
  const options = { importRanges: coverage(), decisions: { m: { kind: 'match', importedId: first[0]._reconciliation.importedId } } };
  const later = csv_records([row({ Datum: '21.09.2026', Name: 'Another purchase' })]);
  for (const imports of [[...original, ...later], [...later, ...original]]) {
    const result = reconcile_transactions(imports, manual, {}, options);
    assert.equal(result.length, 2);
    assert.equal(result.filter(r => r._matchedManualId).length, 1);
    assert.equal(result.find(r => r._matchedManualId)._txId, original[0].id);
  }
});

test('an accepted legacy bank match survives a later CSV replacing its visible source', () => {
  const bank = row({ id: 'gc:1', source: 'gocardless' });
  const manual = manualRow('m', { Kategorie: 'Dining' });
  const first = reconcile_transactions([], [bank, manual]);
  const options = { decisions: { m: { kind: 'match', importedId: first[0]._reconciliation.importedId } } };
  const result = reconcile_transactions(csv_records([row()]), [bank, manual], {}, options);
  assert.equal(result.length, 1);
  assert.equal(result[0].source, 'csv');
  assert.equal(result[0]._matchedManualId, 'm');
  assert.equal(result[0]._matchedManualCategory, 'Dining');
  assert.deepEqual(result[0]._sources, ['csv', 'gocardless', 'manual']);
});

test('forecast assumptions do not claim real bank transactions or require reconciliation review', () => {
  const imports = csv_records([row()]);
  const manual = [manualRow('forecast', { reconciliationMode: 'forecast' }), manualRow('real')];
  const result = reconcile_transactions(imports, manual, {}, { importRanges: coverage() });
  assert.equal(result.length, 2);
  assert.equal(result[0]._matchedManualId, 'real');
  assert.equal(result[1]._reconciliation.status, 'forecast');
  assert.deepEqual(result[1]._reconciliation.candidateIds, []);
  assert.equal(reconciliation_summary(result).count, 0);
});

test('unresolved expense summary includes only the visible real cashflow rows and positive totals', () => {
  const manual = [manualRow('a', { Betrag: '-10' }), manualRow('b', { Betrag: '-20' }), manualRow('income', { Betrag: '50' }),
    manualRow('outside', { Datum: '01.10.2026' }), manualRow('cash', { Betrag: '-30' }), manualRow('excluded', { Betrag: '-40' })];
  const result = reconcile_transactions([], manual, {}, { importRanges: coverage(), decisions: { cash: { kind: 'cash' } } });
  result.find(r => r.id === 'b')._reconciliation.status = 'ambiguous';
  result.find(r => r.id === 'excluded')._cls = { excluded: true };
  const summary = reconciliation_summary(result);
  assert.equal(summary.count, 2);
  assert.equal(summary.cents, 3000);
  assert.deepEqual(summary.rows.map(r => r.id), ['a', 'b']);
  assert.equal(reconciliation_summary(result.filter(r => r.id === 'b')).cents, 2000);
});

test('CSV import ranges derive per-file per-account intervals and have repeatable IDs', () => {
  const imports = csv_records([row({ Datum: '03.09.2026', _account: 'Checking' }), row({ Datum: '10.09.2026', _account: 'Checking' }),
    row({ Datum: '20.09.2026', _account: 'Wallet' }), row({ Datum: '21.09.2026', _account: 'Wallet' })]);
  const ranges = csv_import_ranges(imports);
  assert.deepEqual(ranges.map(({ account, from, to }) => ({ account, from, to })), [
    { account: 'Checking', from: '2026-09-03', to: '2026-09-10' }, { account: 'Wallet', from: '2026-09-20', to: '2026-09-21' }
  ]);
  assert.deepEqual(csv_import_ranges(imports), ranges);
  assert.deepEqual(csv_import_ranges(imports, { from: '', to: '' }), ranges);
  const fallback = csv_import_ranges(csv_records([row({ Konto: 'DE123', Bank: 'Recipient bank' })]), { account: 'Source Checking' });
  assert.equal(fallback[0].account, 'Source Checking');
});

test('an explicit CSV range covers statement days without transactions, including an empty account file', () => {
  const records = csv_records([row({ _account: 'Checking' })]);
  const explicit = { from: '2026-09-01', to: '2026-09-30', account: 'Checking' };
  const [range] = csv_import_ranges(records, explicit);
  assert.equal(range.from, explicit.from);
  assert.equal(range.to, explicit.to);
  assert.deepEqual(csv_import_ranges([], explicit), [range]);
  assert.deepEqual(csv_import_ranges([]), []);
  assert.throws(() => csv_import_ranges([], { from: explicit.from, to: explicit.to }), /account/);
});

test('CSV import range validation rejects invalid dates, incomplete intervals, and excluded file rows', () => {
  const records = csv_records([row()]);
  for (const range of [{ from: '2026-09-01' }, { from: '', to: '2026-09-30' }, { from: '2026-09-30', to: '2026-09-01' },
    { from: '2026-02-29', to: '2026-09-30' }, { from: '2026-09-21', to: '2026-09-30' }, { from: '01.09.2026', to: '2026-09-30' }]) {
    assert.throws(() => csv_import_ranges(records, range));
  }
  for (const Datum of ['31.02.2026', '29.02.2026', '', 'not a date']) assert.throws(() => csv_import_ranges([{ Datum }]));
  assert.equal(csv_import_ranges([{ Datum: '29.02.2024' }])[0].from, '2024-02-29');
});

test('manual date-window preference defaults, persists, and remains bounded', () => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    assert.equal(get_manual_match_days(), 3);
    assert.equal(save_manual_match_days(0), 0);
    assert.equal(get_manual_match_days(), 0);
    assert.equal(save_manual_match_days(7), 7);
    assert.equal(get_manual_match_days(), 7);
    assert.equal(save_manual_match_days(40), 14);
    assert.equal(save_manual_match_days(-1), 0);
    values.set('manualMatchDays', 'invalid');
    assert.equal(get_manual_match_days(), 3);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('the import, daily logging, later import, and cash review journey counts each expense once', () => {
  const history = csv_records([row({ Datum: '05.09.2026', Betrag: '-20', Name: 'Groceries', _account: 'Checking' })]);
  const manual = [manualRow('lunch', { _account: 'Checking', Kategorie: 'Dining' }), manualRow('cash', { Datum: '21.09.2026', Betrag: '-10' })];
  const historyRanges = csv_import_ranges(history);
  const daily = reconcile_transactions(history, manual, {}, { importRanges: historyRanges });
  assert.deepEqual(daily.slice(1).map(r => r._reconciliation.status), ['pending', 'pending']);
  assert.equal(build_group_summary(daily).totalExpenses, 4234);
  const next = csv_records([row({ Datum: '22.09.2026', Name: 'Lunch merchant', _account: 'Checking' }),
    row({ Datum: '25.09.2026', Name: 'Another expense', Betrag: '-40', _account: 'Checking' })]);
  const store = new Map([...history, ...next].map(r => [r.id, r]));
  const options = { importRanges: [...historyRanges, ...csv_import_ranges(next, { from: '2026-09-06', to: '2026-09-25' })] };
  const imported = reconcile_transactions([...store.values()], manual, {}, options);
  assert.equal(imported.length, 4);
  assert.equal(imported.find(r => r._matchedManualId === 'lunch')._matchedManualCategory, 'Dining');
  assert.equal(build_group_summary(imported).totalExpenses, 8234);
  assert.equal(reconciliation_summary(imported).count, 1);
  assert.equal(reconciliation_summary(imported).cents, 1000);
  next.forEach(record => store.set(record.id, record));
  const reviewed = reconcile_transactions([...store.values()], manual, {}, { ...options, decisions: { cash: { kind: 'cash' } } });
  assert.equal(reviewed.length, 4);
  assert.equal(build_group_summary(reviewed).totalExpenses, 8234);
  assert.equal(reconciliation_summary(reviewed).count, 0);
});

test('source labels are distinct and translated for manual reconciliation states', () => {
  const statuses = ['pending', 'unassigned', 'ambiguous', 'cash', 'forecast'];
  const labelsByLanguage = {};
  for (const language of ['de', 'en']) {
    set_language(language);
    const labels = statuses.map(status => transaction_source_label({ source: 'manual', _reconciliation: { status } }));
    assert.equal(new Set(labels).size, statuses.length);
    assert.ok(labels.every(label => !label.startsWith('reconciliation.')));
    labelsByLanguage[language] = labels;
    assert.match(transaction_source_label({ _matchedManualId: 'm', _sources: ['csv', 'manual'] }), /^Import/);
  }
  assert.notDeepEqual(labelsByLanguage.de, labelsByLanguage.en);
  set_language('de');
});
