// @ts-check
// The one helper the interface is built with: h(tag, props, ...children). No framework, no
// virtual DOM; a part of the screen that changes is rebuilt (see B's _rebuild_options).

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @typedef {Node|string|number|null|undefined|false|DocumentFragment|Array<any>} Child */

/**
 * @param {string} tag
 * @param {Record<string, any>|null} [props] className/class, style (object or string), dataset, on* handlers,
 *   `ref` (called with the element), and attributes; a boolean attribute is set or left off
 * @param {...Child} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, children);
  return el;
}

/** Like h, for SVG elements. @param {string} tag @param {Record<string, any>|null} [props] @param {...Child} children @returns {SVGElement} */
export function s(tag, props, ...children) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  apply(el, props);
  append(el, children);
  return el;
}

/** @param {Element} el @param {Record<string, any>|null|undefined} props */
function apply(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class' || k === 'className') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v));
    else if (k === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else for (const [p, val] of Object.entries(v)) /** @type {HTMLElement} */ (el).style.setProperty(p.startsWith('--') ? p : p.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), String(val));
    } else if (k === 'dataset') Object.assign(/** @type {HTMLElement} */ (el).dataset, v);
    else if (k === 'ref') v(el);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' && 'disabled' in el || k === 'indeterminate') /** @type {any} */ (el)[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

/** @param {Node} el @param {Child[]} children */
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(document.createTextNode(String(c)));
  }
}

/** Replace what is inside an element. @param {Element} el @param {...Child} children */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Remove an element's children. @param {Element} el */
export function clear(el) { el.replaceChildren(); return el; }

/** @param {string} sel @param {ParentNode} [root] */
export function $(sel, root = document) { return /** @type {HTMLElement|null} */ (root.querySelector(sel)); }
