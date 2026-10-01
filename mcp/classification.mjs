import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classify } from '../src/rules.js';
import { validate_budget_settings } from '../src/budgets.js';
import { enrich_row, tx_id } from '../src/data.js';
import { category_catalog, UNCATEGORIZED, ADDITIONAL_INCOME } from '../src/categories.js';

const proposalName = '5ive_mcp_settings_proposal.json';
const assignmentsName = '5ive_mcp_assignments.json';

export async function load_exports(settingsPath, dataPath) {
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  validate_budget_settings(settings, { checkSuggestionCaps: false });
  if (!Array.isArray(data.importedEntries) || !Array.isArray(data.manualEntries) || !data.overrides || typeof data.overrides !== 'object') {
    throw new Error('Invalid data export: expected importedEntries, manualEntries and overrides');
  }
  return { settings, data };
}

export function classified_rows(settings, data) {
  return [...data.importedEntries, ...data.manualEntries].map(record => {
    const row = enrich_row({ ...record, _txId: record._txId || record.id, _ignoreCsvCategories: true });
    const id = tx_id(row);
    const manualCategory = data.overrides[id] || data.overrides[record.legacyId];
    const classification = classify(row, settings);
    return {
      id, date: row.Datum, name: row.Name, purpose: row.Verwendungszweck,
      amountCents: row.betrag_cents, account: row._account || '',
      category: manualCategory || classification.category,
      source: manualCategory ? 'manual' : classification.source
    };
  });
}

export function categories(settings, data) {
  const rows = classified_rows(settings, data);
  return category_catalog(settings).map(category => ({
    category,
    budget: (settings.mainCategories || []).find(main => main.id === settings.categoryMappings?.[category])?.label || null,
    examples: rows.filter(row => row.category === category).slice(0, 5).map(({ name, purpose, amountCents }) => ({ name, purpose, amountCents }))
  }));
}

export function transactions(settings, data, { category, search, offset = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('offset must be >= 0; limit must be 1..100');
  const rows = classified_rows(settings, data).filter(row =>
    (!category || row.category === category) &&
    (!search || `${row.name} ${row.purpose}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  );
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

export function propose_rule(settings, data, { category, field, text, exact = false }) {
  if (!category_catalog(settings).includes(category)) throw new Error('Choose an existing category');
  if (!['name', 'purpose'].includes(field) || typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('Provide a name or purpose and nonempty text (max 200 chars)');
  const template = settings.rules.find(rule => (rule.category || rule.label) === category);
  if (!template && !Object.hasOwn(settings.categoryMappings || {}, category)) throw new Error('Category has no mapping or rule');
  const escaped = text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = {
    id: `mcp_${randomUUID()}`, label: category, category,
    group: template?.group || 'discretionary',
    priority: Math.max(0, ...settings.rules.map(item => item.priority || 0)) + 1,
    ...(field === 'name' ? { namePattern: exact ? `^${escaped}$` : escaped } : { verwendungPattern: exact ? `^${escaped}$` : escaped })
  };
  if (template?.budgetCategory) rule.budgetCategory = template.budgetCategory;
  if (template?.incomeType) rule.incomeType = template.incomeType;
  const before = classified_rows(settings, data);
  const candidate = { ...settings, rules: [...settings.rules, rule] };
  validate_budget_settings(candidate, { checkSuggestionCaps: false });
  const after = classified_rows(candidate, data);
  const affected = after.filter((row, index) => row.category !== before[index].category);
  if (!affected.length) throw new Error('This rule does not change any imported transaction');
  const previousById = new Map(before.map(row => [row.id, row]));
  const conflicts = affected.filter(row => ![UNCATEGORIZED, ADDITIONAL_INCOME].includes(previousById.get(row.id)?.category));
  if (conflicts.length) throw new Error(`Rule would reclassify ${conflicts.length} already categorized transactions; use narrower text or per-transaction assignments`);
  return { candidate, rule, affected: affected.map(({ id, name, amountCents }) => ({ id, name, amountCents })) };
}

export function propose_assignments(settings, data, pairs) {
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 100) throw new Error('Provide 1..100 assignments');
  const rows = classified_rows(settings, data);
  const byId = new Map(rows.map(row => [row.id, row]));
  const allowed = new Set(category_catalog(settings));
  const overrides = {};
  for (const { id, category } of pairs) {
    if (!byId.has(id)) throw new Error(`Unknown transaction ID: ${id}`);
    if (!allowed.has(category)) throw new Error(`Unknown category: ${category}`);
    if (byId.get(id).source === 'manual' && byId.get(id).category !== category) throw new Error(`Transaction already has a manual classification: ${id}`);
    overrides[id] = category;
  }
  return { overrides };
}

export async function write_proposal(directory, name, payload) {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
  return path;
}

export { proposalName, assignmentsName };