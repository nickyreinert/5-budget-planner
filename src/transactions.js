import { enrich_row, tx_id, apply_amount_overrides } from './data.js';

// Occurrence numbers preserve two genuinely identical bookings in a file,
// while overlapping exports upsert the same occurrences again.
export function csv_records(rows) {
  const counts = new Map(), legacyCounts = new Map();
  return rows.map(row => {
    const legacyKey = tx_id(row);
    const legacyOccurrence = (legacyCounts.get(legacyKey) || 0) + 1;
    legacyCounts.set(legacyKey, legacyOccurrence);
    const account = row._account || row.Kontoname || row.Account || '';
    const key = account ? [legacyKey, account].join('|') : legacyKey;
    const occurrence = (counts.get(key) || 0) + 1;
    counts.set(key, occurrence);
    return { Datum: row.Datum, Name: row.Name, Verwendungszweck: row.Verwendungszweck,
      Kategorie: row.Kategorie, Betrag: row.Betrag, _account: account, Konto: row.Konto || '', Bank: row.Bank || '', Währung: row.Währung || 'EUR', source: 'csv',
      legacyId: `csv:${JSON.stringify([legacyKey, legacyOccurrence])}`,
      id: `csv:${JSON.stringify([key, occurrence])}` };
  });
}

// Match separate sources one-to-one, never collapse same-source bookings by
// amount alone. Raw records remain intact so matching is repeatable on reload.
export function reconcile_transactions(imported, manual, amounts = {}) {
  const rows = imported.map(rec => enrich_row({ ...rec, _txId: rec.id, source: rec.source || 'csv' }));
  const matchKey = r => `${r.date.getFullYear()}-${r.date.getMonth()}-${r.date.getDate()}|${r.betrag_cents}`;
  function bucketsFor(list) {
    const buckets = new Map();
    list.forEach(row => {
      const key = matchKey(row);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });
    return buckets;
  }
  const candidates = manual.map(rec => enrich_row({ ...rec, source: rec.source || 'manual',
    _manualId: rec.id, _txId: rec._txId }));
  apply_amount_overrides(candidates, amounts);
  // Older bank syncs live in the manual store but are an imported source.
  const csvBuckets = bucketsFor(rows);
  for (const row of candidates.filter(r => r.source === 'gocardless')) {
    const candidatesForBank = csvBuckets.get(matchKey(row)) || [];
    const sourceIsPayPal = /paypal/i.test(row._account || '');
    const index = candidatesForBank.findIndex(candidate => /paypal/i.test(candidate._account || '') === sourceIsPayPal);
    const match = index >= 0 ? candidatesForBank.splice(index, 1)[0] : null;
    if (match) { match._sources = [match.source, row.source]; match._matchedBankTxId = tx_id(row); }
    else rows.push(row);
  }
  const manualMatchRows = [...rows].sort((a,b) => Number(/paypal/i.test(a.name) && !/paypal/i.test(a._account || '')) - Number(/paypal/i.test(b.name) && !/paypal/i.test(b._account || '')));
  const buckets = bucketsFor(manualMatchRows);
  for (const row of candidates.filter(r => r.source !== 'gocardless')) {
    const match = buckets.get(matchKey(row))?.shift();
    if (match) {
      match._matchedManualTxId = tx_id(row);
      match._matchedManualId = row.id;
      match._matchedManualCategory = row.Kategorie || null;
      match._sources = [...(match._sources || [match.source]), row.source];
    } else rows.push(row);
  }
  return rows;
}

export function transaction_source_label(row) {
  if (row._matchedManualId) return 'Import · manuell abgeglichen';
  if (row._sources?.length > 1) return 'CSV · Bank abgeglichen';
  return row.source === 'manual' ? 'Manuell' : row.source === 'gocardless' ? 'Bankimport' : 'CSV-Import';
}
