// @ts-check
// Text measuring and drawing (B:ptext.py, Pango there). Text is laid out here, line by line, and
// drawn with fillText. PORTING.md 7.3.
//
// Wrapping is "word, then character" (Pango's WRAP_WORD_CHAR): break between words, and inside
// a word that is wider than the line. The width of a piece of text comes from `widthOf`, which
// is the canvas by default and a font's metrics when a vector PDF is written with the user's font.

/** @typedef {(text: string, size: number) => number} WidthOf */

/** The 1x1 context everything is measured on. @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null} */
let mctx = null;
let triedCanvas = false;

export const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif';

function measureContext() {
  if (!triedCanvas) {
    triedCanvas = true;
    try {
      if (typeof OffscreenCanvas !== 'undefined') mctx = new OffscreenCanvas(1, 1).getContext('2d');
      else if (typeof document !== 'undefined') mctx = document.createElement('canvas').getContext('2d');
    } catch { mctx = null; }
  }
  return mctx;
}

/** Width of one line of text in the screen font. @type {WidthOf} */
export function canvasWidth(text, size) {
  const c = measureContext();
  if (!c) return [...text].length * size * 0.6;   // the same stand-in B is given by A:tools/compat.py
  c.font = `${size}px ${FONT}`;
  return c.measureText(text).width;
}

/** @param {number} size @returns {number} the height of one line */
export function canvasLineHeight(size) {
  const c = measureContext();
  if (!c) return size * 1.3;
  c.font = `${size}px ${FONT}`;
  const m = c.measureText('Hg');
  return m.fontBoundingBoxAscent !== undefined ? m.fontBoundingBoxAscent + m.fontBoundingBoxDescent : size * 1.3;
}

/** @param {number} size */
function canvasAscent(size) {
  const c = measureContext();
  if (!c) return size;
  c.font = `${size}px ${FONT}`;
  const m = c.measureText('Hg');
  return m.fontBoundingBoxAscent !== undefined ? m.fontBoundingBoxAscent : size * 0.95;
}

/** Tests install a stand-in (see tests); null goes back to the canvas.
 * @param {{width: WidthOf, lineHeight: (size: number) => number, ascent: (size: number) => number} | null} m */
export function setMetrics(m) { metrics = m; }
/** @type {{width: WidthOf, lineHeight: (size: number) => number, ascent: (size: number) => number} | null} */
let metrics = null;

const words = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Pieces of a paragraph that may be broken between. @param {string} text */
function pieces(text) {
  if (words) return [...words.segment(text)].map(s => s.segment);
  // Without Intl.Segmenter: break after spaces and around CJK characters.
  return text.match(/[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+\s*|\s+/g) || [];
}

/** @param {string} text */
function chars(text) {
  return graphemes ? [...graphemes.segment(text)].map(s => s.segment) : [...text];
}

/**
 * Break text into lines no wider than `wrap` (0: only at newlines).
 * @param {string} text @param {number} size @param {number} wrap @param {WidthOf} [widthOf]
 * @returns {string[]}
 */
export function layoutLines(text, size, wrap, widthOf = metrics ? metrics.width : canvasWidth) {
  const out = [];
  for (const para of text.split('\n')) {
    if (wrap <= 0) { out.push(para); continue; }
    let line = '';
    const flush = () => { out.push(line); line = ''; };
    const fits = (/** @type {string} */ s) => widthOf(s.trimEnd(), size) <= wrap;
    for (const piece of pieces(para)) {
      if (fits(line + piece)) { line += piece; continue; }
      if (line.trim() !== '') flush();
      line = '';
      if (fits(piece)) { line = piece; continue; }
      // A word wider than the line: break it between characters.
      for (const ch of chars(piece)) {
        if (!fits(line + ch) && line !== '') flush();
        line += ch;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Width and height of the text laid out with the given wrap width.
 * @param {string} text @param {number} size @param {number} [wrap]
 * @param {{width?: WidthOf, lineHeight?: number}} [custom] a font's own metrics
 * @returns {[number, number]}
 */
export function measure(text, size, wrap = 0.0, custom = {}) {
  const widthOf = custom.width ?? (metrics ? metrics.width : canvasWidth);
  const lh = custom.lineHeight ?? (metrics ? metrics.lineHeight(size) : canvasLineHeight(size));
  const lines = layoutLines(text, size, wrap, widthOf);
  let w = 0;
  for (const l of lines) w = Math.max(w, widthOf(l.trimEnd(), size));
  return [w, lines.length * lh];
}

/**
 * Draw text with its top left corner at (x, y); the context's fillStyle is the colour.
 * (x, y) are already relative to the drawing origin (see render.js: the origin is subtracted
 * in JS, never in the context's matrix).
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 */
export function show(ctx, x, y, text, size, wrap = 0.0) {
  const lines = layoutLines(text, size, wrap);
  const lh = metrics ? metrics.lineHeight(size) : canvasLineHeight(size);
  const ascent = metrics ? metrics.ascent(size) : canvasAscent(size);
  ctx.font = `${size}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  lines.forEach((l, i) => { if (l) ctx.fillText(l, x, y + ascent + i * lh); });
}
