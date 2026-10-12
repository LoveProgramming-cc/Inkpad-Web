// @ts-check
// A Canvas 2D look-alike that writes PDF content-stream operators, so that the drawing code of
// draw.js / render.js is used unchanged to write a vector PDF (PORTING.md 7.5).
//
// Coordinates arrive in page points, y down; the page begins with a flip so that PDF's y-up space
// is hidden. Only the subset of the Canvas API that draw.js and ptext.js use is here.
import { parseCss } from '../core/color.js';

/** @param {number} n */
const num = n => (Number.isFinite(n) ? String(Math.round(n * 1e4) / 1e4) : '0');

/**
 * @typedef {object} PdfDocLike what the context needs from pdf-lib
 * @property {(spec: {ca: number, blend: string}) => string} gstate  name of the ExtGState for an alpha and blend mode
 * @property {(png: Blob) => string} image                           name of the XObject of a picture
 * @property {(font: any) => string} fontName
 */

export class PdfCtx {
  /** @param {PdfDocLike} res @param {{pdfFont?: any, onMissing?: (chars: string[]) => void}} [o] */
  constructor(res, { pdfFont = null, onMissing } = {}) {
    this.res = res;
    this.pdfFont = pdfFont;
    this.onMissing = onMissing;
    /** @type {string[]} */ this.out = [];
    /** @type {string[]} */ this.path = [];
    this.cx = 0; this.cy = 0; this.hasPoint = false;
    // the canvas state that can be set between drawing calls
    this.strokeStyle = 'rgba(0,0,0,1)';
    this.fillStyle = 'rgba(0,0,0,1)';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.globalCompositeOperation = 'source-over';
    this.globalAlpha = 1;
    this.font_ = '10px sans-serif';
    this.textBaseline = 'alphabetic';
    this.textAlign = 'left';
    /** @type {any[]} */ this.stack = [];
    this.sent = this._fresh();   // what the stream has been told so far at this q level
  }

  _fresh() { return { stroke: null, fill: null, width: null, cap: null, join: null, gs: null }; }

  // CanvasRenderingContext2D.font is a string with the size in it; ptext.show sets it.
  get font_size() { return Number.parseFloat(this.font_); }
  set font(v) { this.font_ = v; }
  get font() { return this.font_; }

  // -- state ----------------------------------------------------------------------------------

  save() {
    this.out.push('q');
    this.stack.push({ s: { ...this.sent }, st: [this.strokeStyle, this.fillStyle, this.lineWidth, this.lineCap, this.lineJoin, this.globalCompositeOperation, this.globalAlpha] });
  }

  restore() {
    const top = this.stack.pop();
    if (!top) return;
    this.out.push('Q');
    this.sent = top.s;
    [this.strokeStyle, this.fillStyle, this.lineWidth, this.lineCap, this.lineJoin, this.globalCompositeOperation, this.globalAlpha] = top.st;
  }

  /** @param {number} a @param {number} b @param {number} c @param {number} d @param {number} e @param {number} f */
  transform(a, b, c, d, e, f) { this.out.push(`${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} cm`); }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
  setTransform(a, b, c, d, e, f) { throw new Error('setTransform is not available while writing a PDF'); }

  /** The state operators for a painting operation: colour, width, ends, joins and transparency. @param {'stroke'|'fill'} kind */
  _state(kind) {
    const ops = [];
    const style = kind === 'stroke' ? this.strokeStyle : this.fillStyle;
    const [r, g, b, a] = parseCss(style);
    const alpha = Math.round(a * this.globalAlpha * 1e4) / 1e4;
    const colorKey = `${num(r)} ${num(g)} ${num(b)}`;
    if (this.sent[kind] !== colorKey) { ops.push(`${colorKey} ${kind === 'stroke' ? 'RG' : 'rg'}`); this.sent[kind] = colorKey; }
    const blend = this.globalCompositeOperation === 'multiply' ? 'Multiply' : 'Normal';
    const gsKey = `${alpha}|${blend}`;
    if (this.sent.gs !== gsKey) { ops.push(`/${this.res.gstate({ ca: alpha, blend })} gs`); this.sent.gs = gsKey; }
    if (kind === 'stroke') {
      if (this.sent.width !== this.lineWidth) { ops.push(`${num(this.lineWidth)} w`); this.sent.width = this.lineWidth; }
      if (this.sent.cap !== this.lineCap) { ops.push(`${this.lineCap === 'round' ? 1 : this.lineCap === 'square' ? 2 : 0} J`); this.sent.cap = this.lineCap; }
      if (this.sent.join !== this.lineJoin) { ops.push(`${this.lineJoin === 'round' ? 1 : this.lineJoin === 'bevel' ? 2 : 0} j`); this.sent.join = this.lineJoin; }
    }
    return ops;
  }

  // -- paths --------------------------------------------------------------------------------------

  beginPath() { this.path = []; this.hasPoint = false; }
  moveTo(x, y) { this.path.push(`${num(x)} ${num(y)} m`); this.cx = x; this.cy = y; this.hasPoint = true; }
  lineTo(x, y) {
    if (!this.hasPoint) { this.moveTo(x, y); return; }
    this.path.push(`${num(x)} ${num(y)} l`); this.cx = x; this.cy = y;
  }
  bezierCurveTo(x1, y1, x2, y2, x, y) { this.path.push(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)} c`); this.cx = x; this.cy = y; this.hasPoint = true; }
  quadraticCurveTo(cx, cy, x, y) {
    const x0 = this.cx, y0 = this.cy;
    this.bezierCurveTo(x0 + (cx - x0) * 2 / 3, y0 + (cy - y0) * 2 / 3, x + (cx - x) * 2 / 3, y + (cy - y) * 2 / 3, x, y);
  }
  closePath() { this.path.push('h'); }
  rect(x, y, w, h) { this.path.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`); this.cx = x; this.cy = y; this.hasPoint = true; }

  /** Circular arcs are drawn as Bezier curves, a quarter turn at most per curve. */
  arc(x, y, r, a0, a1, anticlockwise = false) { this.ellipse(x, y, r, r, 0, a0, a1, anticlockwise); }

  ellipse(cx, cy, rx, ry, rot, a0, a1, anticlockwise = false) {
    let sweep = a1 - a0;
    const TAU = 2 * Math.PI;
    if (!anticlockwise) { if (sweep >= TAU) sweep = TAU; else while (sweep < 0) sweep += TAU; }
    else { if (sweep <= -TAU) sweep = -TAU; else while (sweep > 0) sweep -= TAU; }
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const c = Math.cos(rot), s = Math.sin(rot);
    const pt = (/** @type {number} */ a) => { const px = rx * Math.cos(a), py = ry * Math.sin(a); return [cx + px * c - py * s, cy + px * s + py * c]; };
    const dpt = (/** @type {number} */ a) => { const px = -rx * Math.sin(a), py = ry * Math.cos(a); return [px * c - py * s, px * s + py * c]; };
    const [sx, sy] = pt(a0);
    if (this.hasPoint) this.lineTo(sx, sy); else this.moveTo(sx, sy);
    const k = 4 / 3 * Math.tan(step / 4);
    for (let i = 0; i < n; i++) {
      const t0 = a0 + i * step, t1 = t0 + step;
      const [p0x, p0y] = pt(t0), [p1x, p1y] = pt(t1), [d0x, d0y] = dpt(t0), [d1x, d1y] = dpt(t1);
      this.bezierCurveTo(p0x + k * d0x, p0y + k * d0y, p1x - k * d1x, p1y - k * d1y, p1x, p1y);
    }
  }

  stroke() {
    if (!this.path.length) return;
    this.out.push(...this._state('stroke'), ...this.path, 'S');
  }

  fill() {
    if (!this.path.length) return;
    this.out.push(...this._state('fill'), ...this.path, 'f');
  }

  clip() {
    if (this.path.length) this.out.push(...this.path, 'W n');
  }

  fillRect(x, y, w, h) {
    const keep = this.path, keepPoint = this.hasPoint;
    this.beginPath(); this.rect(x, y, w, h); this.fill();
    this.path = keep; this.hasPoint = keepPoint;
  }

  strokeRect(x, y, w, h) {
    const keep = this.path, keepPoint = this.hasPoint;
    this.beginPath(); this.rect(x, y, w, h); this.stroke();
    this.path = keep; this.hasPoint = keepPoint;
  }

  setLineDash() { /* strokes are cut into runs before they get here */ }

  // -- pictures and text ------------------------------------------------------------------------------

  /** A picture: `image.png` (a Blob) is what is embedded. */
  drawImage(image, x, y, w, h) {
    const png = image && image.png;
    if (!png) return;
    this.out.push('q', `${num(w)} 0 0 ${num(-h)} ${num(x)} ${num(y + h)} cm`, `/${this.res.image(png)} Do`, 'Q');
  }

  /** A page of another PDF, as the background (rot quarter turns, in the notebook page's own space).
   * @param {string} name the XObject's name @param {number} ow @param {number} oh the PDF page's own size @param {number} rot */
  drawEmbeddedPage(name, ow, oh, rot) {
    const k = rot % 4;
    const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
    const [tx, ty] = [[0, 0], [oh, 0], [ow, oh], [0, ow]][k];
    this.out.push('q', `${c} ${s} ${-s} ${c} ${tx} ${ty} cm`, `1 0 0 -1 0 ${num(oh)} cm`, `/${name} Do`, 'Q');
  }

  /** Text in the chosen font as real text (selectable, searchable, sharp at any size). */
  fillText(text, x, y) {
    if (!this.pdfFont) return;
    const size = this.font_size;
    const missing = [];
    const set = this.pdfFont._charset ??= new Set(this.pdfFont.getCharacterSet());
    for (const ch of text) if (!set.has(ch.codePointAt(0)) && ch.trim() !== '') missing.push(ch);
    if (missing.length) this.onMissing?.(missing);
    const hex = this.pdfFont.encodeText(text).toString();
    this.out.push('q', ...this._state('fill'), `1 0 0 -1 ${num(x)} ${num(y)} cm`, 'BT', `/${this.res.fontName(this.pdfFont)} ${num(size)} Tf`, `${hex} Tj`, 'ET', 'Q');
  }

  /** @returns {string} the page's content stream */
  stream() { return this.out.join('\n'); }
}
