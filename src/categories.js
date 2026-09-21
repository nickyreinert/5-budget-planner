// Only names explicitly present in the active settings belong to the catalog.
export function category_catalog(settings, expenseOnly = false) {
  const rules = settings.rules || [];
  const excluded = new Set(rules.filter(r => ['fixed', 'income', 'internal_transfer'].includes(r.group) || r.excludeFromTotals).map(r => r.category || r.label));
  const names = [...rules.map(r => r.category || r.label),
    ...Object.keys(settings.categoryMappings || {}),
    ...(settings.mainCategories || []).map(m => m.entryCategory || m.label)];
  return [...new Set(names.filter(Boolean))].filter(c => !expenseOnly || !excluded.has(c));
}

export function sort_categories(categories, favorites = []) {
  const favs = new Set(favorites);
  return [...categories].sort((a, b) => Number(favs.has(b)) - Number(favs.has(a)) || a.localeCompare(b, 'de'));
}
