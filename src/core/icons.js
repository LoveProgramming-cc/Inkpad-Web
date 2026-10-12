// @ts-check
// Icons as inline SVG, so they take the text colour. The paths are Lucide's (ISC licence),
// from A:Resources/icons.json; the small drawn ones (pen widths, swatches...) are B:icons.py.
import data from '../data/icons.js';

const NS = 'http://www.w3.org/2000/svg';

/** @param {string} tag @param {Record<string, string|number>} attrs @param {Node[]} [kids] */
function el(tag, attrs, kids = []) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

/** One element of an icon: a path string, ['rect', x, y, w, h, r] or ['circle', cx, cy, r]. @param {string|any[]} e */
function part(e) {
  if (typeof e === 'string') return el('path', { d: e });
  if (e[0] === 'rect') return el('rect', { x: e[1], y: e[2], width: e[3], height: e[4], rx: e[5] ?? 0 });
  return el('circle', { cx: e[1], cy: e[2], r: e[3] });
}

/** @param {number} size @param {string} viewBox @param {Record<string, string|number>} [attrs] */
function svgRoot(size, viewBox, attrs = {}) {
  return el('svg', { class: 'icon', width: size, height: size, viewBox, 'aria-hidden': 'true', ...attrs });
}

export const ICON_NAMES = Object.keys(data.icons);
export const GLYPH_NAMES = Object.keys(data.glyphs);

/** A toolbar icon by name. @param {string} name @param {number} [size] @returns {SVGElement} */
export function icon(name, size = 20) {
  const d = /** @type {any} */ (data.icons)[name];
  if (!d) throw new Error('no icon ' + name);
  const svg = svgRoot(size, '0 0 24 24', { fill: d.fill ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const e of d.els) svg.append(part(e));
  return svg;
}

/** A folder's decoration (one of the 24 glyphs). @param {string} name @param {number} [size] @param {number} [width] */
export function glyph(name, size = 20, width = 2) {
  const els = /** @type {any} */ (data.glyphs)[name];
  const svg = svgRoot(size, '0 0 24 24', { fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const e of els || []) svg.append(part(e));
  return svg;
}

// -- drawn on a 20 x 20 grid (B:icons.py) --------------------------------------------

/** @param {Record<string, string|number>} [attrs] */
function drawn(size, attrs = {}) {
  return svgRoot(size, '0 0 20 20', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs });
}

/** A line of the given thickness (the width presets). @param {number} width @param {number} [size] */
export function weightIcon(width, size = 20) {
  const svg = drawn(size);
  svg.append(el('line', { x1: 4, y1: 10, x2: 16, y2: 10, 'stroke-width': width }));
  return svg;
}

/** A circle of the given radius. @param {number} r @param {number} [size] */
export function dotIcon(r, size = 20) {
  const svg = drawn(size);
  svg.append(el('circle', { cx: 10, cy: 10, r }));
  return svg;
}

/** A capital A at a scale (text sizes). @param {number} scale @param {number} [size] */
export function letterIcon(scale, size = 20) {
  const svg = drawn(size);
  svg.append(el('path', { d: 'M-5 6 L0 -6 L5 6 M-3.2 2 L3.2 2', transform: `translate(10 10.5) scale(${scale})`, 'stroke-width': 1.5 / scale }));
  return svg;
}

/** Solid, dashed or dotted. @param {0|1|2} dash @param {number} [size] */
export function lineStyleIcon(dash, size = 20) {
  const svg = drawn(size, { 'stroke-width': 1.8 });
  const attrs = { x1: 2.5, y1: 10, x2: 17.5, y2: 10 };
  svg.append(el('line', dash === 1 ? { ...attrs, 'stroke-dasharray': '4 3.2' } : dash === 2 ? { ...attrs, 'stroke-dasharray': '0.01 3.6' } : attrs));
  return svg;
}

/** A colour chip, optionally with the small arrow that marks the active colour. @param {number[]} color @param {boolean} [chevron] @param {number} [size] */
export function swatchIcon(color, chevron = false, size = 20) {
  const [r, g, b] = color.map(c => Math.round(c * 255));
  const svg = drawn(size, { fill: 'none', stroke: 'none' });
  svg.append(el('circle', { cx: 10, cy: 10, r: 8, fill: `rgb(${r},${g},${b})`, stroke: 'rgba(0,0,0,0.16)', 'stroke-width': 1 }));
  if (chevron) {
    const dark = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2] < 0.6;
    svg.append(el('path', { d: 'M7 9 L10 12 L13 9', fill: 'none', stroke: dark ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.6)', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  return svg;
}

/** The colour wheel of the palette button. @param {number} [size] */
export function wheelIcon(size = 20) {
  const svg = drawn(size, { fill: 'none', stroke: 'none' });
  for (let i = 0; i < 24; i++) {
    const a0 = i * 2 * Math.PI / 24, a1 = (i + 1.3) * 2 * Math.PI / 24;
    const p = (/** @type {number} */ a) => `${(10 + 8 * Math.cos(a)).toFixed(3)} ${(10 + 8 * Math.sin(a)).toFixed(3)}`;
    svg.append(el('path', { d: `M10 10 L${p(a0)} A8 8 0 0 1 ${p(a1)} Z`, fill: hsv(i / 24, 0.9, 1.0) }));
  }
  svg.append(el('circle', { cx: 10, cy: 10, r: 3, fill: '#fff' }));
  return svg;
}

/** The small blue folder. @param {number} [size] */
export function folderIcon(size = 20) {
  const svg = drawn(size, { fill: 'none', stroke: 'none' });
  svg.append(el('path', { d: 'M1.5 15.5 L1.5 4.8 C1.5 4 2 3.5 2.8 3.5 L7.5 3.5 L9.2 5.3 L17.2 5.3 C18 5.3 18.5 5.8 18.5 6.6 L18.5 15.5 Z', fill: 'rgb(51,173,217)' }));
  svg.append(el('rect', { x: 1.5, y: 7, width: 17, height: 10, rx: 1.3, fill: 'rgb(84,214,245)' }));
  return svg;
}

/** @param {number} h 0..1 @param {number} s @param {number} v */
function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}
