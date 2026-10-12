// @ts-check
// Toasts (Adw.ToastOverlay): a bar at the bottom, 3 s, or 5 s with a button ("undo").
import { h } from './ui.js';

/** @type {HTMLElement|null} */
let box = null;

/**
 * @param {string} text
 * @param {{action?: {label: string, fn: () => void}, timeout?: number}} [o]
 * @returns {() => void} dismisses it
 */
export function toast(text, { action, timeout } = {}) {
  if (!box) { box = h('div', { class: 'toasts', 'aria-live': 'polite', popover: 'manual' }); document.body.append(box); }
  let timer = 0;
  const dismiss = () => { clearTimeout(timer); el.classList.add('closing'); setTimeout(() => el.remove(), 180); };
  const el = h('div', { class: 'toast' }, h('span', null, text),
    action && h('button', { onClick: () => { dismiss(); action.fn(); } }, action.label));
  box.append(el);
  // A modal dialog is in the top layer, above any z-index; showing the box again puts it above that.
  const top = /** @type {any} */ (box);
  if (top.showPopover) { try { if (top.matches(':popover-open')) top.hidePopover(); top.showPopover(); } catch { /* stays where it is */ } }
  timer = window.setTimeout(dismiss, (timeout ?? (action ? 5 : 3)) * 1000);
  return dismiss;
}
