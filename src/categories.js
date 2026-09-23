// The explicit fallback is always available, even before settings are imported.
export const UNCATEGORIZED = 'Unkategorisiert';
export const ADDITIONAL_INCOME = 'Zusätzliche Einnahmen';
export function category_catalog(settings, expenseOnly = false) {
  const rules = settings.rules || [];
  const excluded = new Set(rules.filter(r => ['fixed', 'income', 'internal_transfer'].includes(r.group) || r.excludeFromTotals).map(r => r.category || r.label));
  const names = [UNCATEGORIZED, ...(!expenseOnly ? [ADDITIONAL_INCOME] : []), ...rules.map(r => r.category || r.label),
    ...Object.keys(settings.categoryMappings || {}),
    ...(settings.mainCategories || []).map(m => m.entryCategory || m.label)];
  return [...new Set(names.filter(Boolean))].filter(c => !expenseOnly || !excluded.has(c));
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
