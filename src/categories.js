// The explicit fallback is always available, even before settings are imported.
export const UNCATEGORIZED = 'Unkategorisiert';
export const ADDITIONAL_INCOME = 'Zusätzliche Einnahmen';
// The classification group defines the category's role. Recurring contracts,
// income and transfers never belong to spending budgets, regardless of name.
export function is_spending_classification(classification = {}) {
  return !classification?.excluded && !['fixed', 'income', 'internal_transfer'].includes(classification?.group);
}

export function is_budget_category(settings, category, classification = null) {
  if (!category || category === ADDITIONAL_INCOME || (classification && !is_spending_classification(classification))) return false;
  const rules = (settings.rules || []).filter(rule => (rule.category || rule.label) === category);
  return !rules.length || rules.some(rule => is_spending_classification({ group: rule.group, excluded: rule.excludeFromTotals }));
}

export function category_catalog(settings, expenseOnly = false) {
  const rules = settings.rules || [];
  // A budget id on its own is the budget's general category (no subcategory).
  const names = [UNCATEGORIZED, ...(!expenseOnly ? [ADDITIONAL_INCOME] : []), ...rules.map(r => r.category || r.label),
    ...(settings.mainCategories || []).map(m => m.id)];
  return [...new Set(names.filter(Boolean))].filter(c => !expenseOnly || is_budget_category(settings, c));
}

export function sort_categories(categories, favorites = []) {
  const favs = new Set(favorites);
  return [...categories].sort((a, b) => Number(b === UNCATEGORIZED) - Number(a === UNCATEGORIZED) || Number(favs.has(b)) - Number(favs.has(a)) || a.localeCompare(b, 'de'));
}

// Fixed-cost rules define the reusable categories offered when a transaction
// is turned into a recurring contract. General spending categories deliberately
// do not appear in that picker.
export function fixed_expense_categories(settings, favorites = []) {
  const categories = (settings.rules || [])
    .filter(rule => rule.group === 'fixed')
    .map(rule => rule.category || rule.label)
    .filter(Boolean);
  return sort_categories([...new Set(categories)], favorites);
}

export function transaction_category_options(settings, group, favorites = []) {
  if (group === 'fixed') return sort_categories([UNCATEGORIZED, ...fixed_expense_categories(settings)], favorites);
  if (group === 'income' || group === 'internal_transfer') {
    const categories = (settings.rules || []).filter(rule => rule.group === group).map(rule => rule.category || rule.label).filter(Boolean);
    return sort_categories([...new Set([UNCATEGORIZED, ...(group === 'income' ? [ADDITIONAL_INCOME] : []), ...categories])], favorites);
  }
  return sort_categories(category_catalog(settings, true), favorites);
}

// Fix Expense/Income category strings support one optional subcategory
// level via dot notation ("Versicherungen.HDI Lebensversicherung") - kept
// as a single string (not a nested object) so every existing category
// picker/search input keeps working unchanged, dot and all. `sub` is null
// when the category has no dot (the common, non-split case).
export function split_category(category) {
  const value = String(category || '');
  const dotIndex = value.indexOf('.');
  if (dotIndex === -1) return { parent: value, sub: null };
  return { parent: value.slice(0, dotIndex), sub: value.slice(dotIndex + 1) };
}

export function join_category(parent, sub) {
  return sub ? `${parent}.${sub}` : parent;
}
