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
