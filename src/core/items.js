// @ts-check
// The four kinds of things on a page: strokes, shapes, text boxes and pictures.
// Translated from B:model.py (drawing is added in M3). Units are PDF points. Colours are
// [r, g, b] arrays of 0..1 floats. Points are [x, y, pressure].
import * as geom from './geom.js';
import * as ptext from './ptext.js';
import { packPoints, unpackPoints, pyRound } from './pack.js';
import { hexId } from './uuid.js';

export const HL_ALPHA = 0.4;
export const TAU = 2 * Math.PI;

/** Ten items of 16 hex digits is plenty; documents get all 32 (see document.js). */
export function newId() {
  return hexId().slice(0, 16);
}

/** An item's permanent id, given on first use. Syncing merges two versions of a page by
 * these ids, so an item keeps its id for as long as it is the same object. */
export function itemId(it) {
  if (!it.id) it.id = newId();
  return it.id;
}

/** round(v, 2) as the files want it. */
export function round2(v) { return pyRound(v * 100) / 100; }

/** Rotate a point with its w x h page by k quarter turns clockwise. */
export function rotPt(k, w, h, x, y) {
  if (k === 1) return [h - y, x];
  if (k === 2) return [w - x, h - y];
  if (k === 3) return [y, w - x];
  return [x, y];
}

export function rotBox(k, w, h, box) {
  const [ax, ay] = rotPt(k, w, h, box[0], box[1]);
  const [bx, by] = rotPt(k, w, h, box[2], box[3]);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/** Split a polyline into the 'pen down' runs of a dash pattern (on == 0 gives dots). */
export function dashRuns(pts, on, off) {
  const runs = [];
  let run = [pts[0]];
  let drawing = true, left = on;
  let a = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let pos = 0.0;
    while (seg - pos > left) {
      pos += left;
      const t = pos / seg;
      const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (drawing) {
        run.push(q);
        runs.push(run);
        run = [];
      } else {
        run = [q];
      }
      drawing = !drawing;
      left = drawing ? on : off;
    }
    left -= seg - pos;
    if (drawing) run.push(b);
    a = b;
  }
  if (drawing && run.length) runs.push(run);
  return runs;
}

/** What a saved picture is called when it is written: the file keeps one copy of each. */
export class SaveCtx {
  constructor() {
    /** @type {Blob[]} */
    this.images = [];
    /** @type {Map<Blob, number>} */
    this.seen = new Map();
  }
  /** @param {Blob} data */
  image(data) {
    let n = this.seen.get(data);
    if (n === undefined) {
      n = this.images.length;
      this.seen.set(data, n);
      this.images.push(data);
    }
    return n;
  }
}

export class Stroke {
  /**
   * @param {string} tool 'ball' | 'fountain' | 'brush' | 'hl' | 'tape'
   * @param {number[]} color
   * @param {number} width
   * @param {number[][]} [pts]
   * @param {number} [sens]  pressure sensitivity, 1.0 is the default response
   * @param {number} [dash]  0 solid, 1 dashed, 2 dotted
   */
  constructor(tool, color, width, pts = [], sens = 1.0, dash = 0) {
    this.kind = 's';
    this.tool = tool;
    this.open = false;     // a tape that has been lifted: it shows what it covers
    this.color = color;
    this.width = width;
    this.sens = sens;
    this.dash = dash;
    this.pts = pts;        // [[x, y, pressure]]
    /** @type {number[]} */
    this.bbox = [0, 0, 0, 0];
    /** @type {string|undefined} */
    this.id = undefined;
    if (this.pts.length) this.updateBbox();
  }

  wAt(p) {
    if (this.tool === 'fountain') return this.width * Math.max(0.15, 1 + this.sens * 1.2 * (p - 0.5));
    if (this.tool === 'brush') return this.width * Math.max(0.12, 1.4 + this.sens * 2.2 * (p - 0.5));
    return this.width;
  }

  pad() { return this.wAt(1.0) / 2 + 1; }

  updateBbox() { this.bbox = geom.bboxOf(this.pts, this.pad()); }

  polyline() { return this.pts; }
  sample() { return geom.decimate(this.pts, 40); }
  hit(x, y, r) { return geom.polylineHit(this.pts, x, y, r + this.width / 2); }

  transformed(s, ox, oy, dx, dy) {
    const pts = this.pts.map(([x, y, p]) => [ox + (x - ox) * s + dx, oy + (y - oy) * s + dy, p]);
    const n = new Stroke(this.tool, this.color, this.width * s, pts, this.sens, this.dash);
    n.open = this.open;
    return n;
  }

  rotated(k, w, h) {
    return new Stroke(this.tool, this.color, this.width,
      this.pts.map(([x, y, p]) => [...rotPt(k, w, h, x, y), p]), this.sens, this.dash);
  }

  toData(_ctx) {
    const d = { k: 's', t: this.tool, c: [...this.color], w: this.width, ps: this.sens, d: this.dash, q: packPoints(this.pts) };
    if (this.open) d.o = true;
    return d;
  }

  static fromData(d, _ctx) {
    let pts;
    if ('q' in d) pts = unpackPoints(d.q);
    else {   // files from before version 3 list the numbers
      pts = [];
      for (let i = 0; i < d.p.length; i += 3) pts.push([d.p[i], d.p[i + 1], d.p[i + 2]]);
    }
    const stroke = new Stroke(d.t, [...d.c], d.w, pts, d.ps ?? 1.0, d.d ?? 0);
    stroke.open = !!d.o;
    return stroke;
  }
}
/** Set by ink_on() for the page about to be drawn: highlighters do not multiply on dark paper. */
Stroke.onDark = false;

export class Shape {
  /** @param {string} shape 'line' | 'arrow' | 'rect' | 'ellipse' */
  constructor(shape, x0, y0, x1, y1, color, width) {
    this.kind = 'h';
    this.shape = shape;
    this.x0 = x0; this.y0 = y0; this.x1 = x1; this.y1 = y1;
    this.color = color;
    this.width = width;
    /** @type {number[]} */
    this.bbox = [0, 0, 0, 0];
    /** @type {string|undefined} */
    this.id = undefined;
    this.updateBbox();
  }

  updateBbox() {
    const pad = this.width / 2 + (this.shape === 'arrow' ? Math.max(8.0, this.width * 4) : 1);
    this.bbox = [Math.min(this.x0, this.x1) - pad, Math.min(this.y0, this.y1) - pad,
      Math.max(this.x0, this.x1) + pad, Math.max(this.y0, this.y1) + pad];
  }

  polyline() {
    const { x0, y0, x1, y1 } = this;
    if (this.shape === 'ellipse') {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
      const out = [];
      for (let i = 0; i <= 40; i++) out.push([cx + rx * Math.cos(TAU * i / 40), cy + ry * Math.sin(TAU * i / 40)]);
      return out;
    }
    const corners = this.shape === 'rect' ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] : [[x0, y0], [x1, y1]];
    const out = [];
    for (let k = 0; k + 1 < corners.length; k++) {
      const a = corners[k], b = corners[k + 1];
      for (let i = 0; i < 10; i++) out.push([a[0] + (b[0] - a[0]) * i / 10, a[1] + (b[1] - a[1]) * i / 10]);
    }
    out.push(corners[corners.length - 1]);
    return out;
  }

  sample() { return this.polyline(); }
  hit(x, y, r) { return geom.polylineHit(this.polyline(), x, y, r + this.width / 2); }

  transformed(s, ox, oy, dx, dy) {
    return new Shape(this.shape, ox + (this.x0 - ox) * s + dx, oy + (this.y0 - oy) * s + dy,
      ox + (this.x1 - ox) * s + dx, oy + (this.y1 - oy) * s + dy, this.color, this.width * s);
  }

  rotated(k, w, h) {
    return new Shape(this.shape, ...rotPt(k, w, h, this.x0, this.y0), ...rotPt(k, w, h, this.x1, this.y1),
      this.color, this.width);
  }

  toData(_ctx) {
    return { k: 'h', t: this.shape, c: [...this.color], w: this.width, r: [this.x0, this.y0, this.x1, this.y1].map(round2) };
  }

  static fromData(d, _ctx) {
    return new Shape(d.t, d.r[0], d.r[1], d.r[2], d.r[3], [...d.c], d.w);
  }
}

/** Shared behaviour of rectangular items (text, images). */
class Box_ {
  polyline() {
    const [x0, y0, x1, y1] = this.bbox;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  }
  sample() {
    const [x0, y0, x1, y1] = this.bbox;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]];
  }
  hit() { return false; }
}

export class Text extends Box_ {
  /** @param {number[]|null} [bg] a sticky note: the text sits on a coloured slip of this colour */
  constructor(x, y, text, size, color, wrap = 0.0, bg = null) {
    super();
    this.kind = 't';
    this.x = x; this.y = y; this.text = text; this.size = size; this.color = color; this.wrap = wrap;
    this.bg = bg;
    /** @type {number[]} */
    this.bbox = [0, 0, 0, 0];
    /** @type {string|undefined} */
    this.id = undefined;
    this.updateBbox();
  }

  updateBbox() {
    let [w, h] = ptext.measure(this.text, this.size, this.wrap);
    const pad = this.bg ? this.size * 0.7 : 2;
    if (this.bg && this.wrap) w = Math.max(w, this.wrap);   // a note keeps its width however little is written on it
    this.bbox = [this.x - pad, this.y - pad, this.x + w + pad, this.y + h + pad];
  }

  transformed(s, ox, oy, dx, dy) {
    return new Text(ox + (this.x - ox) * s + dx, oy + (this.y - oy) * s + dy,
      this.text, this.size * s, this.color, this.wrap * s, this.bg);
  }

  rotated(k, w, h) {
    const box = rotBox(k, w, h, this.bbox);
    const pad = this.x - this.bbox[0];
    return new Text(box[0] + pad, box[1] + pad, this.text, this.size, this.color, this.wrap, this.bg);
  }

  toData(_ctx) {
    const d = { k: 't', x: round2(this.x), y: round2(this.y), s: this.text, z: this.size, c: [...this.color], wr: this.wrap };
    if (this.bg) d.bg = [...this.bg];
    return d;
  }

  static fromData(d, _ctx) {
    return new Text(d.x, d.y, d.s, d.z, [...d.c], d.wr ?? 0.0, d.bg && d.bg.length ? [...d.bg] : null);
  }
}

/** Turns picture data a quarter turn k times; installed by platform/image.js (it needs a canvas).
 * @type {((data: Blob, k: number) => Promise<Blob>) | null} */
let imageRotator = null;
/** @param {typeof imageRotator} fn */
export function setImageRotator(fn) { imageRotator = fn; }

export class Image extends Box_ {
  /**
   * @param {Blob} data PNG bytes. Identity matters: a file keeps one copy of each Blob.
   * @param {ImageBitmap|null} [bitmap] the decoded picture, once there is one
   */
  constructor(x, y, w, h, data, bitmap = null) {
    super();
    this.kind = 'i';
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.data = data;
    this.bitmap = bitmap;
    /** @type {number[]} */
    this.bbox = [0, 0, 0, 0];
    /** @type {string|undefined} */
    this.id = undefined;
    /** @type {Map<number, Blob>|undefined} */
    this.turned = undefined;
    this.updateBbox();
  }

  updateBbox() { this.bbox = [this.x, this.y, this.x + this.w, this.y + this.h]; }

  transformed(s, ox, oy, dx, dy) {
    return new Image(ox + (this.x - ox) * s + dx, oy + (this.y - oy) * s + dy, this.w * s, this.h * s, this.data, this.bitmap);
  }

  /** Re-encoding the picture is asynchronous, so a rotation is prepared first and then done
   * in one synchronous step (see `prepareRotation`). */
  async prepareRotation(k) {
    if (k % 4 === 0) return;
    if (!imageRotator) throw new Error('no image rotator installed');
    this.turned ??= new Map();
    if (!this.turned.has(k)) this.turned.set(k, await imageRotator(this.data, k));
  }

  rotated(k, w, h) {
    k %= 4;
    const box = rotBox(k, w, h, this.bbox);
    const data = k === 0 ? this.data : this.turned?.get(k);
    if (!data) throw new Error('rotation not prepared');
    return new Image(box[0], box[1], box[2] - box[0], box[3] - box[1], data);
  }

  toData(ctx) {
    return { k: 'i', r: [this.x, this.y, this.w, this.h].map(round2), img: ctx.image(this.data) };
  }

  static fromData(d, ctx) {
    return new Image(d.r[0], d.r[1], d.r[2], d.r[3], ctx.images[d.img]);
  }
}

export const KINDS = { s: Stroke, h: Shape, t: Text, i: Image };

/** Rotating a page or a selection turns its pictures too; this makes them ready.
 * @param {{kind: string, prepareRotation?: (k: number) => Promise<void>}[]} items */
export async function prepareRotation(items, k) {
  for (const it of items) if (it.kind === 'i') await /** @type {Image} */ (it).prepareRotation(k);
}
