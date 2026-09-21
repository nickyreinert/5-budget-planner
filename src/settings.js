// Three-way settings import: local edits/deletions survive a later LLM proposal.
const arrayFields = new Set(['rules', 'mainCategories', 'groups']);
const mapFields = new Set(['categoryMappings', 'subBudgetCaps', 'categoryGroupFallback']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = x => x === undefined ? undefined : structuredClone(x);
export function settings_changes(current, incoming, baseline = {}) {
  const changes = [];
  for (const field of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
    if (field.startsWith('_')) continue;
    const a = current[field], b = incoming[field], base = baseline[field];
    if (arrayFields.has(field) || mapFields.has(field)) {
      const map = value => arrayFields.has(field) ? Object.fromEntries((value || []).map(x => [x.id, x])) : value || {};
      const am = map(a), bm = map(b), cm = map(base);
      for (const key of new Set([...Object.keys(am), ...Object.keys(bm)])) {
        if (equal(am[key], bm[key])) continue;
        changes.push({ field, key, before: clone(am[key]), after: clone(bm[key]), protected: !equal(am[key], cm[key]) });
      }
      if (arrayFields.has(field)) {
        const order = value => (value || []).map(x => x.id);
        if (!equal(order(a), order(b))) changes.push({ field, order: true, before: order(a), after: order(b), protected: !equal(order(a), order(base)) });
      }
    } else if (!equal(a, b)) changes.push({ field, before: clone(a), after: clone(b), protected: !equal(a, base) });
  }
  return changes;
}
export function apply_settings_changes(current, changes, selected) {
  const result = clone(current);
  changes.forEach((c, index) => {
    if (!selected.has(index)) return;
    if (c.order) {
      const rank = id => c.after.includes(id) ? c.after.indexOf(id) : c.after.length;
      result[c.field]?.sort((a,b) => rank(a.id) - rank(b.id));
    } else if (arrayFields.has(c.field)) {
      const values = result[c.field] ||= [];
      const i = values.findIndex(x => x.id === c.key);
      if (c.after === undefined) { if (i >= 0) values.splice(i, 1); }
      else if (i >= 0) values[i] = clone(c.after);
      else values.push(clone(c.after));
    } else if (mapFields.has(c.field)) {
      result[c.field] ||= {};
      if (c.after === undefined) delete result[c.field][c.key];
      else result[c.field][c.key] = clone(c.after);
    } else if (c.after === undefined) delete result[c.field];
    else result[c.field] = clone(c.after);
  });
  return result;
}
export function manual_rule_ids(current, baseline) {
  const base = new Map((baseline.rules || []).map(r => [r.id, r]));
  return (current.rules || []).filter(r => !equal(r, base.get(r.id))).map(r => r.id);
}
