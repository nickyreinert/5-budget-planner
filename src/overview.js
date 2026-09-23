import { is_real_cashflow } from './data.js';
import { budget_category } from './budgets.js';
import { week_start, add_days, iso_week_number, category_color } from './week.js';
import { account_key, is_paypal_account } from './transfers.js';
import { t, locale } from './i18n.js';

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
  if (granularity === 'week') return t('charts.weekLabel', { week: iso_week_number(date), year: add_days(date, 3).getFullYear() });
  return date.toLocaleDateString(locale(), granularity === 'year' ? { year: 'numeric' } : { month: 'short', year: '2-digit' });
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
    const cls = row._cls || {}, category = cls.category || 'Unkategorisiert';
    let key, label, cents, color;
    if (kind === 'budget') {
      if (row.betrag_cents >= 0 || cls.group === 'fixed') continue;
      const id = budget_category(settings, category) || '__unassigned';
      if (drill && id !== drill) continue;
      const main = (settings.mainCategories || []).find(m => m.id === id);
      key = drill ? category : id; label = drill ? category : main?.label || t('charts.unassigned'); color = drill ? category_color(category) : main?.color || category_color(id);
      cents = -row.betrag_cents;
    } else if (kind === 'fixed') {
      if (row.betrag_cents >= 0 || cls.group !== 'fixed' || (drill && category !== drill)) continue;
      key = drill ? row.name : category; label = key; cents = -row.betrag_cents; color = category_color(key);
    } else {
      key = row.betrag_cents < 0 ? 'Ausgaben' : is_salary(row) ? 'Gehalt' : 'Zusätzliche Einnahmen';
      label = key === 'Ausgaben' ? t('charts.expenses') : key === 'Gehalt' ? t('charts.salary') : t('charts.otherIncome'); cents = row.betrag_cents;
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

export function relative_deviation(values, baseline) {
  const nonZero = values.filter(value => value !== 0);
  const referenceValues = nonZero.length ? nonZero : values;
  const sorted = [...referenceValues].sort((a, b) => a - b);
  const reference = baseline === 'median'
    ? sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    : referenceValues.reduce((sum, value) => sum + value, 0) / (referenceValues.length || 1);
  return {
    reference,
    values: values.map(value => reference ? (value - reference) / Math.abs(reference) * 100 : 0)
  };
}

export function render_timeline(canvas, model, onSelect, { layout = 'stacked', deviation = 'none' } = {}) {
  const previous = globalThis.Chart?.getChart(canvas);
  if (previous) previous.destroy();
  if (!globalThis.Chart) return;
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
  const showDeviation = deviation === 'average' || deviation === 'median';
  const datasets = model.series.map(s => {
    const comparison = showDeviation ? relative_deviation(s.values, deviation) : null;
    return {
      label: s.label,
      data: comparison ? comparison.values : s.values.map(value => value / 100),
      rawValues: s.values,
      referenceValue: comparison?.reference,
      backgroundColor: s.color,
      borderRadius: 3,
      maxBarThickness: 48
    };
  });
  return new Chart(canvas, {
    type: 'bar', data: { labels: model.labels, datasets },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'nearest', intersect: true },
      plugins: { legend: { position: 'bottom', labels: { color: muted, boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: c => {
        if (!showDeviation) return `${c.dataset.label}: ${c.parsed.y.toLocaleString(locale(), { style:'currency', currency:'EUR' })}`;
        const raw = c.dataset.rawValues[c.dataIndex] / 100;
        const reference = c.dataset.referenceValue / 100;
        const sign = c.parsed.y > 0 ? '+' : '';
        const baseline = t(deviation === 'median' ? 'charts.median' : 'charts.average');
        return `${c.dataset.label}: ${sign}${c.parsed.y.toFixed(1)}% (${raw.toLocaleString(locale(), { style:'currency', currency:'EUR' })} · ${baseline} ${reference.toLocaleString(locale(), { style:'currency', currency:'EUR' })})`;
      } } } },
      scales: {
        x: { stacked: layout === 'stacked', ticks: { color: muted, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { stacked: layout === 'stacked', ticks: { color: muted, callback: value => showDeviation ? `${value > 0 ? '+' : ''}${value}%` : value.toLocaleString(locale()) + ' €' }, title: { display: showDeviation, text: t(deviation === 'median' ? 'charts.deviationMedianAxis' : 'charts.deviationAverageAxis') } }
      },
      onClick: (_event, elements) => { if (elements.length && onSelect) onSelect(model.series[elements[0].datasetIndex].key, model.stamps[elements[0].index]); },
      onHover: (event, elements) => { if (event.native?.target) event.native.target.style.cursor = elements.length && onSelect ? 'pointer' : 'default'; }
    }
  });
}
