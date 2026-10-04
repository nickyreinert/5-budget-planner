// --- budgets.js ---
// Sub-budget caps: a user-chosen weekly € limit per category, shown as a
// progress row on the Week tab (see week.js#build_sub_budget_report). Only
// categories with a cap here appear there - this is what keeps that list
// curated instead of showing every category that ever occurred.

import { is_budget_category, is_spending_classification, split_category, join_category, UNCATEGORIZED } from './categories.js';

const STORAGE_KEY = 'subBudgetCaps';

// { [category]: weeklyCapCents }
export function get_sub_budgets() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch (e) {
    console.error('Failed to parse stored sub-budget caps', e);
    return {};
  }
}

export function save_sub_budgets(caps) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(caps));
}

// A spending category is "<budgetId>" or "<budgetId>.<sub>", exactly like
// Fix Expense categories are "<parent>.<sub>". The budget is derived from the
// name; a name whose parent is no budget (e.g. Unkategorisiert) is unassigned.
export function budget_category(settings, category, classification = null) {
  if (!is_budget_category(settings, category, classification)) return null;
  const { parent } = split_category(category);
  return (settings.mainCategories || []).some(m => m.id === parent) ? parent : null;
}

// Validate the complete budget payload before callers persist any of it.
// Older settings without budget fields remain importable.
export function validate_budget_settings(settings, { checkSuggestionCaps = true } = {}) {
  const fail = message => { throw new Error(message); };
  const unsafe = key => ['__proto__','constructor','prototype'].includes(key);
  const checkKeys = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { if (unsafe(key)) fail('Unsupported settings key: ' + key); checkKeys(child); }
  };
  checkKeys(settings);
  if (!settings || !Array.isArray(settings.rules)) fail('rules must be an array');
  if (!Array.isArray(settings.groups) || settings.groups.some(g => !g || typeof g.id !== 'string' || typeof g.label !== 'string')) fail('groups must contain id and label');
  if (settings.rules.some(r => !r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.category !== 'string')) fail('Each rule needs id and category');
  for (const r of settings.rules) for (const key of ['namePattern', 'verwendungPattern', 'kategoriePattern']) {
    if (r[key]) { if (typeof r[key] !== 'string') fail('Invalid pattern'); new RegExp(r[key], 'i'); }
  }
  const ruleIds = new Set();
  for (const r of settings.rules) {
    if (ruleIds.has(r.id)) fail('Rule IDs must be unique: ' + r.id);
    ruleIds.add(r.id);
    if (r.priority !== undefined && !Number.isFinite(r.priority)) fail('Invalid rule priority');
    if (r.incomeType !== undefined && !['salary', 'other'].includes(r.incomeType)) fail('Invalid incomeType');
    if (r.recurring !== undefined && (!r.recurring || ![1,3,6,12].includes(r.recurring.intervalMonths))) fail('recurring.intervalMonths must be 1, 3, 6 or 12');
    if (r.recurringOverrides !== undefined) {
      if (!r.recurringOverrides || typeof r.recurringOverrides !== 'object') fail('recurringOverrides must be an object');
      for (const months of Object.values(r.recurringOverrides)) if (![1,3,6,12].includes(months)) fail('recurringOverrides values must be 1, 3, 6 or 12');
    }
    if (r.matchers !== undefined) {
      if (!Array.isArray(r.matchers)) fail('matchers must be an array');
      for (const matcher of r.matchers) {
        if (!matcher || !['any', 'name', 'purpose', 'category', 'amount'].includes(matcher.field)) fail('Invalid matcher field');
        if (typeof matcher.exclude !== 'undefined' && typeof matcher.exclude !== 'boolean') fail('Invalid matcher exclusion');
        if (matcher.field === 'amount') {
          if (!['gt', 'lt', 'equals'].includes(matcher.operator) || (String(matcher.value ?? '').trim() && !Number.isFinite(Number(matcher.value)))) fail('Invalid amount matcher');
        } else {
          if (!['contains', 'regex', 'equals'].includes(matcher.operator) || typeof matcher.value !== 'string') fail('Invalid text matcher');
          if (matcher.operator === 'regex' && matcher.value.trim()) new RegExp(matcher.value, 'i');
        }
      }
    }
  }
  if (settings.budgetRecommendation !== undefined) {
    const recommendation = settings.budgetRecommendation;
    if (!recommendation || typeof recommendation !== 'object') fail('Invalid budgetRecommendation');
    for (const field of ['monthlyIncomeCents','monthlyFixedCents','weeklyLimitCents']) {
      if (!Number.isSafeInteger(recommendation[field]) || recommendation[field] < 0) fail('Budget recommendation needs non-negative integer cents');
    }
    const available = Math.max(0, Math.round((recommendation.monthlyIncomeCents - recommendation.monthlyFixedCents) * 12 / 52));
    if (recommendation.weeklyLimitCents > available) fail('Suggested weekly limit exceeds income minus recurring expenses');
    if (checkSuggestionCaps && Object.values(settings.subBudgetCaps || {}).reduce((sum,v) => sum + v, 0) > recommendation.weeklyLimitCents) fail('Suggested budget limits exceed the available weekly limit');
  }
  if (settings.mainCategories !== undefined && !Array.isArray(settings.mainCategories)) fail('mainCategories must be an array');
  const ids = new Set();
  for (const m of settings.mainCategories || []) {
    if (!m || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(m.id) || typeof m.label !== 'string' || !m.label.trim() || ids.has(m.id)) fail('Budget IDs must be unique; each budget needs a name');
    ids.add(m.id);
  }
  for (const field of ['subBudgetCaps']) {
    const map = settings[field];
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail(field + ' must be an object');
    for (const [key, value] of Object.entries(map)) {
      if (field === 'subBudgetCaps' && (!ids.has(key) || !Number.isSafeInteger(value) || value < 0)) fail('Weekly limits must be non-negative integer cents for an existing budget');
    }
  }
  return settings;
}

// Converts the legacy model (flat category names linked to budgets through
// categoryMappings / rule.budgetCategory / mainCategories[].entryCategory) into
// "<budgetId>.<sub>" category names, once. Returns { oldName: newName } for
// every renamed category so stored per-transaction assignments can follow.
function migrate_legacy_budget_links(settings) {
  const legacy = Object.hasOwn(settings, 'categoryMappings') || (settings.rules || []).some(r => 'budgetCategory' in r) || (settings.mainCategories || []).some(m => 'entryCategory' in m);
  const renames = {};
  if (!legacy) return renames;
  const ids = new Set((settings.mainCategories || []).map(m => m.id));
  const mappings = settings.categoryMappings || {};
  const entry = Object.fromEntries((settings.mainCategories || []).filter(m => m.entryCategory).map(m => [m.entryCategory, m.id]));
  const budget_for = category => {
    if (Object.hasOwn(mappings, category)) return ids.has(mappings[category]) ? mappings[category] : null;
    if (entry[category]) return entry[category];
    const rule = (settings.rules || []).find(r => r.category === category && r.budgetCategory && is_spending_classification({ group: r.group, excluded: r.excludeFromTotals }));
    return ids.has(rule?.budgetCategory) ? rule.budgetCategory : null;
  };
  const spending = settings.rules.filter(r => is_spending_classification({ group: r.group, excluded: r.excludeFromTotals }));
  const known = new Set(spending.map(r => r.category));
  // Categories that only existed as a mapping get an empty rule, like a Fix
  // Expense row that has not collected matchers yet; they stay selectable.
  for (const category of Object.keys(mappings)) {
    if (known.has(category) || category === UNCATEGORIZED || settings.rules.some(r => r.category === category)) continue;
    let id = 'category_' + category.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    while (settings.rules.some(r => r.id === id)) id += '_';
    settings.rules.push({ id, label: category, category, group: 'discretionary', matchers: [{ field: 'any', operator: 'contains', value: '', exclude: false }], priority: 0 });
    spending.push(settings.rules.at(-1));
  }
  const targets = {};
  for (const rule of spending) {
    const category = rule.category;
    if (category === UNCATEGORIZED) continue;
    targets[category] ??= budget_for(category);
  }
  for (const rule of spending) {
    const budget = targets[rule.category];
    if (!budget) continue;
    const next = join_category(budget, rule.category);
    renames[rule.category] = next;
    rule.category = next;
  }
  for (const rule of settings.rules) delete rule.budgetCategory;
  for (const main of settings.mainCategories || []) delete main.entryCategory;
  delete settings.categoryMappings;
  return renames;
}

// Normalizes settings in place. Renames made by the legacy migration are kept
// in `_categoryRenames` until the app has applied them to stored assignments.
export function ensure_budget_coverage(settings) {
  settings.mainCategories ||= [];
  const renames = migrate_legacy_budget_links(settings);
  if (Object.keys(renames).length) settings._categoryRenames = { ...settings._categoryRenames, ...renames };
  for (const rule of settings.rules || []) {
    if (!is_spending_classification({ group: rule.group, excluded: rule.excludeFromTotals })) delete rule.budgetCategory;
  }
  return settings;
}
