// @ts-check
// Dialogs (Adw.AlertDialog, Adw.Dialog) on <dialog>.showModal(): alerts, confirmations, a text
// question, and a generic dialog with a header, a body and buttons.
import { h, icon } from './ui.js';
import { tr } from '../core/i18n.js';

/**
 * A modal dialog; resolves when it closes. `build(close)` fills the body.
 * @template T
 * @param {object} o
 * @param {string} [o.title] @param {string} [o.className] @param {string} [o.width]
 * @param {(close: (value?: T) => void) => Node | Node[]} o.build
 * @param {(close: (value?: T) => void) => Node[]} [o.footer]
 * @param {(close: (value?: T) => void) => Node[]} [o.headStart] buttons at the left of the header (Adw.HeaderBar)
 * @param {(close: (value?: T) => void) => Node[]} [o.headEnd]
 * @param {T} [o.dismissed] the value when closed by Esc or the close button
 * @param {boolean} [o.closeButton]
 * @returns {Promise<T|undefined>}
 */
export function showDialog({ title, className, width, build, footer, headStart, headEnd, dismissed, closeButton = false }) {
  return new Promise(resolve => {
    const dlg = /** @type {HTMLDialogElement} */ (h('dialog', { class: className, style: width ? { width } : undefined }));
    let value = dismissed;
    let leaving = false, finished = false;
    const finish = () => { if (finished) return; finished = true; dlg.remove(); resolve(value); };
    // Leave as it came, then close; the promise resolves once it is gone.
    const close = (/** @type {any} */ v) => {
      if (leaving) return;
      leaving = true; value = v;
      dlg.classList.add('closing');
      const done = () => { clearTimeout(timer); if (dlg.open) dlg.close(); finish(); };
      const timer = setTimeout(done, 200);
      dlg.addEventListener('animationend', e => { if (e.target === dlg) done(); });
    };
    if (title || closeButton || headStart || headEnd) {
      dlg.append(h('div', { class: 'dhead' },
        headStart ? h('div', { class: 'row' }, headStart(close)) : h('div', { style: { width: '34px' } }), h('h2', null, title || ''),
        headEnd ? h('div', { class: 'row' }, headEnd(close))
          : closeButton ? h('button', { class: 'flat icon-btn', title: tr('关闭'), onClick: () => close(dismissed) }, icon('close')) : h('div', { style: { width: '34px' } })));
    }
    const body = h('div', { class: 'dbody' }, build(close));
    dlg.append(body);
    const foot = footer?.(close);
    if (foot && foot.length) dlg.append(h('div', { class: 'dfoot' }, foot));
    dlg.addEventListener('close', () => finish());
    dlg.addEventListener('click', e => { if (e.target === dlg) close(dismissed); });   // a click on the backdrop
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(dismissed); });   // Esc
    dlg.tabIndex = -1;
    document.body.append(dlg);
    dlg.showModal();
    // showModal focuses the first button, which then wears a focus ring nobody asked for.
    /** @type {HTMLElement} */ (dlg.querySelector('[autofocus]') || dlg).focus();
  });
}

/**
 * A message with buttons; resolves to the value of the one pressed (null when dismissed).
 * @param {string} title @param {string} message
 * @param {{label: string, value: any, kind?: 'suggested'|'danger'|''}[]} buttons
 */
export function alertDialog(title, message, buttons) {
  return showDialog({
    className: 'alert', dismissed: null,
    build: () => [h('h2', null, title), message ? h('p', null, message) : null],
    footer: close => buttons.map(b => h('button', { class: b.kind === 'suggested' ? 'suggested' : b.kind === 'danger' ? 'danger' : '', onClick: () => close(b.value) }, b.label)),
  });
}

/** Tell the user something. @param {string} title @param {string} [message] */
export async function inform(title, message = '') {
  await alertDialog(title, message, [{ label: tr('好'), value: true, kind: 'suggested' }]);
}

/** Ask for confirmation. @param {string} title @param {string} [message] @param {{ok?: string, danger?: boolean}} [o] @returns {Promise<boolean>} */
export async function confirm(title, message = '', { ok = tr('确定'), danger = false } = {}) {
  return (await alertDialog(title, message, [
    { label: tr('取消'), value: false },
    { label: ok, value: true, kind: danger ? 'danger' : 'suggested' },
  ])) === true;
}

/** Ask for a line of text; null when cancelled. @param {string} title @param {{value?: string, label?: string, ok?: string, placeholder?: string}} [o] @returns {Promise<string|null>} */
export async function askText(title, { value = '', label = '', ok = tr('确定'), placeholder = '' } = {}) {
  /** @type {HTMLInputElement} */
  let input;
  const r = await showDialog({
    className: 'alert', dismissed: null,
    build: close => [h('h2', null, title), label ? h('p', null, label) : null,
      h('div', { style: { marginTop: '10px' } }, input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value, placeholder, autofocus: true, style: { width: '100%' },
        onKeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !e.isComposing) close(input.value); } })))],
    footer: close => [h('button', { onClick: () => close(null) }, tr('取消')), h('button', { class: 'suggested', onClick: () => close(input.value) }, ok)],
  });
  return r === undefined || r === null ? null : r;
}
