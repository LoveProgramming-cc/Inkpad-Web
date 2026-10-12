// @ts-check
// Popovers (Gtk.Popover): a floating panel placed against an anchor, flipped to the other side
// where there is no room, scrolled where it is taller than the window, closed by a click
// outside or Esc. PORTING.md 5.7.
import { h, icon } from './ui.js';

const GAP = 8, MARGIN = 8;
/** @type {{el: HTMLElement, scrim: HTMLElement, close: () => void}[]} */
const stack = [];

/**
 * @typedef {object} PopoverOptions
 * @property {Element|DOMRect|{x: number, y: number}} anchor what it points at
 * @property {'bottom'|'top'|'auto'} [side] preferred side; 'auto' picks the roomier one
 * @property {'start'|'center'|'end'} [align]
 * @property {boolean} [menu] a menu: tight padding
 * @property {string} [className]
 * @property {() => void} [onClose]
 */

/**
 * @param {Node|((close: () => void) => Node)} content
 * @param {PopoverOptions} o
 * @returns {{el: HTMLElement, close: () => void, place: () => void}}
 */
export function openPopover(content, o) {
  const scrim = h('div', { class: 'scrim' });
  const body = h('div', { class: 'body' });
  const el = h('div', { class: ['popover', o.menu && 'menu', o.className], role: 'dialog' }, body);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.remove();
    el.classList.add('closing');
    setTimeout(() => el.remove(), 140);
    stack.splice(stack.findIndex(p => p.el === el), 1);
    removeEventListener('resize', place);
    o.onClose?.();
  };
  body.append(typeof content === 'function' ? content(close) : content);
  const rectOf = () => {
    const a = o.anchor;
    if (a instanceof Element) return a.getBoundingClientRect();
    if ('width' in a) return /** @type {DOMRect} */ (a);
    return new DOMRect(a.x, a.y, 0, 0);
  };
  function place() {
    const r = rectOf();
    const vw = innerWidth, vh = innerHeight;
    el.style.maxHeight = ''; el.style.maxWidth = `${vw - 2 * MARGIN}px`;
    const w = el.offsetWidth, hgt = el.offsetHeight;
    const below = vh - r.bottom - GAP - MARGIN, above = r.top - GAP - MARGIN;
    let side = o.side ?? 'bottom';
    if (side === 'auto') side = below >= above ? 'bottom' : 'top';
    // Flip when it does not fit on the preferred side but fits on the other.
    if (side === 'bottom' && hgt > below && above > below) side = 'top';
    else if (side === 'top' && hgt > above && below > above) side = 'bottom';
    const room = side === 'bottom' ? below : above;
    const height = Math.min(hgt, Math.max(120, room));     // taller than the room: it scrolls
    el.style.maxHeight = `${height}px`;
    const top = side === 'bottom' ? r.bottom + GAP : r.top - GAP - height;
    const align = o.align ?? 'center';
    let left = align === 'start' ? r.left : align === 'end' ? r.right - w : r.left + r.width / 2 - w / 2;
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(MARGIN, top)}px`;
    // It grows out of what it points at.
    const ox = Math.max(0, Math.min(w, r.left + r.width / 2 - left));
    el.style.transformOrigin = `${ox}px ${side === 'bottom' ? 0 : height}px`;
  }
  scrim.addEventListener('pointerdown', e => { e.preventDefault(); close(); });
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  const host = (o.anchor instanceof Element && o.anchor.closest('dialog[open]')) || document.body;
  host.append(scrim, el);
  stack.push({ el, scrim, close });
  addEventListener('resize', place);
  place();
  // Content that changes size (a panel that refreshes) can ask for a new placement.
  el.focus?.();
  return { el, close, place };
}

/** Close every popover that is open. */
export function closeAllPopovers() {
  for (const p of [...stack].reverse()) p.close();
}

/** Esc closes the topmost one wherever the focus is. */
addEventListener('keydown', e => {
  if (e.key === 'Escape' && stack.length) { stack[stack.length - 1].close(); e.preventDefault(); }
}, true);

/**
 * A popover listing rows: {label, fn, danger, icon}; null adds a separator.
 * @param {Element|DOMRect} anchor
 * @param {(null | {label: string, fn: () => void, danger?: boolean, icon?: string, disabled?: boolean, checked?: boolean})[]} rows
 * @param {Partial<PopoverOptions>} [o]
 */
export function menuPopover(anchor, rows, o = {}) {
  return openPopover(close => h('div', { class: 'col', style: { gap: 0, minWidth: '180px' } },
    rows.map(r => r === null
      ? h('div', { class: 'sep' })
      : h('button', { class: ['menu-row', r.danger && 'danger'], disabled: r.disabled, onClick: () => { close(); r.fn(); } },
        r.icon && icon(r.icon), h('span', { class: 'grow' }, r.label), r.checked !== undefined && h('i', { class: ['tick', r.checked && 'on'] })))),
  { anchor, menu: true, side: 'bottom', align: 'start', ...o });
}
