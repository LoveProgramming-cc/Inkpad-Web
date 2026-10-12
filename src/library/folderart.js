// @ts-check
// A soft two-tone folder in the given colour, with an optional glyph on the front
// (B:library.py `folder_texture`), as an SVG so it is sharp at any scale.
import { s } from '../ui/dom.js';
import { GLYPH_NAMES } from '../core/icons.js';
import data from '../data/icons.js';

let counter = 0;

/** @param {number[]} c @param {number} k */
const shade = (c, k) => c.map(v => Math.min(1, v * k));
const rgb = (/** @type {number[]} */ c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

/** @param {number[]} color @param {string} icon a glyph name, '' for none, or (an earlier version) an emoji */
export function folderArt(color, icon, w = 150, h = 118) {
  const id = 'fg' + (++counter);
  const r = 11, tabW = w * 0.40, tabH = h * 0.13, top = h * 0.20;
  const back = shade(color, 0.84);
  const backPath = `M0 ${h - r} L0 ${r} A${r} ${r} 0 0 1 ${r} 0 L${tabW - 6} 0 C${tabW + 2} 0 ${tabW + 4} ${tabH} ${tabW + 14} ${tabH} L${w - r} ${tabH} `
    + `A${r} ${r} 0 0 1 ${w} ${tabH + r} L${w} ${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} L${r} ${h} A${r} ${r} 0 0 1 0 ${h - r} Z`;
  const frontPath = `M${w - r} ${top} A${r} ${r} 0 0 1 ${w} ${top + r} L${w} ${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} L${r} ${h} A${r} ${r} 0 0 1 0 ${h - r} `
    + `L0 ${top + r} A${r} ${r} 0 0 1 ${r} ${top} Z`;
  const svg = s('svg', { class: 'folder-art', width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' },
    s('defs', null, s('linearGradient', { id, x1: 0, y1: top, x2: 0, y2: h, gradientUnits: 'userSpaceOnUse' },
      s('stop', { offset: 0, 'stop-color': rgb(color.map(c => Math.min(1, c + 0.07))) }), s('stop', { offset: 1, 'stop-color': rgb(color) }))),
    s('path', { d: backPath, fill: rgb(back) }),
    s('path', { d: frontPath, fill: `url(#${id})`, stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 1 }));
  if (GLYPH_NAMES.includes(icon)) {
    const size = h * 0.36;
    const g = s('svg', { x: (w - size) / 2, y: top + (h - top - size) / 2, width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: rgb(color.map(c => c * 0.42), 0.78), 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    for (const e of /** @type {any} */ (data.glyphs)[icon]) {
      g.append(typeof e === 'string' ? s('path', { d: e }) : e[0] === 'rect' ? s('rect', { x: e[1], y: e[2], width: e[3], height: e[4], rx: e[5] ?? 0 }) : s('circle', { cx: e[1], cy: e[2], r: e[3] }));
    }
    svg.append(g);
  } else if (icon) {   // an emoji chosen in an earlier version
    const size = h * 0.30;
    const t = s('text', { x: w / 2, y: top + (h - top) / 2, 'font-size': size, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: 'rgba(0,0,0,0.85)' });
    t.textContent = icon;
    svg.append(t);
  }
  return svg;
}
