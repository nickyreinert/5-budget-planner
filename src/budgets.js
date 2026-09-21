// --- budgets.js ---
// Sub-budget caps: a user-chosen weekly € limit per category, shown as a
// progress row on the Week tab (see week.js#build_sub_budget_report). Only
// categories with a cap here appear there - this is what keeps that list
// curated instead of showing every category that ever occurred.

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

// Exact historical mappings take precedence over rule defaults. Empty means
// deliberately unassigned; unknown purchases must not be guessed into a budget.
export function budget_category(settings, category) {
  const mains = settings.mainCategories || [];
  if (Object.hasOwn(settings.categoryMappings || {}, category)) {
    const id = settings.categoryMappings[category];
    return mains.some(m => m.id === id) ? id : null;
  }
  const main = mains.find(m => (m.entryCategory || m.label) === category);
  if (main) return main.id;
  const rule = (settings.rules || []).find(r => (r.category || r.label) === category);
  return mains.some(m => m.id === rule?.budgetCategory) ? rule.budgetCategory : null;
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
    if (r.matchers !== undefined) {
      if (!Array.isArray(r.matchers) || !r.matchers.length) fail('matchers must be a non-empty array');
      for (const matcher of r.matchers) {
        if (!matcher || !['any', 'name', 'purpose', 'category', 'amount'].includes(matcher.field)) fail('Invalid matcher field');
        if (typeof matcher.exclude !== 'undefined' && typeof matcher.exclude !== 'boolean') fail('Invalid matcher exclusion');
        if (matcher.field === 'amount') {
          if (!['gt', 'lt'].includes(matcher.operator) || !Number.isFinite(Number(matcher.value))) fail('Invalid amount matcher');
        } else {
          if (!['contains', 'regex'].includes(matcher.operator) || typeof matcher.value !== 'string' || !matcher.value.trim()) fail('Invalid text matcher');
          if (matcher.operator === 'regex') new RegExp(matcher.value, 'i');
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
    if (m.entryCategory !== undefined && (typeof m.entryCategory !== 'string' || !m.entryCategory.trim())) fail('Invalid entryCategory');
    ids.add(m.id);
  }
  for (const field of ['categoryMappings', 'subBudgetCaps']) {
    const map = settings[field];
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) fail(field + ' must be an object');
    for (const [key, value] of Object.entries(map)) {
      if (field === 'categoryMappings' && (typeof value !== 'string' || (value && !ids.has(value)))) fail('Unknown budget in categoryMappings: ' + key);
      if (field === 'subBudgetCaps' && (!ids.has(key) || !Number.isSafeInteger(value) || value < 0)) fail('Weekly limits must be non-negative integer cents for an existing budget');
    }
  }
  for (const r of settings.rules) {
    if (settings.mainCategories && r.budgetCategory && !ids.has(r.budgetCategory) && r.budgetCategory !== 'sonstiges') fail('Unknown rule budget: ' + r.budgetCategory);
  }
  return settings;
}

// Keep unknown categories explicit and available for assignment. Empty mappings
// feed the visible "Nicht zugeordnet" budget bucket; they are never guessed.
export function ensure_budget_coverage(settings, rows = []) {
  settings.mainCategories ||= [];
  settings.categoryMappings ||= {};
  const variableRules = (settings.rules || []).filter(r => !['fixed', 'income', 'internal_transfer'].includes(r.group) && !r.excludeFromTotals);
  const categories = new Set([...variableRules.map(r => r.category),
    ...rows.filter(r => r.betrag_cents < 0 && !r._cls?.excluded && r._cls?.group !== 'fixed').map(r => r._cls?.category || 'Unkategorisiert'), 'Unkategorisiert']);
  for (const category of categories) {
    if (!budget_category(settings, category) && !Object.hasOwn(settings.categoryMappings, category)) settings.categoryMappings[category] = '';
  }
  settings.categoryMappings.Unkategorisiert = '';
  return settings;
}
