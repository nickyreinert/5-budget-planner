import { category_catalog, is_spending_classification, join_category, UNCATEGORIZED, ADDITIONAL_INCOME } from './categories.js';
import { ensure_budget_coverage, validate_budget_settings } from './budgets.js';
import { tx_id } from './data.js';

const protectedCategories = new Set([UNCATEGORIZED, ADDITIONAL_INCOME]);
const categoryName = name => {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('Invalid category name');
  return name;
};
export function category_role(settings, category) {
  if (category === ADDITIONAL_INCOME) return 'income:other';
  const roles = new Set((settings.rules || []).filter(rule => (rule.category || rule.label) === category).map(rule =>
    is_spending_classification({ group: rule.group, excluded: rule.excludeFromTotals }) ? 'spending'
      : rule.group === 'income' ? `income:${rule.incomeType || 'salary'}` : rule.excludeFromTotals ? 'transfer' : rule.group));
  if (roles.size > 1) throw new Error('Category has multiple roles; separate its recurring and spending names first: ' + category);
  return [...roles][0] || 'spending';
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).filter(key => !key.startsWith('_')).sort().map(key => [key, canonical(value[key])]));
}

// An import must refer to the same settings and bookings that the AI reviewed.
export function category_maintenance_revision(settings, rows, overrides) {
  const normalized = ensure_budget_coverage(structuredClone(settings));
  const bookings = rows.map(row => [tx_id(row), row.Name || row.name || '', row.Verwendungszweck || row.verwendungszweck || '', row.betrag_cents, +row.date, !!row._ignored])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([canonical(normalized), bookings, canonical(overrides)]);
}

export function plan_category_maintenance(settings, rows, overrides, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 50) throw new Error('Provide 1..50 category operations');
  const candidate = structuredClone(settings);
  const nextOverrides = { ...overrides };
  const currentCategory = new Map(rows.map(row => [tx_id(row), row._cls?.category || UNCATEGORIZED]));
  const byId = new Map(rows.map(row => [tx_id(row), row]));
  const redirects = {};
  const changes = [];
  for (const operation of operations) {
    if (!operation || !['create', 'rename', 'merge', 'delete', 'move'].includes(operation.action)) throw new Error('Unknown category operation');
    const { action } = operation;
    const names = category_catalog(candidate);
    const source = action === 'move' ? null : categoryName(operation.category);
    const target = operation.target === undefined ? null : categoryName(operation.target);
    if (action === 'rename' && (candidate.mainCategories || []).some(main => main.id === source)) throw new Error('A budget\'s general category cannot be renamed; rename the budget label instead');
    if (source && protectedCategories.has(source)) throw new Error('The fallback and other-income categories cannot be removed or renamed');
    if (action === 'create') {
      if (names.includes(source)) throw new Error('Category already exists: ' + source);
      if (operation.budgetId && !(candidate.mainCategories || []).some(main => main.id === operation.budgetId)) throw new Error('Unknown budget');
      // A new category is an empty rule, like a Fix Expense row without matchers yet.
      const created = operation.budgetId ? join_category(operation.budgetId, source) : source;
      if (names.includes(created)) throw new Error('Category already exists: ' + created);
      let id = 'category_' + Date.now(), n = 0;
      while (candidate.rules.some(rule => rule.id === id)) id = `category_${Date.now()}_${++n}`;
      candidate.rules.push({ id, label: created, category: created, group: 'discretionary', matchers: [{ field: 'any', operator: 'contains', value: '', exclude: false }], priority: 0 });
      changes.push({ action, category: created, target: null, affectedIds: [] });
      continue;
    }
    if (action !== 'move' && !names.includes(source)) throw new Error('Unknown category: ' + source);
    if (action === 'rename' && (!target || names.includes(target))) throw new Error('Rename needs a new name; use merge for an existing category');
    if (['merge', 'move'].includes(action) && (!target || !names.includes(target))) throw new Error('Choose an existing target category');
    if (target && protectedCategories.has(target)) throw new Error('Choose a specific target category');
    if (target === source) throw new Error('Source and target categories must differ');
    let ids;
    if (action === 'move') {
      if (!Array.isArray(operation.ids) || !operation.ids.length || operation.ids.length > 1000 || new Set(operation.ids).size !== operation.ids.length) throw new Error('Provide 1..1000 unique transaction IDs');
      ids = operation.ids;
      for (const id of ids) {
        if (!byId.has(id)) throw new Error('Unknown transaction ID: ' + id);
        if (category_role(candidate, currentCategory.get(id)) !== category_role(candidate, target)) throw new Error('Recurring and spending transactions must keep separate category roles');
      }
    } else {
      ids = [...currentCategory].filter(([, category]) => category === source).map(([id]) => id);
      if (target && action !== 'rename' && category_role(candidate, source) !== category_role(candidate, target)) throw new Error('Cannot merge recurring, income, transfer and spending categories together');
      if (action === 'delete' && (target || ids.length || Object.values(nextOverrides).includes(source))) throw new Error('Only unused categories can be deleted; merge a used category first');
      if (action === 'delete' && (candidate.mainCategories || []).some(main => main.id === source)) throw new Error('A budget\'s general category cannot be deleted');
    }
    for (const id of ids) { nextOverrides[id] = target; currentCategory.set(id, target); }
    if (action !== 'move') {
      category_role(candidate, source);
      for (const [id, category] of Object.entries(nextOverrides)) if (category === source) nextOverrides[id] = target;
      candidate.rules = candidate.rules.filter(rule => action !== 'delete' || (rule.category || rule.label) !== source);
      for (const rule of candidate.rules) {
        if ((rule.category || rule.label) !== source) continue;
        rule.category = target;
        if (rule.label === source) rule.label = target;
      }
      redirects[source] = target;
    }
    changes.push({ action, category: source, target, affectedIds: [...ids] });
  }
  ensure_budget_coverage(candidate);
  validate_budget_settings(candidate, { checkSuggestionCaps: false });
  return { settings: candidate, overrides: nextOverrides, changes, redirects };
}
