// @ts-check
// Colours are [r, g, b] arrays of 0..1 floats. Canvas wants CSS strings; the PDF writer parses
// the same strings back, so the format is fixed: rgba(r,g,b,a) with r, g, b in 0..255.

/** @param {number[]} c @param {number} [a] */
export function css(c, a = 1) {
  return `rgba(${(c[0] * 255).toFixed(2)},${(c[1] * 255).toFixed(2)},${(c[2] * 255).toFixed(2)},${a})`;
}

/** The inverse of `css`: [r, g, b, a] with the first three in 0..1. @param {string} s */
export function parseCss(s) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
  const h = /^#([0-9a-f]{6})$/i.exec(s);
  if (h) {
    const n = parseInt(h[1], 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  throw new Error('unsupported colour ' + s);
}

/** Whether a colour is dark enough that a highlighter should not multiply with it (B:model.ink_on). */
export function isDark(c) {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] < 0.45;
}
