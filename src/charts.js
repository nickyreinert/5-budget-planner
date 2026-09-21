// --- charts.js ---
// Chart.js loaded via UMD in index.html, available as global Chart
import { t, locale } from './i18n.js';
let combined_chart = null;

const CHART_COLORS = [
  '#e74c3c', // red
  '#3498db', // blue
  '#f39c12', // orange
  '#2ecc71', // green
  '#9b59b6', // purple
  '#1abc9c', // turquoise
  '#e67e22', // dark orange
  '#34495e', // dark blue-gray
  '#f1c40f', // yellow
  '#16a085', // dark turquoise
  '#c0392b', // dark red
  '#d35400', // burnt orange
  '#8e44ad', // dark purple
  '#27ae60', // dark green
  '#2980b9', // darker blue
  '#95a5a6'  // gray
];

// Assigns each distinct category name its own color (in order of first use)
// instead of deriving it from string length, which collided constantly
// (many differently-named categories share the same length % palette-size).
const categoryColorMap = new Map();
let nextColorIndex = 0;

export function get_color(cat) {
  if (!categoryColorMap.has(cat)) {
    categoryColorMap.set(cat, CHART_COLORS[nextColorIndex % CHART_COLORS.length]);
    nextColorIndex++;
  }
  return categoryColorMap.get(cat);
}

export function render_combined_chart(outData, inData, canvasId, onBarClick, recurringAvgData = null, labelFor = null, colorFor = null) {
  const labelSet = new Set([...(Object.keys(outData||{})), ...(Object.keys(inData||{}))]);
  const keys = Array.from(labelSet).sort();
  // pretty labels like "Nov 2025"
  const labels = keys.map(k => {
    const [y, m] = k.split('-').map(Number);
    try {
      return new Date(y, m-1, 1).toLocaleString(locale(), { month: 'short', year: 'numeric' });
    } catch (e) { return k; }
  });
  // `categories` holds the stable keys (e.g. group ids) used for both the
  // click handler and data lookups; labelFor/colorFor translate a key to
  // display text/color (e.g. a group id to its human label) without
  // changing what onBarClick receives.
  const categories = [...new Set(Object.values(outData||{}).flatMap(o => Object.keys(o||{})))];
  // Map data using keys (not pretty labels)
  // convert cents -> euros for chart display (exact division)
  const barDatasets = categories.map(cat => ({
    type: 'bar', label: labelFor ? labelFor(cat) : cat,
    data: keys.map(k => (outData[k] && outData[k][cat]) ? (outData[k][cat] / 100) : 0),
    backgroundColor: colorFor ? colorFor(cat) : get_color(cat), stack: 'out', order: 10
  }));
  // make the line visually dominant and ensure it renders after bars
  const lineDataset = {
    type: 'line',
    label: t('charts.income'),
    data: keys.map(k => (inData[k] || 0) / 100),
    borderColor: '#2ecc71',
    backgroundColor: 'rgba(46,204,113,0.1)',
    fill: false,
    stack: 'income', // Separate stack so it doesn't add on top of bars
    order: 1,
    borderWidth: 4,
    pointRadius: 5,
    pointHoverRadius: 7,
    pointBackgroundColor: '#2ecc71',
    pointBorderColor: '#fff',
    pointBorderWidth: 2,
    tension: 0.2,
    yAxisID: 'y1'
  };

  const datasets = [...barDatasets, lineDataset];

  // Add recurring average line if data is provided
  if (recurringAvgData) {
    const recurringValues = keys.map(k => recurringAvgData[k] || 0);
    console.log('Recurring Avg Data (should be in euros, e.g. 151):', recurringValues[0]);
    const recurringAvgDataset = {
      type: 'line',
      label: t('charts.avgFixed'),
      data: recurringValues,
      borderColor: '#e74c3c',
      backgroundColor: 'rgba(231,76,60,0.1)',
      fill: false,
      stack: 'recurring', // Separate stack so it doesn't add on top of bars
      order: 2,
      borderWidth: 3,
      borderDash: [5, 5],
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: '#e74c3c',
      pointBorderColor: '#fff',
      pointBorderWidth: 2,
      tension: 0.2,
      yAxisID: 'y'
    };
    datasets.push(recurringAvgDataset);
  }
  // Income (maxIn) is intentionally NOT part of the expense axis: group_data
  // always sums income across the full period regardless of the category
  // drill-down, so once you drill into a small subcategory its bars can be
  // a tiny fraction of monthly income — sharing one axis would squash them
  // to invisibility. Income gets its own right-hand axis (y1) instead.
  const sumsOut = keys.map(k => Object.values(outData[k]||{}).reduce((a,b)=>a+b,0));
  const maxOut = sumsOut.length ? Math.max(...sumsOut) : 0;
  const maxIn = keys.map(k=>inData[k]||0).reduce((a,b)=>Math.max(a,b),0);
  // recurringAvgData values are already in euros, so we need to convert to cents for comparison with maxOut
  const maxRecurringAvg = recurringAvgData ? Math.max(...Object.values(recurringAvgData)) * 100 : 0;
  // maxVal in euros
  let maxVal = Math.ceil(Math.max(maxOut, maxRecurringAvg, 100) * 1.05) / 100;
  let maxInVal = Math.ceil(Math.max(maxIn, 100) * 1.05) / 100;

  // Calculate stack totals in euros for each bar
  const stackTotals = keys.map(k => {
    const total = Object.values(outData[k] || {}).reduce((a, b) => a + b, 0);
    return total / 100; // Convert cents to euros
  });

  // Custom plugin to draw sum labels on top of stacked bars
  const stackSumPlugin = {
    id: 'stackSumLabels',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: { top }, scales: { x, y } } = chart;
      ctx.save();

      // Draw sum for each bar
      stackTotals.forEach((total, index) => {
        if (total === 0) return; // Skip if no data

        const xPos = x.getPixelForValue(index);
        const yPos = y.getPixelForValue(total);

        ctx.fillStyle = '#333';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        // Format number with 2 decimals
        const label = total.toFixed(2);
        ctx.fillText(label, xPos, yPos - 5);
      });

      ctx.restore();
    }
  };

  if (combined_chart) combined_chart.destroy();
  combined_chart = new Chart(document.getElementById(canvasId), {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, max: maxVal },
        y1: { position: 'right', beginAtZero: true, max: maxInVal, grid: { drawOnChartArea: false }, title: { display: true, text: t('charts.income') } }
      },
      onClick: (evt, elements) => {
        if (!elements || !elements.length) return;
        const el = elements[0];
        const dsIndex = el.datasetIndex;
        // only handle bar dataset clicks (not the income/avg lines)
        if (dsIndex < categories.length && typeof onBarClick === 'function') {
          onBarClick(categories[dsIndex]);
        }
      },
      plugins:{
        tooltip:{ callbacks:{ label:(ctx)=>`${ctx.dataset.label}: ${formatNumber(ctx.parsed.y)}` }}
      }
    },
    plugins: [stackSumPlugin]
  });
}

function formatNumber(v) { return (Math.round((v + Number.EPSILON) * 100) / 100).toFixed(2); }

let averages_chart = null;

export function render_averages_chart(avgData, canvasId) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // avgData.monthlyAverages: array of {in, out} in cents
    // avgData.globalAverage: {in, out} in cents

    const monthlyIn = avgData.monthlyAverages.map(d => d.in / 100);
    const monthlyOut = avgData.monthlyAverages.map(d => d.out / 100);
    const globalIn = avgData.globalAverage.in / 100;
    const globalOut = avgData.globalAverage.out / 100;

    const datasets = [
        {
            type: 'bar',
            label: t('charts.avgIncome'),
            data: monthlyIn,
            backgroundColor: 'rgba(46,204,113,0.7)', // Green
            order: 2,
            stack: 'income_stack'
        },
        {
            type: 'bar',
            label: t('charts.avgOutgoing'),
            data: monthlyOut,
            backgroundColor: 'rgba(231,76,60,0.7)', // Red
            order: 3,
            stack: 'expenses_stack'
        },
        {
            type: 'line',
            label: t('charts.totalAvgIncome'),
            data: Array(12).fill(globalIn),
            borderColor: '#2ecc71',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
            order: 0
        },
        {
            type: 'line',
            label: t('charts.totalAvgOutgoing'),
            data: Array(12).fill(globalOut),
            borderColor: '#e74c3c',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
            order: 1
        }
    ];

    if (averages_chart) averages_chart.destroy();

    averages_chart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: v => v.toLocaleString(locale(), { style: 'currency', currency: 'EUR' }) }
                }
            },
             plugins: {
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                             let label = ctx.dataset.label || '';
                             if (label) label += ': ';
                             if (ctx.parsed.y !== null) {
                                  label += (ctx.parsed.y).toLocaleString(locale(), { style: 'currency', currency: 'EUR' });
                             }
                             return label;
                        }
                    }
                },
                title: {
                    display: true,
                    text: t('charts.averageMonthlyMetrics')
                },
                 legend: {
                    position: 'top',
                }
            }
        }
    });
}

let leak_chart = null;

// Horizontal ranked bar chart of expense categories, colored by group
// (fixed/essential/discretionary/...) so discretionary "money leaks"
// (Amazon, Steam, delivery apps, ...) visually stand out at the top.
export function render_leak_chart(leakReport, groupColors, canvasId, onBarClick, topN = 15) {
  const rows = leakReport.slice(0, topN);
  const labels = rows.map(r => r.category);
  const values = rows.map(r => r.cents / 100);
  const colors = rows.map(r => groupColors[r.group] || '#95a5a6');

  if (leak_chart) leak_chart.destroy();
  leak_chart = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels, datasets: [{ label: t('charts.expenses'), data: values, backgroundColor: colors }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, ticks: { callback: v => v.toLocaleString(locale(), { style: 'currency', currency: 'EUR' }) } }
      },
      onClick: (evt, elements) => {
        if (!elements || !elements.length || typeof onBarClick !== 'function') return;
        onBarClick(rows[elements[0].index].category);
      },
      plugins: {
        legend: { display: false },
        title: { display: true, text: t('charts.moneyLeaks') },
        tooltip: { callbacks: { label: (ctx) => (ctx.parsed.x).toLocaleString(locale(), { style: 'currency', currency: 'EUR' }) } }
      }
    }
  });
}

let group_summary_chart = null;

// Donut chart summarizing expenses by group (Fixkosten / Notwendig /
// Diskretionär / ...) against total income, to make the savings rate (or
// deficit) immediately visible.
export function render_group_summary_chart(summary, ruleSetGroups, canvasId) {
  const ids = Object.keys(summary.byGroup).filter(id => summary.byGroup[id] > 0);
  const meta = id => (ruleSetGroups || []).find(g => g.id === id) || { label: id, color: '#95a5a6' };
  const labels = ids.map(id => meta(id).label);
  const values = ids.map(id => summary.byGroup[id] / 100);
  const colors = ids.map(id => meta(id).color);

  const netCents = summary.net;
  const netLabel = (netCents / 100).toLocaleString(locale(), { style: 'currency', currency: 'EUR' });

  if (group_summary_chart) group_summary_chart.destroy();
  group_summary_chart = new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: t('charts.incomeNetTitle', { income: (summary.totalIncome / 100).toLocaleString(locale(), { style: 'currency', currency: 'EUR' }), net: netLabel })
        },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${(ctx.parsed).toLocaleString(locale(), { style: 'currency', currency: 'EUR' })}` } },
        legend: { position: 'bottom' }
      }
    }
  });
}

let growth_chart = null;

export function render_growth_chart(outData, canvasId, mode = 'mom', chartType = 'line', labelFor = null, colorFor = null) {
  const keys = Object.keys(outData || {}).sort();

  // For YoY mode, filter to show only the most recent year on X-axis
  let displayKeys = keys;
  if (mode === 'yoy' && keys.length > 0) {
    // Get the year of the last key (most recent)
    const lastKey = keys[keys.length - 1];
    const [lastYear] = lastKey.split('-').map(Number);
    // Only show keys from the current (most recent) year
    displayKeys = keys.filter(k => {
      const [y] = k.split('-').map(Number);
      return y === lastYear;
    });
  }

  const labels = displayKeys.map(k => {
    const [y, m] = k.split('-').map(Number);
    try {
      return new Date(y, m-1, 1).toLocaleString(locale(), { month: 'short', year: 'numeric' });
    } catch (e) { return k; }
  });
  const categories = [...new Set(Object.values(outData||{}).flatMap(o => Object.keys(o||{})))];

  // Calculate growth rates based on mode
  const datasets = categories.map(cat => {
    const values = keys.map(k => (outData[k] && outData[k][cat]) ? outData[k][cat] : 0);
    const growthRates = values.map((v, i) => {
      if (mode === 'mom') {
        // Month-over-Month
        if (i === 0 || values[i-1] === 0) return 0;
        return ((v - values[i-1]) / values[i-1]) * 100;
      } else {
        // Year-over-Year
        if (i < 12 || values[i-12] === 0) return 0;
        return ((v - values[i-12]) / values[i-12]) * 100;
      }
    });

    // For display, only use growth rates for the display keys
    const displayGrowthRates = mode === 'yoy'
      ? displayKeys.map(dk => {
          const idx = keys.indexOf(dk);
          return idx >= 0 ? growthRates[idx] : 0;
        })
      : growthRates;

    const color = colorFor ? colorFor(cat) : get_color(cat);
    return {
      type: chartType,
      label: labelFor ? labelFor(cat) : cat,
      data: displayGrowthRates,
      borderColor: chartType === 'line' ? color : undefined,
      backgroundColor: chartType === 'bar' ? color : 'transparent',
      fill: false,
      tension: 0.1,
      borderWidth: chartType === 'line' ? 2 : 1
    };
  });

  if (growth_chart) growth_chart.destroy();
  growth_chart = new Chart(document.getElementById(canvasId), {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: t('charts.month') },
          stacked: false
        },
        y: {
          title: { display: true, text: t('charts.growthRatePercent') },
          beginAtZero: false,
          stacked: false
        }
      },
      plugins: {
        title: { display: true, text: mode === 'mom' ? t('charts.momTitle') : t('charts.yoyTitle') },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` } }
      }
    }
  });
}
