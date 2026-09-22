// --- csv_config.js ---
// Configurable CSV import: delimiter, line break, encoding and column
// mapping (by header name or numeric index), so exports from banks other
// than DKB can be loaded without touching the code.

const STORAGE_KEY = 'csvImportConfig';

export function default_csv_config() {
  return {
    delimiter: ';',
    lineBreak: 'auto', // 'auto' | '\n' | '\r\n'
    encoding: 'utf-8', // passed to FileReader.readAsText / TextDecoder
    decimalSeparator: ',',
    hasHeader: true,
    ignoreCategories: true,
    accountName: '',
    columns: {
      date: 'Datum',
      name: 'Name',
      verwendungszweck: 'Verwendungszweck',
      betrag: 'Betrag',
      kategorie: 'Kategorie',
      account: 'Kontoname'
    }
  };
}

export function get_csv_config() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return default_csv_config();
  try {
    const parsed = JSON.parse(stored);
    // shallow-merge onto defaults so newly added fields always have a value
    const def = default_csv_config();
    return { ...def, ...parsed, columns: { ...def.columns, ...(parsed.columns || {}) } };
  } catch (e) {
    console.error('Failed to parse stored CSV import config', e);
    return default_csv_config();
  }
}

export function save_csv_config(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// Splits raw CSV text into an array of row-arrays (cells), honoring the
// configured delimiter and line break. Strips a UTF-8 BOM if present so
// the first header cell doesn't get a stray "\uFEFF" prefix.
export function split_csv(csvText, config) {
  let text = csvText;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const lineBreak = config.lineBreak === 'auto'
    ? (text.includes('\r\n') ? '\r\n' : '\n')
    : config.lineBreak;

  const delimiter = config.delimiter || ';';
  return text.split(lineBreak)
    .filter(l => l.trim() !== '')
    .map(line => line.replace(/\r$/, '').split(delimiter));
}

// Resolves a column spec (header name string, or numeric index as string/number)
// to a 0-based cell index, given the header row (or null if there is none).
export function resolve_column_index(spec, headerRow) {
  if (spec === null || spec === undefined || spec === '') return -1;
  if (headerRow) {
    const byName = headerRow.indexOf(String(spec));
    if (byName !== -1) return byName;
  }
  const asIndex = Number(spec);
  return Number.isInteger(asIndex) && asIndex >= 0 ? asIndex : -1;
}

// Parses raw CSV text into an array of plain row objects keyed by our
// internal field names (Datum/Name/Verwendungszweck/Betrag/Kategorie),
// applying the configurable delimiter/header/column-mapping/decimal
// separator. Rows also keep every original header-named cell for anything
// downstream that reads other bank-specific columns.
export function parse_csv_rows(csvText, config) {
  const rows = split_csv(csvText, config);
  if (rows.length === 0) return [];

  const headerRow = config.hasHeader ? rows[0] : null;
  const dataRows = config.hasHeader ? rows.slice(1) : rows;

  const idx = {
    date: resolve_column_index(config.columns.date, headerRow),
    name: resolve_column_index(config.columns.name, headerRow),
    verwendungszweck: resolve_column_index(config.columns.verwendungszweck, headerRow),
    betrag: resolve_column_index(config.columns.betrag, headerRow),
    kategorie: resolve_column_index(config.columns.kategorie, headerRow),
    account: resolve_column_index(config.columns.account || 'Kontoname', headerRow)
  };

  const decimalSeparator = config.decimalSeparator || ',';

  return dataRows.map(cells => {
    const obj = {};
    if (headerRow) {
      headerRow.forEach((h, i) => { obj[h] = cells[i]; });
    }
    obj._account = (idx.account >= 0 ? cells[idx.account] : '') || obj.Kontoname || obj.Account || obj['Eigenes Konto'] || config.accountName || '';
    obj.Datum = idx.date >= 0 ? cells[idx.date] : '';
    obj.Name = idx.name >= 0 ? cells[idx.name] : '';
    obj.Verwendungszweck = idx.verwendungszweck >= 0 ? cells[idx.verwendungszweck] : '';
    obj.Kategorie = idx.kategorie >= 0 ? cells[idx.kategorie] : '';
    let betragRaw = idx.betrag >= 0 ? (cells[idx.betrag] || '0') : '0';
    // normalize to a JS-parseable "1234.56": strip the thousands separator
    // (whichever char isn't the configured decimal separator), then turn
    // the decimal separator into a plain dot.
    const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
    betragRaw = betragRaw.split(thousandsSeparator).join('');
    if (decimalSeparator !== '.') {
      betragRaw = betragRaw.split(decimalSeparator).join('.');
    }
    obj.Betrag = betragRaw;
    return obj;
  });
}
