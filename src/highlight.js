// --- highlight.js ---
// Hover/focus guidance for expandable sections. Anything marked `.rg-card`
// (a section) or `.rg-item` (a sub-section inside one) is highlighted while
// the pointer is over it and its siblings fade back. Clicking or typing in a
// child keeps that section highlighted even after the pointer stops or
// leaves; the pointer takes over again as soon as it moves onto another
// section. One shared behaviour for the main view, the wizard and every
// settings tab - state lives in the DOM classes `.rg-active` / `.rg-dim`.

const SECTION = '.rg-card, .rg-item';
const roots = new Set();
const paths = new WeakMap(); // root element -> section keys, outermost first

const key = el => el.dataset.rgKey || el.dataset.budget || el.dataset.parent || `#${[...el.parentElement.children].indexOf(el)}`;

function path_of(target) {
  const path = [];
  for (let el = target.closest?.(SECTION); el; el = el.parentElement?.closest(SECTION)) path.unshift(el);
  return path;
}

function children_of(scope, root) {
  const all = [...scope.querySelectorAll(SECTION)];
  return scope === root ? all.filter(el => !el.parentElement.closest(SECTION)) : all.filter(el => el.parentElement.closest(SECTION) === scope);
}

function apply(root, keys) {
  root.querySelectorAll('.rg-active, .rg-dim').forEach(el => el.classList.remove('rg-active', 'rg-dim'));
  let scope = root;
  for (const k of keys) {
    const siblings = children_of(scope, root);
    const active = siblings.find(el => key(el) === k);
    if (!active) return;
    siblings.forEach(el => el.classList.add(el === active ? 'rg-active' : 'rg-dim'));
    scope = active;
  }
}

function show(target) {
  const path = path_of(target);
  if (!path.length) return null;
  const root = path[0].parentElement;
  const keys = path.map(key);
  if ((paths.get(root) || []).join('|') !== keys.join('|')) { paths.set(root, keys); roots.add(root); apply(root, keys); }
  return root;
}

function clear(root) {
  paths.delete(root);
  apply(root, []);
}

export function init_section_highlight(doc = document) {
  doc.addEventListener('pointerover', e => { if (e.pointerType !== 'touch') show(e.target); });
  doc.addEventListener('pointerout', e => {
    const path = path_of(e.target);
    const root = path[0]?.parentElement;
    if (!root || root.contains(e.relatedTarget)) return;
    // Left the whole list: fall back to whatever still has keyboard focus.
    if (root.contains(doc.activeElement) && doc.activeElement !== doc.body) show(doc.activeElement); else clear(root);
  });
  doc.addEventListener('focusin', e => show(e.target));
  doc.addEventListener('focusout', e => {
    const root = path_of(e.target)[0]?.parentElement;
    if (root && !root.contains(e.relatedTarget) && !root.matches(':hover')) clear(root);
  });
  // Lists are re-rendered on every edit - put the highlight back afterwards.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      roots.forEach(root => { if (!root.isConnected) roots.delete(root); else if (paths.has(root)) apply(root, paths.get(root)); });
    });
  }).observe(doc.body, { childList: true, subtree: true });
}
