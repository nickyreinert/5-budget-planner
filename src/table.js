// --- table.js ---
import { expense_matches_path, tx_id } from './data.js';
import { transaction_source_label } from './transactions.js';
import { t } from './i18n.js';

let sortState = { column: null, ascending: true };
let filterState = {};
// Row selection (for bulk category assignment) and category-popover state
// are module-scoped so they survive individual re-renders (sort/filter
// toggles rebuild the whole tbody).
let selectedIds = new Set();
let lastDisplayIds = [];
let popoverEl = null;

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function render_table(rows, tbodySelector, current_path, leakCategoryFilter = null, categoryOptions = [], onCategoryChange = null) {
  const tbody = document.querySelector(tbodySelector);
  tbody.innerHTML = '';

  // Filter transactions based on mode
  let display = rows.filter(r => r.in_out === 'out');

  if (leakCategoryFilter) {
    // Money-flow quick filter: jump straight to one rule-engine category,
    // independent of (and mutually exclusive with) the breadcrumb drill-down
    display = display.filter(r => r._cls && r._cls.category === leakCategoryFilter);
  } else if (current_path.length > 0) {
    // Breadcrumb drill-down: Ausgaben -> Gruppe -> Kategorie
    display = display.filter(r => expense_matches_path(r, current_path));
  }

  // Apply column filters from saved state
  Object.keys(filterState).forEach(column => {
    const filterValue = filterState[column].toLowerCase().trim();
    if (filterValue) {
      display = display.filter(r => {
        let cellValue = '';
        if (column === 'date') cellValue = r.Datum || '';
        else if (column === 'name') cellValue = r.Name || '';
        else if (column === 'verwendungszweck') cellValue = r.Verwendungszweck || '';
        else if (column === 'betrag') cellValue = (r.betrag_cents / 100).toFixed(2);
        else if (column === 'kategorie') cellValue = r._cls ? r._cls.category : '';
        return cellValue.toLowerCase().includes(filterValue);
      });
    }
  });

  // Apply sorting
  if (sortState.column) {
    display.sort((a, b) => {
      let aVal, bVal;
      if (sortState.column === 'date') {
        aVal = a.date.getTime();
        bVal = b.date.getTime();
      } else if (sortState.column === 'name') {
        aVal = (a.Name || '').toLowerCase();
        bVal = (b.Name || '').toLowerCase();
      } else if (sortState.column === 'verwendungszweck') {
        aVal = (a.Verwendungszweck || '').toLowerCase();
        bVal = (b.Verwendungszweck || '').toLowerCase();
      } else if (sortState.column === 'betrag') {
        aVal = a.betrag_cents;
        bVal = b.betrag_cents;
      } else if (sortState.column === 'kategorie') {
        aVal = (a._cls ? a._cls.category : '').toLowerCase();
        bVal = (b._cls ? b._cls.category : '').toLowerCase();
      }
      if (aVal < bVal) return sortState.ascending ? -1 : 1;
      if (aVal > bVal) return sortState.ascending ? 1 : -1;
      return 0;
    });
  }

  display.forEach(r => {
    const tr = document.createElement('tr');
    const euro = (r.betrag_cents / 100).toFixed(2);
    const cls = r._cls ? r._cls.category : '';
    const id = tx_id(r);
    const checked = selectedIds.has(id) ? ' checked' : '';
    tr.innerHTML = `<td class="select-col"><input type="checkbox" class="row-select" data-id="${esc(id)}"${checked}></td>` +
      `<td>${esc(r.Datum)}<small class="transaction-source">${esc(transaction_source_label(r))}</small></td><td>${esc(r.Name)}</td><td>${esc(r.Verwendungszweck)}</td><td>${euro}</td>` +
      `<td><button type="button" class="category-picker-btn" data-id="${esc(id)}" data-category="${esc(cls)}">${esc(cls) || '—'} <span class="caret">▾</span></button></td>`;
    tbody.appendChild(tr);
  });

  lastDisplayIds = display.map(tx_id);

  tbody.querySelectorAll('.row-select').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
      update_select_all_checkbox();
      update_bulk_bar(categoryOptions, onCategoryChange);
    });
  });

  tbody.querySelectorAll('.category-picker-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      open_category_popover(btn, categoryOptions, (category) => {
        onCategoryChange && onCategoryChange([btn.dataset.id], category);
      });
    });
  });

  update_select_all_checkbox();
  update_bulk_bar(categoryOptions, onCategoryChange);
}

function update_select_all_checkbox() {
  const cb = document.getElementById('selectAllRows');
  if (!cb) return;
  const total = lastDisplayIds.length;
  const selectedVisible = lastDisplayIds.filter(id => selectedIds.has(id)).length;
  cb.checked = total > 0 && selectedVisible === total;
  cb.indeterminate = selectedVisible > 0 && selectedVisible < total;
}

// Shows/hides the "second header row" bulk-assign bar once more than one
// row is selected, and wires its category picker to assign the chosen
// category to every selected row at once.
function update_bulk_bar(categoryOptions, onCategoryChange) {
  const bar = document.getElementById('bulkActionsRow');
  if (!bar) return;
  const count = selectedIds.size;
  bar.hidden = count <= 1;
  if (count <= 1) return;

  const countEl = document.getElementById('bulkSelectedCount');
  if (countEl) countEl.textContent = t('table.selectedCount', { count });

  const catBtn = document.getElementById('bulkCategoryBtn');
  if (catBtn) {
    catBtn.onclick = (e) => {
      e.stopPropagation();
      open_category_popover(catBtn, categoryOptions, (category) => {
        onCategoryChange && onCategoryChange([...selectedIds], category);
        selectedIds.clear();
      });
    };
  }
}

// True for a brief moment right after opening: focusing the filter input on
// a just-unhidden, fixed-position element can make the browser scroll it
// into view as a side effect, firing a 'scroll' event that would otherwise
// close the popover the instant it opens.
let justOpened = false;

function ensure_popover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement('div');
  popoverEl.className = 'category-popover';
  popoverEl.hidden = true;
  popoverEl.innerHTML = `<input type="text" class="category-popover-filter"><div class="category-popover-list"></div>`;
  document.body.appendChild(popoverEl);
  // Deferred via setTimeout: this is the popover's first-ever use, called
  // from inside the very click handler that's about to open it. Registering
  // synchronously would let this same click event's bubble phase reach the
  // brand-new listener before it finishes dispatching (a newly added
  // listener still fires for an in-flight event once it bubbles that far),
  // closing the popover the instant it opens.
  setTimeout(() => {
    document.addEventListener('click', (e) => {
      if (!popoverEl.hidden && !popoverEl.contains(e.target) && e.target !== popoverEl._anchor && !popoverEl._anchor?.contains(e.target)) {
        close_popover();
      }
    });
  }, 0);
  window.addEventListener('scroll', () => { if (!justOpened) close_popover(); }, true);
  return popoverEl;
}

// Exported so a global Escape-key handler can dismiss it too.
export function close_popover() {
  if (popoverEl) popoverEl.hidden = true;
}

// Opens the shared category dropdown below `anchorBtn`, with a quick-filter
// text input on top and the (deduplicated) list of known categories below;
// clicking one calls `onPick(category)`. Exported so the quick-entry sheet's
// "more categories" button can reuse the exact same picker.
export function open_category_popover(anchorBtn, categoryOptions, onPick) {
  const pop = ensure_popover();
  pop._anchor = anchorBtn;
  const filterInput = pop.querySelector('.category-popover-filter');
  const listEl = pop.querySelector('.category-popover-list');
  const current = anchorBtn.dataset.category || '';
  filterInput.placeholder = t('table.filterCategories');

  function renderList(query) {
    const q = (query || '').toLowerCase().trim();
    const opts = categoryOptions.filter(c => c.toLowerCase().includes(q));
    listEl.innerHTML = opts.map(c =>
      `<button type="button" class="category-popover-item${c === current ? ' active' : ''}" data-category="${esc(c)}">${esc(c)}</button>`
    ).join('') || `<div class="category-popover-empty">${esc(t('table.noCategoryMatch'))}</div>`;
    listEl.querySelectorAll('.category-popover-item').forEach(btn => {
      btn.addEventListener('click', () => {
        onPick(btn.dataset.category);
        close_popover();
      });
    });
  }

  filterInput.value = '';
  filterInput.oninput = () => renderList(filterInput.value);
  renderList('');

  const rect = anchorBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.left = Math.min(rect.left, window.innerWidth - 280) + 'px';
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.hidden = false;
  justOpened = true;
  setTimeout(() => { justOpened = false; }, 150);
  filterInput.focus();
}

// Initialize sorting and filtering
export function init_table_controls(renderCallback) {
  // Add sorting to headers
  document.querySelectorAll('th[data-column]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return; // Don't sort when clicking input
      const column = th.getAttribute('data-column');
      if (sortState.column === column) {
        sortState.ascending = !sortState.ascending;
      } else {
        sortState.column = column;
        sortState.ascending = true;
      }
      renderCallback();
    });
  });

  // Add filtering to inputs
  document.querySelectorAll('th[data-column] input').forEach(input => {
    const column = input.closest('th').getAttribute('data-column');
    // Restore saved filter value
    if (filterState[column]) {
      input.value = filterState[column];
    }
    input.addEventListener('input', (e) => {
      e.stopPropagation();
      filterState[column] = input.value;
      renderCallback();
    });
    input.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  const selectAllCb = document.getElementById('selectAllRows');
  if (selectAllCb) {
    selectAllCb.addEventListener('change', (e) => {
      if (e.target.checked) lastDisplayIds.forEach(id => selectedIds.add(id));
      else lastDisplayIds.forEach(id => selectedIds.delete(id));
      renderCallback();
    });
  }

  const clearSelectionBtn = document.getElementById('bulkClearSelectionBtn');
  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener('click', () => {
      selectedIds.clear();
      renderCallback();
    });
  }
}
