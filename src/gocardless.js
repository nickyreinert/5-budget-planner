// --- gocardless.js ---
// Pure helpers for turning one GoCardless (Bank Account Data API)
// transaction into a row this app already knows how to handle - the same
// canonical {Datum, Name, Verwendungszweck, Kategorie, Betrag} shape
// data.js#enrich_row() expects for a CSV row or a manual quick-entry. No
// network calls here - those go through gocardless-proxy/ (see its
// README); this module only shapes data already fetched from it.

// "2026-09-15" -> "15.09.2026" - the fixed storage format parse_date()/
// tx_id() expect, same convention index.html#datum_string() uses for
// manual entries.
function reformat_date(isoDate) {
  const [y, m, d] = (isoDate || '').split('-');
  if (!y || !m || !d) return isoDate || '';
  return `${d}.${m}.${y}`;
}

// GoCardless amounts are already plain decimal-point strings (e.g.
// "-12.34"), which parseFloat() (used by enrich_row()) reads natively -
// unlike a CSV import there's no decimal-separator normalization to do.
export function transaction_to_row(tx) {
  const amountStr = (tx.transactionAmount && tx.transactionAmount.amount) || '0';
  const amount = parseFloat(amountStr);
  // ISO 20022 convention: an outgoing payment's counterparty is the
  // creditor (who received it), an incoming one's is the debtor (who sent
  // it). Fall back to whichever field is present if only one is.
  const name = amount < 0
    ? (tx.creditorName || tx.debtorName || 'Unbekannt')
    : (tx.debtorName || tx.creditorName || 'Unbekannt');
  const verwendungszweck = tx.remittanceInformationUnstructured
    || (Array.isArray(tx.remittanceInformationUnstructuredArray) ? tx.remittanceInformationUnstructuredArray.join(' ') : '')
    || '';
  return {
    Datum: reformat_date(tx.bookingDate || tx.valueDate),
    Name: name,
    Verwendungszweck: verwendungszweck,
    Kategorie: '',
    Betrag: amountStr
  };
}

// A deterministic id for this transaction, used as the IndexedDB key (see
// db.js#add_manual_entry) so re-syncing an overlapping date range
// overwrites the same record instead of creating a duplicate. Prefers
// GoCardless's own transaction id (present for most banks); falls back to
// a composite of the fields that make a transaction unique when a bank
// doesn't provide one.
export function transaction_key(tx, accountId) {
  const stableId = tx.transactionId || tx.internalTransactionId;
  if (stableId) return `gc_${accountId}_${stableId}`;
  const amount = (tx.transactionAmount && tx.transactionAmount.amount) || '0';
  const name = tx.creditorName || tx.debtorName || '';
  const date = tx.bookingDate || tx.valueDate || '';
  return `gc_${accountId}_${date}_${amount}_${name}`;
}
