// @ts-check
// The scrolling page canvas (B:canvas.py `Canvas`; PORTING.md 7.1).
//
// Performance model: every visible page is rasterised once into a cache canvas and drawn with
// drawImage, so scrolling and zooming only move images around. While writing, only the growing
// tail of the stroke is rasterised per frame; finished ink is painted into the page cache once.
// Edits repaint just the affected rectangle.
//
// This file is the view: layout, scrolling, zoom, the caches and the frame. The tools are in
// tools.js and the pointer handling in input.js; both add their methods to this class.
import { drawItem, drawPaper } from '../core/draw.js';
import { css } from '../core/color.js';
import { intersects, union } from '../core/geom.js';
import { pageBox } from '../core/page.js';
import { inkOn } from '../core/render.js';
import { createCanvas, context2d, release } from '../platform/canvas.js';
import { mono } from '../core/clock.js';
import { tr } from '../core/i18n.js';

export const TOP = 64, GAP = 14, SIDE = 24, BOTTOM = 48;
export const MAX_PIXELS = 12_000_000;   // pages bigger than this on screen are cached as a window around the viewport
export const STRIP = 256;               // windows are aligned to this many pixels, so they need not move at every scroll
export const MIN_ZOOM = 0.2;
export const BOARD_MIN_ZOOM = 0.04;
export const BG_KEEP = 8;               // PDF page backgrounds remembered after they scroll out of view
export const CHUNK = 48;                // live stroke points rasterised per baked chunk
export const LASER_HOLD_MS = 1000;      // a laser trail stays this long after the last stroke
export const LASER_FADE_MS = 350;
export const RULER_W = 46;              // half the ruler's width, in pixels
export const RULER_SNAP = 18;           // how near its edge a stroke has to start to follow it
export const PULL = 280.0;              // how far past the end the pages have to be pulled for a new page
const ACCENT = 'rgb(54,133,227)';
const SHADOW = 'rgba(0,0,0,0.16)';
const RULER_BODY = 'rgba(230,235,242,0.66)';
const RULER_INK = 'rgba(56,64,82,0.9)';
const MARK = 'rgba(255,217,26,0.35)';
const MARK_NOW = 'rgba(255,128,0,0.5)';
/** The most pixels all the page caches together may hold (R9). */
const CACHE_LIMIT = (typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) ? 24_000_000 : 48_000_000;

/**
 * @typedef {object} Entry raster cache of one page: a window (ox, oy, pw, ph) of the page drawn at full x full pixels
 * @property {OffscreenCanvas|HTMLCanvasElement} canvas
 * @property {[number, number]} full @property {number} ox @property {number} oy @property {number} pw @property {number} ph
 * @property {number} sx @property {number} sy @property {any} bg
 */

/** Binary search: the index of the last element that is <= x (B: bisect_right - 1). @param {number[]} arr @param {number} x */
function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x < arr[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

export class PageCanvas {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'canvas';
    this.el.tabIndex = 0;
    this.main = document.createElement('canvas');
    this.over = document.createElement('canvas');
    this.over.className = 'over';
    this.el.append(this.main, this.over);
    this.mctx = /** @type {CanvasRenderingContext2D} */ (this.main.getContext('2d', { alpha: false }));
    this.octx = /** @type {CanvasRenderingContext2D} */ (this.over.getContext('2d', { desynchronized: true }));
    this.W = 0; this.H = 0;
    this.dev = window.devicePixelRatio || 1;

    /** @type {import('../core/document.js').Document|null} */ this.doc = null;
    this.zoom = 1.0;
    this.renderZoom = 1.0;
    this.zoomInit = false;
    this.settle = 0;
    /** @type {number[]} */ this.tops = [];
    this.cw = 0; this.ch = 0;
    /** @type {Map<any, Entry>} */ this.cache = new Map();
    /** @type {Map<any, any>} */ this.pending = new Map();
    /** @type {Map<any, any>} */ this.bgs = new Map();
    this.shown = [0, 0];
    /** @type {any} */ this.op = null;
    /** @type {any} */ this.sel = null;
    /** @type {Set<any>|null} */ this.hidden = null;
    /** @type {any[]} */ this.clip = [];
    this.ptr = [0, 0];
    this.penDown = false;
    this.mouseDown = false;
    this.mouseP = 0.5;
    /** @type {any} */ this.popover = null;
    // Tool configuration, written by the window.
    this.tool = 'pen';
    this.penType = 'fountain';
    this.penColor = [0, 0, 0];
    this.penWidth = 1.6;
    this.hlColor = [1.0, 0.88, 0.3];
    this.hlWidth = 14.0;
    this.eraserR = 9.0;
    this.shapeKind = 'line';
    this.textSize = 18.0;
    this.scribbleErase = true;
    this.scribbleLoose = false;
    this.fingerDraw = false;
    /** @type {((n: number) => void)|null} */ this.onScribble = null;
    this.penSens = 1.0;            // pressure sensitivity factor
    this.penDash = 0;              // 0 solid, 1 dashed, 2 dotted
    /** @type {any} */ this.anim = null;
    this.penStab = 0.0;            // stroke stabilisation, 0..1
    this.holdShape = true;         // hold still at the end of a stroke to snap it to a shape
    this.eraserMode = 'standard';  // 'standard' erases what is touched, 'stroke' whole strokes
    this.eraseFilter = new Set(['pen', 'hl', 'shape']);
    /** @type {(() => void)|null} */ this.onEraseDone = null;
    this.lassoRect = false;
    this.lassoFilter = new Set(['ink', 'image', 'shape', 'text']);
    this.holdTimer = 0;
    this.pressTimer = 0;           // running while something is held still with the select tool
    this.pressAt = [0, 0];
    this.noteColor = [1.0, 0.93, 0.55];
    this.tapeColor = [0.96, 0.82, 0.36]; this.tapeWidth = 16.0;
    this.mouseHand = true;         // once a pen has been used, the mouse moves the page instead of drawing
    this.hasPen = false;
    /** @type {any} */ this.hand = null;
    /** @type {[any, number[]][]} */ this.marks = [];   // search hits: [page, box in page points]
    this.markAt = -1;
    this.showCross = true;         // crosshair pointer; off leaves only a small dot
    this.laserMode = 'trail';      // 'dot' follows the pen, 'trail' leaves a line that fades
    this.laserColor = [1.0, 0.16, 0.2];
    /** @type {[any, number[][]][]} */ this.laserTrails = [];
    /** @type {any} */ this.laserDot = null;
    this.laserTimer = 0;
    this.laserFade = 0;
    this.laserAlpha = 1.0;
    /** @type {any} */ this.ruler = null;   // the ruler on screen: {x, y (centre, pixels), a (radians)}
    this.src = 'pen';              // what is drawing: 'pen', 'mouse' or 'touch'
    this.paging = 'vertical';      // pages run downwards, or 'horizontal': side by side
    /** @type {((d: number) => void)|null} */ this.onPullAdd = null;
    /** @type {number[]} */ this.lefts = [];
    this.laidFor = 0;
    /** @type {any} */ this.memo = null;   // a remembered view waiting for the window to have a size
    this.scrollbars = true;
    this.maxZoom = 6.0;
    /** @type {any} */ this.barDrag = null;
    /** @type {Map<any, number>} */ this.pf = new Map();   // side by side: each page's own scale beside the zoom
    /** @type {number[]} */ this.slots = [];
    this.pull = 0.0;
    this.turning = 0;
    this.turnAt = 0; this.turnSum = 0.0; this.turnedAt = 0; this.turnDone = false;
    this.want = [0.0, 0.0];
    this.board = false;            // showing a whiteboard: one page, no edges, free scrolling
    this.bo = [0.0, 0.0];          // its scroll position in pixels; any value, either sign
    this.bat = 0;                  // which of the document's boards is shown
    /** @type {Map<number, number[]>} */ this.touches = new Map();
    /** @type {Set<number>} */ this.rejected = new Set();
    /** @type {((line: string) => void)|null} */ this.inputLog = null;
    this.tg = null;
    this.fling = 0;
    this.palmMs = 80;              // touches this soon after a pen event are the resting hand
    this.penSeen = -1e9;
    // The scroll position of pages that are laid out (a board uses `bo`).
    this.sx = 0; this.sy = 0;
    this.dirty = false; this.raf = 0;
    /** @type {Record<string, Function[]>} */ this.listeners = {};
    /** @type {any} */ this.bgSource = null;   // renders PDF page backgrounds (pdf queue, M10)
    this.ro = new ResizeObserver(() => this._resized());
    this.ro.observe(this.el);
    this._onDocEvent = this._docEvent.bind(this);
    this.updateCursor();
    /** @type {any} */ this.penId = 0; this.pst = null; this.mouseId = 0; this.mouseLast = [0, 0]; this.pan = null; this.hover = null; this.hoverWanted = false; this.barStart = [0, 0];
    // The tool and input methods are added to the prototype by tools.js and input.js.
    /** @type {any} */ (this).attachInput?.();
  }

  // -- events ----------------------------------------------------------------------

  /** @param {string} name @param {Function} fn */
  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  /** @param {string} name @param {...any} args */
  emit(name, ...args) { for (const fn of this.listeners[name] || []) fn(...args); }

  /** Ask for a new frame. */
  queueDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this._frame(); });
  }

  /** A line in the input log, when that is switched on in the settings. @param {string} text */
  log(text) { if (this.inputLog) this.inputLog(`${(mono() / 1000).toFixed(3)} ${text}`); }

  // -- setup -------------------------------------------------------------------------

  /** @param {import('../core/document.js').Document} doc */
  setDocument(doc) {
    if (this.doc) this.doc.listeners.delete(this._onDocEvent);
    this.doc = doc;
    doc.listeners.add(this._onDocEvent);
    for (const e of this.cache.values()) release(e.canvas);
    this.cache.clear(); this.pending.clear(); this.bgs.clear();
    this.op = this.sel = this.hidden = null;
    this.bat = 0;
    this.laserTrails = []; this.laserDot = null;
    this.marks = []; this.markAt = -1;
    this._relayout();
    this.memo = null;
    if (this.zoomInit) {
      this.zoomInit = false;
      this._initZoom();
      this._home();
    } else if (this.W > 200) {
      this._allocated(this.W, this.H);   // the window already has its size: nothing more will announce it
    }
    this.queueDraw();
    this.emit('view-changed');
  }

  /** Where the view is, in a form that outlasts the window: the zoom and the point of the
   * document in the middle of the window. */
  viewMemo() {
    if (!this.doc || !this.tops.length || !this.zoomInit) return null;
    const [i, fx, fy] = this._anchor(this.W / 2, this.H / 2);
    return [this.zoom, i, fx, fy];
  }

  /** Go back to a place remembered with viewMemo(), now or once there is a window. @param {any} memo */
  restoreMemo(memo) {
    let zoom, i, fx, fy;
    try { [zoom, i, fx, fy] = [Number(memo[0]), Math.trunc(Number(memo[1])), Number(memo[2]), Number(memo[3])]; } catch { return; }
    const doc = /** @type {NonNullable<typeof this.doc>} */ (this.doc);
    if (!(i >= 0 && i < doc.pages.length) || !(zoom > 0) || ![fx, fy].every(Number.isFinite)) return;   // also turns away NaN
    if (!this.zoomInit) { this.memo = memo; return; }
    if (this.board) this.bat = i;
    this._place(Math.max(this._minZoom(), Math.min(this._maxZoom(), zoom)), [i, fx, fy], this.W / 2, this.H / 2);
    this.renderZoom = this.zoom;
    this._rest();
    this.queueDraw();
    this.emit('view-changed');
  }

  /** @param {string} tool */
  setTool(tool) {
    this.tool = tool;
    if (tool !== 'lasso') this.clearSelection();
    if (tool !== 'laser') this.clearLaser();
    this.updateCursor();
  }

  updateCursor() {
    const name = /** @type {Record<string, string>} */ ({ text: 'text', note: 'text', eraser: 'cell' })[this.tool] || 'crosshair';
    if (name === 'crosshair' && !this.showCross) {
      this.el.style.cursor = `url("${dotCursor()}") 8 8, crosshair`;
    } else {
      this.el.style.cursor = name;
    }
  }

  // -- layout and scrolling -------------------------------------------------------------

  _resized() {
    const r = this.el.getBoundingClientRect();
    const W = Math.round(r.width), H = Math.round(r.height);
    const dev = window.devicePixelRatio || 1;
    if (W === this.W && H === this.H && dev === this.dev) return;
    this.dev = dev;
    this.W = W; this.H = H;
    for (const c of [this.main, this.over]) {
      c.width = Math.max(1, Math.round(W * dev)); c.height = Math.max(1, Math.round(H * dev));
      c.style.width = W + 'px'; c.style.height = H + 'px';
    }
    this._allocated(W, H);
    this.queueDraw();
  }

  _allocated(width, height) {
    if (!this.zoomInit && width > 200 && this.doc) {
      this._initZoom();
      this._home();
      if (this.memo !== null) {
        const memo = this.memo;
        this.memo = null;
        this._configureAdj();
        this.restoreMemo(memo);
      }
    }
    if (this._across() && this.doc && this.slots.length && width !== this.laidFor) {
      // The pages are a window apart, so a new width moves them all.
      const i = this.currentPageIndex();
      this._relayout();
      this._configureAdj(this.slots[Math.min(i, this.slots.length - 1)]);
    }
    this._configureAdj();
  }

  _initZoom() {
    this.zoomInit = true;
    if (!this.doc) return;
    // Fitted to the usual page: one odd, huge page must not shrink all the others.
    const [rw, rh] = this._usual();
    let fit = (this.W - 2 * SIDE) / rw;
    if (this.paging === 'horizontal') fit = Math.min(fit, (this.H - TOP - BOTTOM) / rh);   // a whole page at a time
    this.zoom = this.renderZoom = this.doc.pages[0].board ? 1.0 : Math.max(MIN_ZOOM, Math.min(fit, 1.35));
    this._relayout();
    this.emit('view-changed');
  }

  /** The size of the notebook's usual page: the middle one of its widths and heights. */
  _usual() {
    const pages = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages;
    const ws = pages.map(p => p.w).sort((a, b) => a - b), hs = pages.map(p => p.h).sort((a, b) => a - b);
    return [ws[Math.floor(pages.length / 2)], hs[Math.floor(pages.length / 2)]];
  }

  /** The scale a page is shown at. Side by side every page is seen alone, so a page of another
   * size is scaled to fill the same space as the usual one. @param {any} page */
  _z(page) { return this.zoom * (this.pf.get(page) ?? 1.0); }

  shownZoom() {
    if (!this.doc || !this.tops.length) return this.zoom;
    // The layout may be a page behind the document while a change is being announced.
    return this._z(this.doc.pages[Math.min(this.currentPageIndex(), this.doc.pages.length - 1)]);
  }

  /** Initial scroll position: the top, or the content of a whiteboard. */
  _home() {
    if (/** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[0].board) this.centerOn(this.bat);
    else this._configureAdj(0, 0);
  }

  /** Where a page's left edge is in the scrolled content: centred, or a board's origin. @param {any} page */
  _left(page) { return this.board ? 0.0 : (Math.max(this.W, this.cw) - page.w * this.zoom) / 2; }

  /** @param {number} i */
  centerOn(i) {
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    const [x0, y0, x1, y1] = pageBox(page);
    const [left, top] = this._origin(i);
    this._configureAdj(left + (x0 + x1) / 2 * this.zoom - this.W / 2, top + (y0 + y1) / 2 * this.zoom - this.H / 2);
  }

  _relayout() {
    let y = TOP;
    this.tops = [];
    let width = 0.0;
    const doc = this.doc;
    this.board = !!doc && doc.pages[0].board;
    this.pf = new Map();
    if (this.board && doc) {
      // Nothing to lay out: the one board on show starts at the origin and never ends.
      this.bat = Math.min(this.bat, doc.pages.length - 1);
      this.tops = doc.pages.map(() => 0.0);
      this.cw = this.ch = 0.0;
      return;
    }
    if (doc && this.paging === 'horizontal') {
      // One page at a time: each has a slot as wide as the window, wider when zoomed in.
      let x = 0.0;
      this.lefts = []; this.slots = [];
      this.laidFor = this.W;
      let height = 0.0;
      const [rw, rh] = this._usual();
      for (const page of doc.pages) {
        this.pf.set(page, Math.min(rw / page.w, rh / page.h));
        const z = this._z(page);
        const slot = Math.max(this.W, page.w * z + 2 * SIDE);
        this.slots.push(x);
        this.lefts.push(x + (slot - page.w * z) / 2);
        this.tops.push(TOP);
        x += slot;
        height = Math.max(height, page.h * z);
      }
      this.cw = x;
      this.ch = height + TOP + BOTTOM;
      return;
    }
    if (doc) {
      for (const page of doc.pages) {
        this.tops.push(y);
        y += page.h * this.zoom + GAP;
        width = Math.max(width, page.w);
      }
    }
    this.ch = y - GAP + BOTTOM;
    this.cw = width * this.zoom + 2 * SIDE;
  }

  _across() { return this.paging === 'horizontal' && !this.board; }

  /** Where page i's top left corner is in the scrolled content. @param {number} i */
  _origin(i) {
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    if (this._across()) return [this.lefts[i], Math.max(TOP, (Math.max(this.H, this.ch) - page.h * this._z(page)) / 2)];
    return [this._left(page), this.tops[i]];
  }

  /** The page whose row or column holds a point of the scrolled content. @param {number} x @param {number} y */
  _pageAt(x, y) {
    if (this.board) return this.bat;
    if (this._across()) return Math.max(0, bisectRight(this.slots, x) - 1);
    return Math.max(0, bisectRight(this.tops, y) - 1);
  }

  /** @param {string} paging */
  setPaging(paging) {
    if (paging === this.paging) return;
    let i = this.doc && this.tops.length ? this.currentPageIndex() : 0;
    this.paging = paging;
    if (this.doc) {
      this._initZoom();
      this._configureAdj();
      if (!this.board) {
        i = Math.min(i, this.doc.pages.length - 1);
        this._configureAdj(this._across() ? this.slots[i] : 0, this._across() ? 0 : this.tops[i] - TOP);
      }
      this.queueDraw();
    }
  }

  /** The scroll limits (the adjustments of B): [upper, page size] on each axis. */
  _hUpper() { return Math.max(this.cw, this.W); }
  _vUpper() { return Math.max(this.ch, this.H); }

  /** Set the scroll position, kept within what there is to scroll. @param {number} [hval] @param {number} [vval] */
  _configureAdj(hval, vval) {
    if (this.board) {
      const before = [this.bo[0], this.bo[1]];
      if (hval !== undefined) this.bo[0] = hval;
      if (vval !== undefined) this.bo[1] = vval;
      // Only a real move is announced: this also runs on every size allocation.
      if (this.bo[0] !== before[0] || this.bo[1] !== before[1]) { this.queueDraw(); this.emit('view-changed'); }
      return;
    }
    const nx = Math.max(0, Math.min(hval === undefined ? this.sx : hval, this._hUpper() - this.W));
    const ny = Math.max(0, Math.min(vval === undefined ? this.sy : vval, this._vUpper() - this.H));
    const moved = nx !== this.sx || ny !== this.sy;
    this.sx = nx; this.sy = ny;
    if (moved) { this.queueDraw(); this.emit('view-changed'); }
  }

  /** Set one scroll value like Gtk.Adjustment.set_value. @param {'h'|'v'} axis @param {number} v */
  _setAdj(axis, v) { if (axis === 'h') this._configureAdj(v, undefined); else this._configureAdj(undefined, v); }

  _h() { return this.board ? this.bo[0] : this.sx; }
  _v() { return this.board ? this.bo[1] : this.sy; }

  /** @param {number} v */
  _snap(v) { return Math.round(v * this.dev) / this.dev; }

  /** Page rectangle in widget coordinates, aligned to device pixels. @param {number} i @returns {[number, number, number, number]} */
  _pageRect(i) {
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    if (this.board) {
      // Only the origin and the scale matter; the board itself has no rectangle.
      return [this._snap(-this.bo[0]), this._snap(-this.bo[1]), page.w * this.zoom, page.h * this.zoom];
    }
    const w = this._snap(page.w * this._z(page)), h = this._snap(page.h * this._z(page));
    if (this._across()) {
      const [ox, oy] = this._origin(i);
      return [this._snap(ox - this._h()), this._snap(oy - this._v()), w, h];
    }
    const x = (Math.max(this.W, this.cw) - w) / 2 - this._h();
    return [this._snap(x), this._snap(this.tops[i] - this._v()), w, h];
  }

  /** @param {number} i @param {number} x @param {number} y @returns {[number, number]} */
  _toPage(i, x, y) {
    const [px, py, pw, ph] = this._pageRect(i);
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    return [(x - px) * page.w / pw, (y - py) * page.h / ph];
  }

  /** [index, page x, page y] of the page under a widget point, or null. @param {number} x @param {number} y @returns {[number, number, number]|null} */
  _locate(x, y) {
    if (!this.tops.length || !this.doc) return null;
    if (this.board) return [this.bat, ...this._toPage(this.bat, x, y)];
    const i = this._pageAt(x + this._h(), y + this._v());
    const [px, py, pw, ph] = this._pageRect(i);
    if (px <= x && x <= px + pw && py <= y && y <= py + ph) return [i, ...this._toPage(i, x, y)];
    return null;
  }

  /** @param {any} page */
  _index(page) {
    const i = this.doc ? this.doc.pages.indexOf(page) : -1;
    return i < 0 ? null : i;
  }

  currentPageIndex() {
    if (!this.tops.length) return 0;
    if (this.board) return this.bat;
    return this._pageAt(this._h() + this.W / 2, this._v() + this.H / 2);
  }

  /** @param {number} i */
  scrollToPage(i) {
    if (!(i >= 0 && i < this.tops.length)) return;
    if (this.board) { this.bat = i; this.centerOn(i); return; }
    const axis = this._across() ? 'h' : 'v';
    const start = this._across() ? this.slots[i] : this.tops[i] - TOP;
    this.turning = i;
    this._glide(axis, start);
  }

  /** Side by side: the scroll positions between which page i fills the window. They are one and
   * the same when the whole page fits. @param {number} i */
  _span(i) {
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    const lo = this.slots[i];
    return [lo, lo + Math.max(0.0, page.w * this._z(page) + 2 * SIDE - this.W)];
  }

  /** Scroll to a target with the 280 ms ease-out-cubic B uses. @param {'h'|'v'} axis @param {number} target */
  _glide(axis, target) {
    const upper = axis === 'h' ? this._hUpper() - this.W : this._vUpper() - this.H;
    target = Math.max(0.0, Math.min(target, upper));
    if (this.anim) cancelAnimationFrame(this.anim.id);
    const from = axis === 'h' ? this.sx : this.sy;
    const t0 = mono();
    const step = () => {
      const t = Math.min(1, (mono() - t0) / 280);
      const e = 1 - (1 - t) ** 3;
      this._setAdj(axis, from + (target - from) * e);
      if (t < 1) this.anim.id = requestAnimationFrame(step); else this.anim = null;
    };
    this.anim = { id: requestAnimationFrame(step), axis };
  }

  // -- zoom -----------------------------------------------------------------------------

  /** @param {number} zoom @param {number} [ax] @param {number} [ay] */
  setZoom(zoom, ax, ay) {
    zoom = Math.max(this._minZoom(), Math.min(this._maxZoom(), zoom));
    if (!this.doc || Math.abs(zoom - this.zoom) < 1e-4) return;
    if (ax === undefined || ay === undefined) { ax = this.W / 2; ay = this.H / 2; }
    // Keep the page point under the anchor fixed.
    this._place(zoom, this._anchor(ax, ay), ax, ay);
  }

  /** The limit is on what is seen, not on the number: a page that is shown smaller than others to
   * fit beside them may be enlarged by as much more. */
  _maxZoom() {
    if (!this.doc || !this.tops.length || !this.pf.size) return this.maxZoom;
    const page = this.doc.pages[Math.min(this.currentPageIndex(), this.doc.pages.length - 1)];
    return this.maxZoom / (this.pf.get(page) ?? 1.0);
  }

  _minZoom() {
    // A whiteboard can be looked at from much further away than a page.
    return this.doc && this.doc.pages[0].board ? BOARD_MIN_ZOOM : MIN_ZOOM;
  }

  viewState() { return [this.zoom, this._h(), this._v()]; }

  /** Go back to a zoom and scroll position remembered with viewState(). @param {number[]} state */
  restoreView(state) {
    this.zoom = this.renderZoom = state[0];
    this._relayout();
    this._configureAdj(state[1], state[2]);
    this.queueDraw();
    this.emit('view-changed');
  }

  /** Highlight search hits and bring the current one into view. @param {[any, number[]][]} marks @param {number} [at] */
  setMarks(marks, at = -1) {
    this.marks = marks; this.markAt = at;
    if (at >= 0 && at < marks.length) {
      const [page, box] = marks[at];
      const i = this._index(page);
      if (i !== null) this.centerAt(i, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
    }
    this.queueDraw();
  }

  /** The part of the current page that is on screen, in page points (not clamped). */
  viewBox() {
    if (!this.doc || !this.tops.length) return null;
    const i = this.currentPageIndex();
    const [x0, y0] = this._toPage(i, 0, 0);
    const [x1, y1] = this._toPage(i, this.W, this.H);
    return [x0, y0, x1, y1];
  }

  /** Scroll so that a page point is in the middle of the view. @param {number} i @param {number} x @param {number} y */
  centerAt(i, x, y) {
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    this._place(this.zoom, [i, x / page.w, y / page.h], this.W / 2, this.H / 2);
  }

  /** Zoom and scroll so that everything on the current whiteboard is visible. */
  fitContent() {
    const i = this.currentPageIndex();
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    const [x0, y0, x1, y1] = pageBox(page);
    let zoom = Math.min(this.W / (x1 - x0), this.H / (y1 - y0)) * 0.92;
    zoom = Math.max(this._minZoom(), Math.min(1.5, zoom));
    this._place(zoom, [i, (x0 + x1) / 2 / page.w, (y0 + y1) / 2 / page.h], this.W / 2, this.H / 2);
  }

  /** The page point under a widget point, as [index, fraction across, fraction down]. @param {number} x @param {number} y @returns {[number, number, number]} */
  _anchor(x, y) {
    const i = this._pageAt(x + this._h(), y + this._v());
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    const [left, top] = this._origin(i);
    const z = this._z(page);
    return [i, (x - left + this._h()) / (page.w * z), (y - top + this._v()) / (page.h * z)];
  }

  /** Show the document at zoom with the anchored page point under widget point (x, y). @param {number} zoom @param {number[]} anchor @param {number} x @param {number} y */
  _place(zoom, anchor, x, y) {
    const [i, fx, fy] = anchor;
    const doc = /** @type {NonNullable<typeof this.doc>} */ (this.doc);
    if (i >= doc.pages.length) return;
    const page = doc.pages[i];
    const changed = Math.abs(zoom - this.zoom) > 1e-6;
    if (changed) { this.zoom = zoom; this._relayout(); }
    const [left, top] = this._origin(i);
    const z = this._z(page);
    this.want = [left + fx * page.w * z - x, top + fy * page.h * z - y];
    if (this._across()) {
      // One page at a time: zooming about a point near the edge must not bring the next page in beside this one.
      const [lo, hi] = this._span(i);
      this.want[0] = Math.max(lo, Math.min(this.want[0], hi));
    }
    this._configureAdj(this.want[0], this.want[1]);
    if (changed) this._zoomChanged();
  }

  _zoomChanged() {
    clearTimeout(this.settle);
    // Images are stretched while zooming and re-rendered sharp once it settles.
    this.settle = window.setTimeout(() => this._zoomSettled(), 160);
    this.queueDraw();
    this.emit('view-changed');
  }

  _zoomSettled() {
    this.settle = 0;
    this.renderZoom = this.zoom;
    this.queueDraw();
  }

  /** @param {number} factor */
  zoomBy(factor) { this.setZoom(this.zoom * factor); }

  fitWidth() {
    if (this.doc) {
      const page = this.doc.pages[this.currentPageIndex()];
      this.setZoom((this.W - 2 * SIDE) / (page.w * (this.pf.get(page) ?? 1.0)));
    }
  }

  // -- ruler ----------------------------------------------------------------------------

  /** Put the ruler on the screen or take it away. @param {boolean} on */
  setRuler(on) {
    this.ruler = on ? { x: this.W / 2, y: this.H / 2, a: 0.0 } : null;
    this.queueDraw();
  }

  _rulerLen() { return Math.max(260.0, 0.42 * Math.max(this.W, this.H)); }

  /** A widget point as [distance along the ruler, distance across it] from its centre. */
  _rulerLocal(x, y) {
    const r = this.ruler;
    const c = Math.cos(r.a), s = Math.sin(r.a);
    const dx = x - r.x, dy = y - r.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  }

  /** 'edge' near one of the long edges, 'body' on the ruler itself, null elsewhere. @param {number} x @param {number} y */
  _rulerZone(x, y) {
    if (!this.ruler) return null;
    const [u, v] = this._rulerLocal(x, y);
    if (Math.abs(u) > this._rulerLen() + RULER_SNAP) return null;
    if (Math.abs(Math.abs(v) - RULER_W) <= RULER_SNAP) return 'edge';
    return Math.abs(v) < RULER_W ? 'body' : null;
  }

  /** The long edge nearest a point, as [x, y of a point on it, direction x, direction y]. */
  _rulerEdge(x, y) {
    const r = this.ruler;
    const c = Math.cos(r.a), s = Math.sin(r.a);
    const side = this._rulerLocal(x, y)[1] >= 0 ? 1.0 : -1.0;
    return [r.x - s * RULER_W * side, r.y + c * RULER_W * side, c, s];
  }

  /** @param {number[]} line @param {number} x @param {number} y */
  _onto(line, x, y) {
    const [x0, y0, dx, dy] = line;
    const t = (x - x0) * dx + (y - y0) * dy;
    return [x0 + t * dx, y0 + t * dy];
  }

  /** @param {number} angle */
  _turnRuler(angle) {
    // Settle on the nearest 45 degrees when turned to within a degree and a half of it.
    const near = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    this.ruler.a = Math.abs(angle - near) < 1.5 * Math.PI / 180 ? near : angle;
    this.queueDraw();
  }

  /** @param {CanvasRenderingContext2D} ctx */
  _drawRuler(ctx) {
    const r = this.ruler, half = this._rulerLen();
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(r.a);
    ctx.fillStyle = RULER_BODY;
    ctx.fillRect(-half, -RULER_W, 2 * half, 2 * RULER_W);
    ctx.fillStyle = RULER_INK;
    for (const y of [-RULER_W, RULER_W - 1]) ctx.fillRect(-half, y, 2 * half, 1);
    // The scale is the page's own: a centimetre on the ruler is a centimetre on the printed
    // page, so it grows and shrinks with the zoom.
    const mm = 72 / 25.4 * this.shownZoom();
    const step = [1, 5, 10, 50, 100, 500, 1000].find(n => n * mm >= 3) ?? 5000;
    const every = [10, 50, 100, 500, 1000, 5000].find(n => n >= step && n * mm >= 26) ?? 10000;
    const start = -half + 12;
    ctx.font = '8px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    for (let n = 0; start + n * mm <= half - 6; n += step) {
      const u = start + n * mm;
      const long = n % (step < 10 ? step * 10 : every) === 0;
      const size = long ? 15 : n % (step * 5) === 0 ? 10 : 6;
      ctx.fillRect(u - 0.5, -RULER_W, 1, size);
      ctx.fillRect(u - 0.5, RULER_W - size, 1, size);
      if (n % every === 0) ctx.fillText(String(n / 10), u + 3, -RULER_W + 13);
    }
    const degrees = ((Math.round(r.a * 180 / Math.PI) % 180) + 180) % 180;
    ctx.fillText(`${degrees}°  cm`, -12, RULER_W - 30 + 8);
    ctx.restore();
  }

  // -- page cache ------------------------------------------------------------------------

  /** @param {any} page @returns {[number, number]} */
  _fullSize(page) {
    if (this.zoom < this.renderZoom / 1.5) {
      // Zooming far out: stretching the old raster would mean caching a huge area of it, so step
      // the raster down along the way instead of waiting for the zoom to settle.
      this.renderZoom = this.zoom;
    }
    const s = this.renderZoom * (this.pf.get(page) ?? 1.0) * this.dev;
    return [Math.max(1, Math.round(page.w * s)), Math.max(1, Math.round(page.h * s))];
  }

  /** The part of page i inside the viewport, in page points. @param {number} i @returns {[number, number, number, number]} */
  _visible(i) {
    const page = /** @type {NonNullable<typeof this.doc>} */ (this.doc).pages[i];
    const [px, py, pw] = this._pageRect(i);
    const k = pw / page.w;
    if (this.board) return [-px / k, -py / k, (this.W - px) / k, (this.H - py) / k];
    return [Math.max(0.0, -px / k), Math.max(0.0, -py / k), Math.min(page.w, (this.W - px) / k), Math.min(page.h, (this.H - py) / k)];
  }

  /** Pixel window of the page raster to cache: all of it when it is small enough. */
  _window(page, i, full) {
    if (full[0] * full[1] <= MAX_PIXELS && !this.board) return [0, 0, full[0], full[1]];
    const sx = full[0] / page.w, sy = full[1] / page.h;
    const [x0, y0, x1, y1] = this._visible(i);
    const mx = (x1 - x0) * 0.4, my = (y1 - y0) * 0.4;
    if (this.board) {   // no edges to stop at; the window may lie anywhere
      const wx0 = Math.floor((x0 - mx) * sx / STRIP) * STRIP, wy0 = Math.floor((y0 - my) * sy / STRIP) * STRIP;
      const wx1 = (Math.floor((x1 + mx) * sx / STRIP) + 1) * STRIP;
      const wy1 = (Math.floor((y1 + my) * sy / STRIP) + 1) * STRIP;
      return [wx0, wy0, wx1 - wx0, wy1 - wy0];
    }
    const wx0 = Math.max(0, Math.floor(Math.trunc((x0 - mx) * sx) / STRIP) * STRIP);
    const wy0 = Math.max(0, Math.floor(Math.trunc((y0 - my) * sy) / STRIP) * STRIP);
    const wx1 = Math.min(full[0], (Math.floor(Math.trunc((x1 + mx) * sx) / STRIP) + 1) * STRIP);
    const wy1 = Math.min(full[1], (Math.floor(Math.trunc((y1 + my) * sy) / STRIP) + 1) * STRIP);
    return [wx0, wy0, Math.max(1, wx1 - wx0), Math.max(1, wy1 - wy0)];
  }

  _covers(win, page, i, full) {
    if (win[2] === full[0] && win[3] === full[1]) return true;
    const sx = full[0] / page.w, sy = full[1] / page.h;
    const [x0, y0, x1, y1] = this._visible(i);
    return win[0] <= x0 * sx + 1 && win[1] <= y0 * sy + 1 && win[0] + win[2] >= x1 * sx - 1 && win[1] + win[3] >= y1 * sy - 1;
  }

  /** @param {any} page @param {number} i @returns {Entry|undefined} */
  _ensure(page, i) {
    const full = this._fullSize(page);
    const entry = this.cache.get(page);
    if (entry && entry.full[0] === full[0] && entry.full[1] === full[1] && this._covers([entry.ox, entry.oy, entry.pw, entry.ph], page, i, full)) return entry;
    if (!page.pdf || !this.bgSource) return this._build(page, full, this._window(page, i, full), null);
    this.bgSource.request(this, page, i, full, 0);
    return this.cache.get(page) ?? entry;   // stale or missing until the renderer delivers
  }

  /** @param {any} page @param {[number, number]} full @param {number[]} win @param {any} bg @returns {Entry} */
  _build(page, full, win, bg) {
    const old = this.cache.get(page);
    const canvas = createCanvas(win[2], win[3]);
    /** @type {Entry} */
    const entry = { canvas, full, ox: win[0], oy: win[1], pw: win[2], ph: win[3], sx: full[0] / page.w, sy: full[1] / page.h, bg };
    this.cache.set(page, entry);
    this._repaint(entry, page, null);
    if (old) release(old.canvas);
    return entry;
  }

  /** Redraw the cached raster inside rect (page points), or all of it. @param {Entry} entry @param {any} page @param {number[]|null} rect */
  _repaint(entry, page, rect) {
    const { sx, sy } = entry;
    let x0 = 0, y0 = 0, x1 = entry.pw, y1 = entry.ph;
    if (rect) {
      // Whole device pixels, so no antialiased seam is left behind.
      x0 = Math.max(x0, Math.floor(rect[0] * sx) - 2 - entry.ox); y0 = Math.max(y0, Math.floor(rect[1] * sy) - 2 - entry.oy);
      x1 = Math.min(x1, Math.ceil(rect[2] * sx) + 2 - entry.ox); y1 = Math.min(y1, Math.ceil(rect[3] * sy) + 2 - entry.oy);
      if (x1 <= x0 || y1 <= y0) return;
    }
    const ctx = context2d(entry.canvas);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    if (entry.bg) ctx.drawImage(entry.bg, 0, 0);
    // The shift to the window is done on page coordinates (the origin), not in the matrix.
    const env = { ox: entry.ox / sx, oy: entry.oy / sy, perPixel: 1 / sx, onDark: inkOn(page), printing: false };
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    const box = [(x0 + entry.ox) / sx, (y0 + entry.oy) / sy, (x1 + entry.ox) / sx, (y1 + entry.oy) / sy];
    if (!entry.bg) {
      if (page.pdf) { ctx.fillStyle = '#fff'; ctx.fillRect(box[0] - env.ox, box[1] - env.oy, box[2] - box[0], box[3] - box[1]); }
      else drawPaper(ctx, env, page, box);
    }
    const hidden = this.hidden;
    for (const it of page.items) {
      if (hidden && hidden.has(it)) continue;
      if (intersects(it.bbox, /** @type {any} */ (box))) drawItem(ctx, env, it);
    }
    ctx.restore();
  }

  /** @param {any} page @param {number[]|null} rect */
  _repaintPage(page, rect) {
    const entry = this.cache.get(page);
    if (entry) this._repaint(entry, page, rect);
  }

  /** @param {string} kind @param {...any} args */
  _docEvent(kind, ...args) {
    if (kind === 'added') {
      const [page, items] = args;
      const entry = this.cache.get(page);
      if (entry) {
        const ctx = context2d(entry.canvas);
        ctx.save();
        ctx.setTransform(entry.sx, 0, 0, entry.sy, 0, 0);
        const env = { ox: entry.ox / entry.sx, oy: entry.oy / entry.sy, perPixel: 1 / entry.sx, onDark: inkOn(page), printing: false };
        for (const it of items) drawItem(ctx, env, it);
        ctx.restore();
      }
    } else if (kind === 'dirty') {
      const [page, rect] = args;
      this._repaintPage(page, rect);
    } else if (kind === 'pages') {
      const alive = new Set(/** @type {NonNullable<typeof this.doc>} */ (this.doc).pages);
      for (const [page, e] of [...this.cache]) if (!alive.has(page)) { release(e.canvas); this.cache.delete(page); }
      for (const page of [...this.pending.keys()]) if (!alive.has(page)) this.pending.delete(page);
      this.op = this.sel = this.hidden = null;
      this._relayout();
      this._configureAdj();
      this.emit('view-changed');
    }
    this.queueDraw();
  }

  // -- drawing ----------------------------------------------------------------------------

  _frame() {
    const doc = this.doc, W = this.W, H = this.H, dev = this.dev;
    const ctx = this.mctx;
    ctx.setTransform(dev, 0, 0, dev, 0, 0);
    ctx.fillStyle = this._canvasBg();
    ctx.fillRect(0, 0, W, H);
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.clearRect(0, 0, this.over.width, this.over.height);
    this.octx.setTransform(dev, 0, 0, dev, 0, 0);
    if (!doc || W <= 0 || !this.tops.length) return;
    const board = this.board, across = this._across();
    const first = this._pageAt(this._h(), this._v());
    let i = first;
    while (i < doc.pages.length) {
      const [x, y, w, h] = this._pageRect(i);
      if ((across ? x > W : y > H) && !board) break;
      const page = doc.pages[i];
      if (board) {
        ctx.fillStyle = css(page.color);
        ctx.fillRect(0, 0, W, H);   // it fills the view
      } else {
        ctx.save();
        ctx.shadowColor = SHADOW; ctx.shadowBlur = 10 * dev; ctx.shadowOffsetY = 2 * dev;
        ctx.fillStyle = page.pdf ? '#fff' : css(page.color);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillRect(x * dev, y * dev, w * dev, h * dev);
        ctx.restore();
      }
      const entry = this._ensure(page, i);
      if (entry) {
        // The window of the page that is cached, at the page's place on the screen.
        const k = w / page.w / entry.sx;
        ctx.drawImage(entry.canvas, 0, 0, entry.pw, entry.ph, x + entry.ox * k, y + entry.oy * k, entry.pw * k, entry.ph * k);
      }
      i++;
      if (board) break;
    }
    this.shown = [first, i - 1];
    if (!board) this.bgSource?.prefetch(this, first, i - 1);
    this._trimCache(first, i);

    this.drawOverlay(this.octx);
    if (this.marks.length) {
      this.marks.forEach(([page, box], n) => {
        const idx = this._index(page);
        if (idx === null) return;
        const [px, py, pw] = this._pageRect(idx);
        const k = pw / page.w;
        const rx = px + box[0] * k - 2, ry = py + box[1] * k - 2, rw = (box[2] - box[0]) * k + 4, rh = (box[3] - box[1]) * k + 4;
        if (ry > H || ry + rh < 0) return;
        ctx.fillStyle = n === this.markAt ? MARK_NOW : MARK;
        ctx.fillRect(rx, ry, rw, rh);
      });
    }
    this._drawBars(ctx);
  }

  /** Pages away from the view give their memory back; so does anything over the budget (R9). */
  _trimCache(first, i) {
    const doc = /** @type {NonNullable<typeof this.doc>} */ (this.doc);
    if (this.cache.size > (i - first) + 5) {
      const keep = new Set(doc.pages.slice(Math.max(0, first - 2), i + 2));
      for (const [page, e] of [...this.cache]) if (!keep.has(page)) { release(e.canvas); this.cache.delete(page); }
    }
    let total = 0;
    for (const e of this.cache.values()) total += e.pw * e.ph;
    if (total > CACHE_LIMIT) {
      const here = new Set(doc.pages.slice(first, i));
      for (const [page, e] of [...this.cache]) {
        if (total <= CACHE_LIMIT) break;
        if (!here.has(page)) { total -= e.pw * e.ph; release(e.canvas); this.cache.delete(page); }
      }
    }
  }

  _canvasBg() {
    return (this._bg ??= getComputedStyle(this.el).getPropertyValue('--canvas-bg').trim() || '#e1e1e2');
  }

  /** The theme changed: the colours are asked for again. */
  themeChanged() { this._bg = undefined; this.queueDraw(); }

  // -- scrollbars --------------------------------------------------------------------------
  // Drawn here rather than by the browser, so that they only do what is wanted: they show the
  // place, the mouse can drag them by the handle, a click beside the handle does nothing, and
  // fingers and the pen pass through them.

  /** The bars on show as [axis, lowest value, highest value, x, y, length, handle start, handle length]. */
  _bars() {
    if (!this.scrollbars || this.board || !this.doc || !this.tops.length) return [];
    const W = this.W, H = this.H;
    /** @type {any[]} */
    const out = [];
    for (const [axis, upper, view, across] of /** @type {const} */ ([['v', this._vUpper(), H, W], ['h', this._hUpper(), W, H]])) {
      let lo = 0.0, extent = upper;
      if (axis === 'h' && this._across() && this.slots.length) {
        const i = Math.min(this.currentPageIndex(), this.slots.length - 1);
        const page = this.doc.pages[i];
        lo = this.slots[i]; extent = Math.max(view, page.w * this._z(page) + 2 * SIDE);
      }
      if (extent <= view + 1) continue;
      const hi = lo + extent - view;
      const track = view - 16;
      const handle = Math.max(40.0, track * view / extent);
      const value = axis === 'v' ? this.sy : this.sx;
      const at = 8 + (track - handle) * Math.max(0.0, Math.min(1.0, (value - lo) / (hi - lo)));
      out.push([axis, lo, hi, across - 9, 8, track, at, handle]);
    }
    return out;
  }

  /** @param {CanvasRenderingContext2D} ctx */
  _drawBars(ctx) {
    for (const [axis, , , edge, , , at, handle] of this._bars()) {
      const thick = this.barDrag && this.barDrag[0] === axis ? 8 : 5;
      ctx.fillStyle = 'rgba(140,140,148,0.75)';
      ctx.beginPath();
      if (axis === 'v') ctx.roundRect(edge + 5 - thick, at, thick, handle, thick / 2);
      else ctx.roundRect(at, edge + 5 - thick, handle, thick, thick / 2);
      ctx.fill();
    }
  }

  /** The bar whose handle is under a point, ready to be dragged. @param {number} x @param {number} y */
  _barAt(x, y) {
    for (const [axis, lo, hi, edge, , track, at, handle] of this._bars()) {
      const [along, across] = axis === 'v' ? [y, x] : [x, y];
      if (across >= edge - 8 && at <= along && along <= at + handle) {
        return [axis, lo, hi, (hi - lo) / Math.max(1.0, track - handle), axis === 'v' ? this.sy : this.sx];
      }
    }
    return null;
  }

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    if (this.doc) this.doc.listeners.delete(this._onDocEvent);
    for (const e of this.cache.values()) release(e.canvas);
    this.cache.clear();
  }
}

let dot = '';
/** A pointer that is only the centre of the crosshair. */
function dotCursor() {
  if (!dot) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    x.fillStyle = 'rgba(255,255,255,0.9)'; x.beginPath(); x.arc(8, 8, 2.6, 0, 2 * Math.PI); x.fill();
    x.fillStyle = 'rgba(26,26,26,0.95)'; x.beginPath(); x.arc(8, 8, 1.6, 0, 2 * Math.PI); x.fill();
    dot = c.toDataURL();
  }
  return dot;
}

export { ACCENT, MARK, MARK_NOW, RULER_INK, RULER_BODY, tr, union };
