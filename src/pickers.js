import { t } from './i18n.js';

export const compact_screen = () => matchMedia('(max-width: 700px)').matches;

let selectDialog;
export function open_select_dialog(select) {
  if (!selectDialog) {
    selectDialog = document.createElement('dialog');
    selectDialog.className = 'selection-dialog';
    selectDialog.dataset.responsivePicker = '';
    selectDialog.innerHTML = '<header><h2></h2><button type="button" class="picker-close" autofocus>×</button></header><input type="search" class="picker-search"><div class="picker-options"></div>';
    document.body.append(selectDialog);
    selectDialog.querySelector('.picker-close').onclick = () => selectDialog.close();
  }
  // A wrapping label contains the select's option text too. Keep only the
  // label itself when using it as the picker title.
  const label = select.labels?.[0]?.cloneNode(true);
  label?.querySelectorAll('select, input, button').forEach(control => control.remove());
  const title = select.getAttribute('aria-label') || label?.textContent.trim() || t('quickEntry.moreGridTitle');
  selectDialog.querySelector('h2').textContent = title;
  const search = selectDialog.querySelector('input');
  search.placeholder = t('table.filterCategories'); search.value = '';
  selectDialog.querySelector('.picker-close').setAttribute('aria-label', t('modal.close'));
  const render = () => {
    const list = selectDialog.querySelector('.picker-options'); list.replaceChildren();
    for (const option of select.options) {
      if (option.disabled || option.parentElement.disabled || !option.text.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) continue;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = option.text;
      button.classList.toggle('active', option.value === select.value);
      button.onclick = () => {
        selectDialog.close();
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      list.append(button);
    }
    if (!list.childElementCount) list.textContent = t('table.noCategoryMatch');
  };
  search.oninput = render; render();
  if (!selectDialog.open) selectDialog.showModal();
  selectDialog.querySelector('.picker-close').focus();
  fit_picker_dialogs();
}

export function fit_picker_dialogs() {
  const viewport = window.visualViewport;
  if (!compact_screen()) return;
  document.querySelectorAll('dialog[data-responsive-picker][open]').forEach(dialog => {
    dialog.style.setProperty('--picker-height', `${Math.max(180, (viewport?.height || innerHeight) - 24)}px`);
    dialog.style.setProperty('--picker-top', `${(viewport?.offsetTop || 0) + 12}px`);
  });
}

export function init_responsive_selects() {
  document.addEventListener('pointerdown', event => {
    if (!compact_screen() || !(event.target instanceof HTMLSelectElement) || event.target.disabled) return;
    event.preventDefault(); open_select_dialog(event.target);
  }, true);
  document.addEventListener('click', event => {
    if (!compact_screen() || !(event.target instanceof HTMLSelectElement) || event.target.disabled) return;
    event.preventDefault();
    if (!selectDialog?.open) open_select_dialog(event.target);
  }, true);
  document.addEventListener('keydown', event => {
    if (compact_screen() && event.target instanceof HTMLSelectElement && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); open_select_dialog(event.target);
    }
  });
  window.visualViewport?.addEventListener('resize', fit_picker_dialogs);
  window.visualViewport?.addEventListener('scroll', fit_picker_dialogs);
}
