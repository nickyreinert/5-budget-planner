import { is_real_cashflow } from './data.js';
import { budget_category } from './budgets.js';
import { week_start, add_days, iso_week_number, category_color } from './week.js';
import { account_key, is_paypal_account } from './transfers.js';

export const is_salary = row => row._cls?.group === 'income' && (row._cls.incomeType === 'salary' || (!row._cls.incomeType && /gehalt|\blohn\b|salary/i.test(row._cls.category)));
export function filter_overview_rows(rows, { year = '', from = null, to = null, account = '' } = {}) {
  return rows.filter(r => is_real_cashflow(r) && (!year || r.date.getFullYear() === Number(year)) &&
    (!from || r.date >= from) && (!to || r.date < to) && (!account || ((r._effectiveAccount || account_key(r)) === account || (is_paypal_account(r) && account_key(r) === account))));
}
export function period_start(date, granularity) {
  if (granularity === 'week') return week_start(date);
  return new Date(date.getFullYear(), granularity === 'year' ? 0 : date.getMonth(), 1);
}
export function period_label(date, granularity) {
  if (granularity === 'week') return `KW ${iso_week_number(date)} · ${add_days(date, 3).getFullYear()}`;
  return date.toLocaleDateString('de-DE', granularity === 'year' ? { year: 'numeric' } : { month: 'short', year: '2-digit' });
}
// All amounts remain integer cents until the chart boundary.
export function build_timeline(rows, settings, kind, granularity = 'month', drill = null) {
  const periods = new Map(), series = new Map();
  if (rows.length) {
    let cursor = period_start(new Date(Math.min(...rows.map(r => +r.date))), granularity);
    const end = period_start(new Date(Math.max(...rows.map(r => +r.date))), granularity);
    while (cursor <= end) {
      periods.set(+cursor, period_label(cursor, granularity));
      cursor = granularity === 'week' ? add_days(cursor, 7) : new Date(cursor.getFullYear() + (granularity === 'year' ? 1 : 0), cursor.getMonth() + (granularity === 'month' ? 1 : 0), 1);
    }
  }
  for (const row of rows) {
    if (!is_real_cashflow(row)) continue;
    const cls = row._cls || {}, category = cls.category || 'Sonstige Ausgaben';
    let key, label, cents, color;
    if (kind === 'budget') {
      if (row.betrag_cents >= 0 || cls.group === 'fixed') continue;
      const id = budget_category(settings, category) || 'sonstiges';
      if (drill && id !== drill) continue;
      const main = (settings.mainCategories || []).find(m => m.id === id);
      key = drill ? category : id; label = drill ? category : main?.label || 'Sonstiges'; color = drill ? category_color(category) : main?.color || category_color(id);
      cents = -row.betrag_cents;
    } else if (kind === 'fixed') {
      if (row.betrag_cents >= 0 || cls.group !== 'fixed' || (drill && category !== drill)) continue;
      key = drill ? row.name : category; label = key; cents = -row.betrag_cents; color = category_color(key);
    } else {
      key = row.betrag_cents < 0 ? 'Ausgaben' : is_salary(row) ? 'Gehalt' : 'Other income';
      label = key; cents = row.betrag_cents;
      color = key === 'Ausgaben' ? '#db6671' : key === 'Gehalt' ? '#35a880' : '#679ce4';
    }
    if (!series.has(key)) series.set(key, { key, label, color, values: new Map() });
    const stamp = +period_start(row.date, granularity), s = series.get(key);
    s.values.set(stamp, (s.values.get(stamp) || 0) + cents);
  }
  const stamps = [...periods.keys()].sort((a,b) => a-b);
  return { labels: stamps.map(s => periods.get(s)), stamps,
    series: [...series.values()].map(s => ({ ...s, values: stamps.map(p => s.values.get(p) || 0) })) };
}

export function render_timeline(canvas, model, onSelect) {
  const previous = globalThis.Chart?.getChart(canvas);
  if (previous) previous.destroy();
  if (!globalThis.Chart) return;
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
  return new Chart(canvas, {
    type: 'bar', data: { labels: model.labels, datasets: model.series.map(s => ({ label: s.label, data: s.values.map(v => v / 100), backgroundColor: s.color, borderRadius: 3, maxBarThickness: 48 })) },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'nearest', intersect: true },
      plugins: { legend: { position: 'bottom', labels: { color: muted, boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toLocaleString('de-DE', { style:'currency', currency:'EUR' })}` } } },
      scales: { x: { stacked: true, ticks: { color: muted, maxRotation: 0, autoSkip: true }, grid: { display: false } }, y: { stacked: true, ticks: { color: muted, callback: v => v.toLocaleString('de-DE') + ' €' } } },
      onClick: (_event, elements) => { if (elements.length && onSelect) onSelect(model.series[elements[0].datasetIndex].key, model.stamps[elements[0].index]); },
      onHover: (event, elements) => { if (event.native?.target) event.native.target.style.cursor = elements.length && onSelect ? 'pointer' : 'default'; }
    }
  });
}
