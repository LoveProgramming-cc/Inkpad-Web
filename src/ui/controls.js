// @ts-check
// Small controls the settings and the dialogs are made of.
import { h, icon } from './ui.js';
import { menuPopover } from './popover.js';

/** @param {string} name @param {{title?: string, onClick?: (e: MouseEvent) => void, class?: string, pressed?: boolean, size?: number}} [o] */
export function iconButton(name, { title = '', onClick, class: cls = '', pressed, size = 20 } = {}) {
  return h('button', { class: ['icon-btn', cls], title, 'aria-label': title, 'aria-pressed': pressed === undefined ? undefined : String(pressed), onClick }, icon(name, size));
}

/** A switch. @param {boolean} on @param {(on: boolean) => void} [onChange] */
export function switchEl(on, onChange) {
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', role: 'switch', checked: on,
    onChange: () => onChange?.(input.checked) }));
  return h('label', { class: 'switch' }, input, h('i'));
}

/** Buttons of which one is pressed. @template T @param {{label: string|Node, value: T, title?: string}[]} options @param {T} value @param {(v: T) => void} onChange */
export function segmented(options, value, onChange) {
  const box = h('div', { class: 'segmented', role: 'group' });
  const draw = (/** @type {T} */ v) => {
    box.replaceChildren(...options.map(o => h('button', { 'aria-pressed': String(o.value === v), title: o.title, onClick: () => { draw(o.value); onChange(o.value); } }, o.label)));
  };
  draw(value);
  return box;
}

/** A slider. @param {{min: number, max: number, step?: number, value: number, onInput?: (v: number) => void, onChange?: (v: number) => void}} o */
export function slider({ min, max, step = 1, value, onInput, onChange }) {
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'range', min, max, step, value,
    onInput: () => onInput?.(Number(input.value)), onChange: () => onChange?.(Number(input.value)) }));
  return input;
}

/** The two small arrows of a drop-down. */
function updown() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ class: 'updown', width: 9, height: 14, viewBox: '0 0 9 14', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M1.5 5 4.5 2 7.5 5M1.5 9 4.5 12 7.5 9');
  svg.append(path);
  return svg;
}

/** A drop-down list. @template T @param {{label: string, value: T}[]} options @param {T} value @param {(v: T) => void} onChange */
export function select(options, value, onChange) {
  // A button and a menu of our own rather than <select>: the system's list looks different on every platform.
  let index = Math.max(0, options.findIndex(o => o.value === value));
  const label = h('span', null, options[index].label);
  const el = h('button', { class: 'dropdown', 'aria-haspopup': 'listbox', onClick: () => {
    menuPopover(el, options.map((o, i) => ({ label: o.label, checked: i === index, fn: () => { if (i !== index) { set(i); onChange(o.value); } } })), { align: 'end' });
  } }, label, updown());
  const set = (/** @type {number} */ i) => { index = i; label.textContent = options[i].label; };
  // What callers read and set on a <select>.
  Object.defineProperty(el, 'selectedIndex', { get: () => index, set });
  return el;
}

/** A titled group of rows (Adw.PreferencesGroup). @param {string|null} title @param {string|null} desc @param {...any} rows */
export function group(title, desc, ...rows) {
  return h('section', { class: 'group' }, title && h('h3', null, title), desc && h('p', { class: 'desc' }, desc), h('div', { class: 'rows' }, rows));
}

/** A row with a title, a subtitle and a control on the right (Adw.ActionRow). @param {string} title @param {string|null} subtitle @param {...any} controls */
export function actionRow(title, subtitle, ...controls) {
  return h('div', { class: 'arow' }, h('div', { class: 't' }, h('b', null, title), subtitle && h('small', null, subtitle)), controls);
}

/** @param {string} title @param {string|null} subtitle @param {boolean} on @param {(on: boolean) => void} onChange */
export function switchRow(title, subtitle, on, onChange) {
  return actionRow(title, subtitle, switchEl(on, onChange));
}

/** A row that opens to show more (Adw.ExpanderRow). @param {string} title @param {string|null} subtitle @param {...any} rows */
export function expanderRow(title, subtitle, ...rows) {
  return h('details', { class: 'arow-x' }, h('summary', null, h('div', { class: 't' }, h('b', null, title), subtitle && h('small', null, subtitle))), rows);
}
