import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classify, classify_all, apply_manual_overrides } from '../src/rules.js';
import { validate_budget_settings, budget_category, ensure_budget_coverage } from '../src/budgets.js';
import { tx_id, apply_amount_overrides, apply_note_overrides, apply_date_overrides, apply_ignored_transactions } from '../src/data.js';
import { category_catalog, UNCATEGORIZED, ADDITIONAL_INCOME } from '../src/categories.js';
import { reconcile_transactions } from '../src/transactions.js';
import { plan_category_maintenance, category_maintenance_revision, category_role } from '../src/category_maintenance.js';

const proposalName = '5ive_mcp_settings_proposal.json';
const assignmentsName = '5ive_mcp_assignments.json';
const categoryMaintenanceName = '5ive_mcp_category_maintenance.json';

export async function load_exports(settingsPath, dataPath) {
  return validate_exports(JSON.parse(await readFile(settingsPath, 'utf8')), JSON.parse(await readFile(dataPath, 'utf8')));
}

export function validate_exports(settings, data) {
  validate_budget_settings(settings, { checkSuggestionCaps: false });
  ensure_budget_coverage(settings);
  if (!Array.isArray(data.importedEntries) || !Array.isArray(data.manualEntries) || !data.overrides || typeof data.overrides !== 'object') {
    throw new Error('Invalid data export: expected importedEntries, manualEntries and overrides');
  }
  return { settings, data };
}

function prepared_rows(data) {
  const rows = reconcile_transactions(data.importedEntries, data.manualEntries, data.amountOverrides || {}, {
    maxDays: data.manualMatchDays ?? 3,
    dateOverrides: data.dateOverrides || {},
    importRanges: data.importRanges || [],
    decisions: data.reconciliationDecisions || {}
  });
  rows.forEach(row => { row._ignoreCsvCategories = row.source === 'csv'; });
  apply_amount_overrides(rows, data.amountOverrides || {});
  apply_note_overrides(rows, data.noteOverrides || {});
  apply_date_overrides(rows, data.dateOverrides || {});
  apply_ignored_transactions(rows, data.ignoredTransactions || {});
  return rows;
}

export function classified_rows(settings, data) {
  const rows = prepared_rows(data);
  classify_all(rows, settings);
  apply_manual_overrides(rows, data.overrides, settings);
  return rows.map(row => ({
    id: tx_id(row), date: `${String(row.date.getDate()).padStart(2, '0')}.${String(row.date.getMonth() + 1).padStart(2, '0')}.${row.date.getFullYear()}`, name: row.Name, purpose: row.Verwendungszweck,
    amountCents: row.betrag_cents, account: row._account || '', currency: row.Währung || 'EUR',
    category: row._cls.category, group: row._cls.group, source: row._cls.source, ignored: !!row._ignored,
    transactionSource: row.source, reconciliation: row._reconciliation || null
  }));
}

export function categories(settings, data) {
  const rows = classified_rows(settings, data);
  return category_catalog(settings).map(category => ({
    category,
    role: (() => { try { return category_role(settings, category); } catch { return 'multiple'; } })(),
    budget: (settings.mainCategories || []).find(main => main.id === budget_category(settings, category))?.label || null,
    examples: rows.filter(row => row.category === category).slice(0, 5).map(({ name, purpose, amountCents }) => ({ name, purpose, amountCents }))
  }));
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export function transactions(settings, data, { category, search, from, to, offset = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('offset must be >= 0; limit must be 1..100');
  if ([from, to].some(date => date !== undefined && !isoDate.test(date))) throw new Error('from and to must be YYYY-MM-DD');
  const rows = classified_rows(settings, data).filter(row =>
    (!from || row.date.split('.').reverse().join('-') >= from) &&
    (!to || row.date.split('.').reverse().join('-') <= to) &&
    (!category || row.category === category) &&
    (!search || `${row.name} ${row.purpose}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  );
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

export function propose_rule(settings, data, { category, field, text, exact = false }) {
  if (!category_catalog(settings).includes(category)) throw new Error('Choose an existing category');
  if ([UNCATEGORIZED, ADDITIONAL_INCOME].includes(category)) throw new Error('Choose a specific existing expense category');
  if (!['name', 'purpose'].includes(field) || typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('Provide a name or purpose and nonempty text (max 200 chars)');
  const template = settings.rules.find(rule => (rule.category || rule.label) === category);
  if (template && ['fixed', 'income', 'internal_transfer'].includes(template.group)) throw new Error('Recurring, income and transfer rules require manual review in the app');
  const escaped = text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = {
    id: `mcp_${randomUUID()}`, label: category, category,
    group: template?.group || 'discretionary',
    priority: Math.max(0, ...settings.rules.map(item => item.priority || 0)) + 1,
    ...(field === 'name' ? { namePattern: exact ? `^${escaped}$` : escaped } : { verwendungPattern: exact ? `^${escaped}$` : escaped })
  };
  if (template?.incomeType) rule.incomeType = template.incomeType;
  const before = classified_rows(settings, data);
  const candidate = { ...settings, rules: [...settings.rules, rule] };
  validate_budget_settings(candidate, { checkSuggestionCaps: false });
  const after = classified_rows(candidate, data);
  const matched = prepared_rows(data).filter(row => classify(row, candidate).ruleId === rule.id);
  if (matched.some(row => row.betrag_cents >= 0)) {
    throw new Error('Rule would classify income or refunds as expenses; use narrower text');
  }
  const previousById = new Map(before.map(row => [row.id, row]));
  if (matched.some(row => previousById.get(tx_id(row))?.source !== 'none')) {
    throw new Error('Rule would match already classified transactions; use narrower text or per-transaction assignments');
  }
  const affected = after.filter((row, index) => row.category !== before[index].category);
  if (!affected.length) throw new Error('This rule does not change any imported transaction');
  const beforeById = new Map(before.map(row => [row.id, row]));
  const conflicts = affected.filter(row => ![UNCATEGORIZED, ADDITIONAL_INCOME].includes(beforeById.get(row.id)?.category));
  if (conflicts.length) throw new Error(`Rule would reclassify ${conflicts.length} already categorized transactions; use narrower text or per-transaction assignments`);
  return { candidate, rule, affected: affected.map(({ id, name, amountCents }) => ({ id, name, amountCents })) };
}

export function propose_rules(settings, data, requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 50) throw new Error('Provide 1..50 rules');
  let candidate = settings;
  const proposals = [];
  for (const request of requests) {
    const result = propose_rule(candidate, data, request);
    candidate = result.candidate;
    proposals.push({ rule: result.rule, affected: result.affected });
  }
  return { candidate, proposals };
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

export function propose_category_maintenance(settings, data, operations) {
  const rows = prepared_rows(data);
  classify_all(rows, settings); apply_manual_overrides(rows, data.overrides, settings);
  const plan = plan_category_maintenance(settings, rows, data.overrides || {}, operations);
  return { kind: 'category-maintenance', version: 1, operations,
    revision: category_maintenance_revision(settings, rows, data.overrides || {}),
    preview: plan.changes.map(change => ({ ...change, count: change.affectedIds.length })) };
}

export { proposalName, assignmentsName, categoryMaintenanceName };
