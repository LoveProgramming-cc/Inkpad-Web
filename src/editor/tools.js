// @ts-check
// What the tools do (B:canvas.py `_down`, `_move`, `_up`, `_erase`, the selection, text, laser):
// added to PageCanvas's prototype. A tool is a little state machine kept in `this.op`:
// {kind: 'stroke' | 'erase' | 'shape' | 'lasso' | 'move' | 'ruler' | 'laser', page, i, ...}.
import { PageCanvas, CHUNK, LASER_FADE_MS, LASER_HOLD_MS } from './canvas.js';
import { drawItem, drawShape, drawStroke } from '../core/draw.js';
import { css } from '../core/color.js';
import * as geom from '../core/geom.js';
import { Image, Shape, Stroke, Text, TAU } from '../core/items.js';
import { inkOn, renderPage } from '../core/render.js';
import { createCanvas, context2d } from '../platform/canvas.js';
import { openPopover } from '../ui/popover.js';
import { h } from '../ui/dom.js';
import { tr } from '../core/i18n.js';
import { pageBox } from '../core/page.js';

const ACCENT = 'rgb(54,133,227)';
const ERASER_RING = 'rgba(77,77,77,0.8)', ERASER_FILL = 'rgba(255,255,255,0.5)';

/** @type {Record<string, (...args: any[]) => any>} */
const methods = {
  // -- the frame's overlay: what is being done now ----------------------------------------

  /** Everything that floats over the pages: the stroke being written, the selection, the laser, the ruler. @param {CanvasRenderingContext2D} ctx */
  drawOverlay(ctx) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const op = cv.op;
    if (op) {
      const idx = cv._index(op.page);
      const draw = /** @type {any} */ (cv)['_snap_' + op.kind];
      if (draw && idx !== null) {
        ctx.save();
        ctx.beginPath();
        if (cv.board) ctx.rect(0, 0, cv.W, cv.H); else ctx.rect(...cv._pageRect(idx));
        ctx.clip();
        draw.call(cv, ctx, op, idx);
        ctx.restore();
      }
    }
    if (cv.sel) cv._snapSelection(ctx);
    if (cv.hover && !cv.op && !cv.penDown) cv._drawHover(ctx);
    if (cv.laserTrails.length || cv.laserDot) cv._drawLaser(ctx);
    if (cv.ruler) cv._drawRuler(ctx);
    if (cv.pull) cv._drawPull(ctx);
  },

  /** Where a pen hovering near the screen (or the mouse, once a pen has been seen) would write
   * (A:CanvasExtras.hovered): a crosshair, a small dot, the eraser's circle or a text cursor. @param {CanvasRenderingContext2D} ctx */
  _drawHover(ctx) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [x, y] = cv.hover;
    const tool = cv.tool;
    ctx.save();
    ctx.lineWidth = 1;
    if (tool === 'eraser') {
      const i = cv._locate(x, y);
      const r = i ? Math.max(cv.eraserR * cv._pageRect(i[0])[2] / /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i[0]].w, 2) : 6;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = ERASER_FILL; ctx.fill(); ctx.strokeStyle = ERASER_RING; ctx.stroke();
    } else if (tool === 'text' || tool === 'note') {
      ctx.strokeStyle = 'rgba(30,30,30,0.85)'; ctx.beginPath(); ctx.moveTo(x - 4, y - 9); ctx.lineTo(x + 4, y - 9); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.moveTo(x - 4, y + 9); ctx.lineTo(x + 4, y + 9); ctx.stroke();
    } else if (!cv.showCross || tool === 'laser') {
      const size = tool === 'pen' || tool === 'hl' || tool === 'tape' ? Math.max(3, (tool === 'pen' ? cv.penWidth : tool === 'hl' ? cv.hlWidth : cv.tapeWidth) * cv.zoom / 2) : 3;
      ctx.beginPath(); ctx.arc(x, y, size + 1, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, size, 0, TAU); ctx.fillStyle = tool === 'laser' ? css(cv.laserColor) : 'rgba(26,26,26,0.95)'; ctx.fill();
    } else {
      for (const [w, c] of /** @type {[number, string][]} */ ([[3, 'rgba(255,255,255,0.8)'], [1, 'rgba(26,26,26,0.9)']])) {
        ctx.lineWidth = w; ctx.strokeStyle = c;
        ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
      }
    }
    ctx.restore();
  },

  /** Put the context in page units for page i; returns what the drawing code needs (the origin is
   * subtracted in doubles, never in the matrix). @param {CanvasRenderingContext2D} ctx @param {number} i */
  _pageEnv(ctx, i) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const page = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i];
    const [px, py, pw] = cv._pageRect(i);
    const k = pw / page.w;
    ctx.setTransform(cv.dev * k, 0, 0, cv.dev * k, 0, 0);
    return { ox: -px / k, oy: -py / k, perPixel: 1 / (k * cv.dev), onDark: inkOn(page), printing: false, k };
  },

  /** Rasterise draw(ctx, env) for a page-space box; returns {canvas, rect: page units} or null.
   * @param {number} i @param {number[]} bbox @param {(ctx: any, env: any) => void} draw */
  _raster(i, bbox, draw) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const page = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i];
    const s = cv._pageRect(i)[2] / page.w * cv.dev;
    const vis = cv._visible(i);
    const x0 = Math.floor(Math.max(bbox[0], vis[0]) * s), y0 = Math.floor(Math.max(bbox[1], vis[1]) * s);
    const x1 = Math.ceil(Math.min(bbox[2], vis[2]) * s), y1 = Math.ceil(Math.min(bbox[3], vis[3]) * s);
    if (x1 <= x0 || y1 <= y0) return null;
    const canvas = createCanvas(x1 - x0, y1 - y0);
    const ctx = context2d(canvas);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    draw(ctx, { ox: x0 / s, oy: y0 / s, perPixel: 1 / s, onDark: inkOn(page), printing: false });
    return { canvas, rect: [x0 / s, y0 / s, (x1 - x0) / s, (y1 - y0) / s] };
  },

  /** A raster put at a place on the page. @param {CanvasRenderingContext2D} ctx @param {number} i @param {any} layer */
  _put(ctx, i, layer) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (!layer) return;
    const { canvas, rect: [rx, ry, rw, rh] } = layer;
    const [px, py, pw] = cv._pageRect(i);
    const k = pw / /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i].w;
    ctx.save();
    ctx.setTransform(cv.dev, 0, 0, cv.dev, 0, 0);
    ctx.drawImage(canvas, px + rx * k, py + ry * k, rw * k, rh * k);
    ctx.restore();
  },

  /** A path along page points, in widget pixels. @param {CanvasRenderingContext2D} ctx @param {number} i @param {number[][]} pts */
  _pagePath(ctx, i, pts, smooth = false, close = false) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [px, py, pw] = cv._pageRect(i);
    const k = pw / /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i].w;
    ctx.beginPath();
    ctx.moveTo(px + pts[0][0] * k, py + pts[0][1] * k);
    const n = pts.length;
    if (smooth && n > 2) {
      for (let j = 1; j < n - 1; j++) {
        const cx = pts[j][0], cy = pts[j][1];
        ctx.quadraticCurveTo(px + cx * k, py + cy * k, px + (cx + pts[j + 1][0]) / 2 * k, py + (cy + pts[j + 1][1]) / 2 * k);
      }
      ctx.lineTo(px + pts[n - 1][0] * k, py + pts[n - 1][1] * k);
    } else {
      for (let j = 1; j < n; j++) ctx.lineTo(px + pts[j][0] * k, py + pts[j][1] * k);
    }
    if (close) ctx.closePath();
    return k;
  },

  /** @param {CanvasRenderingContext2D} ctx @param {any} op @param {number} i */
  _snap_stroke(ctx, op, i) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const item = op.item, pts = item.pts;
    if (item.tool === 'hl' || item.tool === 'tape') {
      const k = cv._pagePath(ctx, i, pts.length > 1 ? pts : [pts[0], pts[0]], true);
      ctx.lineWidth = Math.max(item.width * k, 0.5);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = css(item.color, item.tool === 'hl' ? 0.4 : 1.0);
      ctx.stroke();
      return;
    }
    if (op.layer) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(op.layer.canvas, 0, 0); ctx.restore(); }
    const tail = new Stroke(item.tool, item.color, item.width, pts.slice(Math.max(0, op.baked - 1)), item.sens, item.dash);
    ctx.save();
    const env = cv._pageEnv(ctx, i);
    drawStroke(ctx, env, tail);
    ctx.restore();
  },

  /** @param {CanvasRenderingContext2D} ctx @param {any} op @param {number} i */
  _snap_shape(ctx, op, i) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    ctx.save();
    drawShape(ctx, cv._pageEnv(ctx, i), op.item);
    ctx.restore();
  },

  /** @param {CanvasRenderingContext2D} ctx @param {any} op @param {number} i */
  _snap_erase(ctx, op, i) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [x, y] = op.pos;
    const r = cv.eraserR * cv._pageRect(i)[2] / op.page.w;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(r, 2), 0, TAU);
    ctx.fillStyle = ERASER_FILL; ctx.fill();
    ctx.strokeStyle = ERASER_RING; ctx.lineWidth = 1; ctx.stroke();
  },

  /** @param {CanvasRenderingContext2D} ctx @param {any} op @param {number} i */
  _snap_lasso(ctx, op, i) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    let pts = op.pts;
    if (pts.length > 1) {
      if (op.rect) {
        const [[ax, ay], [bx, by]] = [pts[0], pts[1]];
        pts = [[ax, ay], [bx, ay], [bx, by], [ax, by]];
      }
      cv._pagePath(ctx, i, pts, false, op.rect);
      ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeStyle = ACCENT; ctx.stroke(); ctx.setLineDash([]);
    }
  },

  /** @param {CanvasRenderingContext2D} ctx @param {any} op @param {number} i */
  _snap_move(ctx, op, i) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const layer = op.layer;
    if (!layer) return;
    const { s, origin: [ox, oy] } = op;
    const [rx, ry, rw, rh] = layer.rect;
    cv._put(ctx, i, { canvas: layer.canvas, rect: [ox + (rx - ox) * s + op.dx, oy + (ry - oy) * s + op.dy, rw * s, rh * s] });
  },

  /** @param {CanvasRenderingContext2D} ctx */
  _drawLaser(ctx) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const color = cv.laserColor;
    ctx.save();
    ctx.globalAlpha = cv.laserAlpha;
    for (const [page, pts0] of cv.laserTrails) {
      const i = cv._index(page);
      if (i === null) continue;
      const pts = pts0.length === 1 ? [pts0[0], [pts0[0][0] + 0.01, pts0[0][1]]] : pts0;
      cv._pagePath(ctx, i, pts, true);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [width, paint] of /** @type {[number, string][]} */ ([[13.0, css(color, 0.16)], [7.0, css(color, 0.45)], [3.6, css(color)], [1.3, 'rgba(255,255,255,0.9)']])) {
        ctx.lineWidth = width; ctx.strokeStyle = paint; ctx.stroke();
      }
    }
    if (cv.laserDot) {
      const [page, x, y] = cv.laserDot;
      const i = cv._index(page);
      if (i !== null) {
        const [px, py, pw] = cv._pageRect(i);
        const k = pw / page.w;
        const cx = px + x * k, cy = py + y * k;
        for (const [radius, paint] of /** @type {[number, string][]} */ ([[15.0, css(color, 0.14)], [10.0, css(color, 0.3)], [6.0, css(color)], [2.4, 'rgba(255,255,255,0.9)']])) {
          ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TAU); ctx.fillStyle = paint; ctx.fill();
        }
      }
    }
    ctx.restore();
  },

  /** Any laser activity keeps what is on screen and restarts the countdown. */
  _laserReset() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    clearTimeout(cv.laserTimer); cv.laserTimer = 0;
    if (cv.laserFade) { cancelAnimationFrame(cv.laserFade); cv.laserFade = 0; }
    cv.laserAlpha = 1.0;
  },

  _laserExpire() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv.laserTimer = 0;
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / LASER_FADE_MS);
      cv.laserAlpha = 1 - t;
      cv.queueDraw();
      if (t < 1) { cv.laserFade = requestAnimationFrame(step); return; }
      cv.laserFade = 0; cv.laserTrails = []; cv.laserAlpha = 1.0; cv.queueDraw();
    };
    cv.laserFade = requestAnimationFrame(step);
  },

  clearLaser() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv._laserReset();
    cv.laserTrails = []; cv.laserDot = null;
    cv.queueDraw();
  },

  /** Selection box in page points, following an in-progress move or scale. */
  _selBox() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const [x0, y0, x1, y1] = cv.sel.bbox;
    const op = cv.op;
    if (op && op.kind === 'move') {
      const { s, origin: [ox, oy], dx, dy } = op;
      return [ox + (x0 - ox) * s + dx, oy + (y0 - oy) * s + dy, ox + (x1 - ox) * s + dx, oy + (y1 - oy) * s + dy];
    }
    return [x0, y0, x1, y1];
  },

  /** @param {CanvasRenderingContext2D} ctx */
  _snapSelection(ctx) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const i = cv._index(cv.sel.page);
    if (i === null) return;
    const [x0, y0, x1, y1] = cv._selBox();
    const [px, py, pw] = cv._pageRect(i);
    const k = pw / cv.sel.page.w;
    ctx.beginPath();
    ctx.rect(px + x0 * k - 4, py + y0 * k - 4, (x1 - x0) * k + 8, (y1 - y0) * k + 8);
    ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeStyle = ACCENT; ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(px + x1 * k + 4, py + y1 * k + 4, 6, 0, TAU);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = ACCENT; ctx.stroke();
  },

  /** @param {CanvasRenderingContext2D} ctx */
  _drawPull(ctx) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const done = Math.min(1.0, Math.abs(cv.pull) / 280);
    const x = cv.pull > 0 ? cv.W - 70 : 70, y = cv.H / 2;
    ctx.beginPath(); ctx.arc(x, y, 26, 0, TAU);
    ctx.fillStyle = `rgba(54,133,227,${0.12 + 0.5 * done})`; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = ACCENT; ctx.stroke();
    ctx.fillStyle = done >= 1 ? '#fff' : ACCENT;
    ctx.fillRect(x - 9, y - 1, 18, 2);
    ctx.fillRect(x - 1, y - 9, 2, 18);
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(done >= 1 ? tr('松手添加页面') : tr('继续拉动添加页面'), x, y + 46);
    ctx.textAlign = 'left';
  },

  // -- tools ----------------------------------------------------------------------------------

  /** A pen, finger or mouse came down. @param {number} x @param {number} y @param {number} pressure @param {boolean} erase */
  down(x, y, pressure, erase) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv.el.focus({ preventScroll: true });
    cv.op = null;
    const tool = erase ? 'eraser' : cv.tool;
    let rule = null;
    const zone = tool !== 'eraser' ? cv._rulerZone(x, y) : null;
    if (cv.src !== 'pen' && tool !== 'eraser' && tool !== 'lasso' && zone === null && cv.toggleTape(x, y)) return;   // a finger or a click on a tape lifts it or puts it back
    if (zone === 'body' && cv.src !== 'pen') {
      // A finger or the mouse on the ruler moves it; only the pen draws across it.
      cv.op = { kind: 'ruler', page: null, grab: [x - cv.ruler.x, y - cv.ruler.y] };
      return;
    }
    if (zone && (tool === 'pen' || tool === 'hl' || tool === 'tape')) {
      // A stroke begun at the ruler runs along its edge.
      rule = cv._rulerEdge(x, y);
      [x, y] = cv._onto(rule, x, y);
    }
    if (tool === 'lasso') {
      if (cv.src !== 'pen') cv.press(x, y);   // the pen holds still too often while writing for this to be meant
      if (cv.sel && cv.grabSelection(x, y)) return;
    }
    cv.clearSelection();
    const loc = cv._locate(x, y);
    if (!loc) return;
    const [i, px, py] = loc;
    const page = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i];
    if (tool === 'pen' || tool === 'hl' || tool === 'tape') {
      let item;
      if (tool === 'tape') item = new Stroke('tape', cv.tapeColor, cv.tapeWidth, [[px, py, 0.5]]);
      else if (tool === 'pen') item = new Stroke(cv.penType, cv.penColor, cv.penWidth, [[px, py, pressure]], cv.penSens, cv.penDash);
      else item = new Stroke('hl', cv.hlColor, cv.hlWidth, [[px, py, 0.5]]);
      cv.op = { kind: 'stroke', page, i, item, smooth: [px, py], rule, anchor: [x, y], layer: null, baked: 0 };
    } else if (tool === 'eraser') {
      cv.op = { kind: 'erase', page, i, pos: [x, y], last: [px, py], before: [...page.items], changed: false };
      cv._erase(cv.op, px, py);
    } else if (tool === 'shape') {
      cv.op = { kind: 'shape', page, i, item: new Shape(cv.shapeKind, px, py, px, py, cv.penColor, cv.penWidth) };
    } else if (tool === 'lasso') {
      cv.op = { kind: 'lasso', page, i, pts: [[px, py]], rect: cv.lassoRect };
    } else if (tool === 'text' || tool === 'note') {
      cv.editText(i, page, x, y, px, py, tool === 'note');
    } else if (tool === 'laser') {
      cv._laserReset();
      cv.op = { kind: 'laser', page, i, trail: cv.laserMode === 'trail' };
      if (cv.op.trail) cv.laserTrails.push([page, [[px, py]]]); else cv.laserDot = [page, px, py];
    }
    cv.queueDraw();
  },

  /** @param {number} x @param {number} y @param {number} pressure */
  move(x, y, pressure) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const op = cv.op;
    if (!op) return;
    const kind = op.kind;
    if (cv.pressTimer && Math.hypot(x - cv.pressAt[0], y - cv.pressAt[1]) > 10) cv.stopPress();
    if (kind === 'move') {
      const i = cv._index(op.page);
      if (i === null) return;
      if (!op.live) {
        // A finger does not hold still: the selection stays put until it clearly moves.
        if (Math.hypot(x - op.at[0], y - op.at[1]) < op.slack) return;
        op.live = true;
      }
      const [px, py] = cv._toPage(i, x, y);
      if (op.scaling) {
        const [ox, oy] = op.origin, [sx, sy] = op.start;
        op.s = Math.max(0.1, Math.hypot(px - ox, py - oy) / Math.max(1.0, Math.hypot(sx - ox, sy - oy)));
      } else {
        op.dx = px - op.start[0]; op.dy = py - op.start[1];
      }
      cv.queueDraw();
      return;
    }
    if (kind === 'ruler') {
      cv.ruler.x = x - op.grab[0]; cv.ruler.y = y - op.grab[1];
      cv.queueDraw();
      return;
    }
    if (op.fixed) return;
    if (op.rule) [x, y] = cv._onto(op.rule, x, y);
    let [px, py] = cv._toPage(op.i, x, y);
    if (kind === 'stroke') {
      const item = op.item, pts = item.pts;
      if (cv.holdShape && !op.rule) {
        const [ax, ay] = op.anchor;
        if (!cv.holdTimer || (x - ax) ** 2 + (y - ay) ** 2 > 25) {
          op.anchor = [x, y];
          clearTimeout(cv.holdTimer);
          cv.holdTimer = window.setTimeout(() => cv.held(), 600);
        }
      }
      if (cv.penStab > 0 && item.tool !== 'hl' && item.tool !== 'tape' && !op.rule) {
        // Stabiliser: the ink follows the pen through a low-pass filter.
        const k = 1.0 - 0.9 * cv.penStab;
        const [sx, sy] = op.smooth;
        px = sx + (px - sx) * k; py = sy + (py - sy) * k;
        op.smooth = [px, py];
      }
      const lx = pts[pts.length - 1][0], ly = pts[pts.length - 1][1];
      if ((px - lx) ** 2 + (py - ly) ** 2 < (0.4 / cv.zoom) ** 2) return;
      pts.push([px, py, pressure]);
      if (item.tool !== 'hl' && item.tool !== 'tape' && !item.dash && pts.length - op.baked >= CHUNK) {
        // Freeze what is drawn so far; only the tail is redrawn per frame.
        const part = new Stroke(item.tool, item.color, item.width, pts.slice(Math.max(0, op.baked - 1)), item.sens);
        if (!op.layer) {
          const canvas = createCanvas(cv.W * cv.dev, cv.H * cv.dev);
          op.layer = { canvas, ctx: context2d(canvas) };
        }
        const lctx = op.layer.ctx;
        lctx.save();
        const env = cv._pageEnv(lctx, op.i);
        drawStroke(lctx, env, part);
        lctx.restore();
        op.baked = pts.length - 1;
      }
    } else if (kind === 'erase') {
      op.pos = [x, y];
      cv._erase(op, px, py);
    } else if (kind === 'laser') {
      if (op.trail) cv.laserTrails[cv.laserTrails.length - 1][1].push([px, py]);
      else cv.laserDot = [op.page, px, py];
    } else if (kind === 'shape') {
      const item = op.item;
      item.x1 = px; item.y1 = py;
      item.updateBbox();
    } else if (kind === 'lasso') {
      if (op.rect) op.pts.splice(1, op.pts.length, [px, py]); else op.pts.push([px, py]);
    }
    cv.queueDraw();
  },

  /** Lift the tape under a point, or put it back; true if there was one. @param {number} x @param {number} y */
  toggleTape(x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const loc = cv._locate(x, y);
    if (!loc) return false;
    const [i, px, py] = loc;
    const page = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i];
    for (let k = page.items.length - 1; k >= 0; k--) {
      const it = page.items[k];
      if (it.kind === 's' && it.tool === 'tape' && geom.intersects(it.bbox, [px, py, px, py]) && it.hit(px, py, 2 / cv.zoom)) {
        it.open = !it.open;
        page.rev += 1;
        /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).touch();
        cv._repaintPage(page, it.bbox);
        cv.queueDraw();
        return true;
      }
    }
    return false;
  },

  /** The pen rested at the end of a stroke: snap the stroke to a clean shape. */
  held() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv.holdTimer = 0;
    const op = cv.op;
    if (!op || op.kind !== 'stroke' || op.item.pts.length < 6) return;
    const item = op.item;
    const found = geom.recognizeShape(item.pts);
    if (!found) return;
    if (item.tool === 'hl' || item.tool === 'tape') {
      if (found[0] !== 'line') return;
      item.pts.splice(0, item.pts.length, [found[1], found[2], 0.5], [found[3], found[4], 0.5]);
      item.updateBbox();
    } else {
      op.kind = 'shape';
      op.item = new Shape(/** @type {string} */ (found[0]), /** @type {number} */ (found[1]), /** @type {number} */ (found[2]), /** @type {number} */ (found[3]), /** @type {number} */ (found[4]), item.color, item.width);
    }
    op.fixed = true;
    cv.queueDraw();
  },

  stopHold() { const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this)); clearTimeout(cv.holdTimer); cv.holdTimer = 0; },

  /** The select tool came down: if it stays where it is, a menu is wanted there. @param {number} x @param {number} y */
  press(x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv.stopPress();
    cv.pressAt = [x, y];
    cv.pressTimer = window.setTimeout(() => cv._pressed(), 550);
  },

  stopPress() { const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this)); clearTimeout(cv.pressTimer); cv.pressTimer = 0; },

  _pressed() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    cv.pressTimer = 0;
    // Whatever the press had begun (a lasso, a move of the selection) is given up, and what is left of the press does nothing more.
    cv.cancel();
    if (cv.tg) Object.assign(cv.tg, { grab: 'held', draw: false, moved: false });
    cv.emit('menu-wanted', ...cv.pressAt);
  },

  /** Select the topmost picture, shape or text box at a point of the widget, or nothing if none is there. @param {number} x @param {number} y */
  pickAt(x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const loc = cv._locate(x, y);
    /** @type {any[]} */
    let picked = [];
    let page = null;
    if (loc) {
      const [i, px, py] = loc;
      page = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages[i];
      const r = 10 / Math.max(1e-6, cv._z(page));
      for (let k = page.items.length - 1; k >= 0; k--) {
        const it = page.items[k];
        // Not handwriting: a tap among the lines of a page would always catch some of it.
        if (it.kind === 's' || !cv.lassoFilter.has(lassoKind(it)) || !geom.intersects(it.bbox, [px - r, py - r, px + r, py + r])) continue;
        // Pictures and text are picked anywhere inside; ink and shapes on their lines.
        if (it.kind === 'i' || it.kind === 't' || it.hit(px, py, r)) { picked = [it]; break; }
      }
    }
    if (picked.length) cv.select(page, picked); else cv.clearSelection();
    return picked.length > 0;
  },

  /** The pen, finger or mouse went up. @param {number} x @param {number} y */
  up(x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const op = cv.op;
    cv.op = null;
    cv.stopHold();
    cv.stopPress();
    if (!op) return;
    const { kind, page } = op;
    const doc = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc);
    const fixed = op.fixed;
    if (kind === 'stroke') {
      const item = op.item;
      if (cv.penStab > 0 && item.tool !== 'hl' && item.tool !== 'tape' && !fixed && !op.rule) {
        // Catch the lagging stabilised line up with where the pen lifted.
        const [px, py] = cv._toPage(op.i, x, y);
        item.pts.push([px, py, item.pts[item.pts.length - 1][2]]);
      }
      item.updateBbox();
      if (item.tool !== 'hl' && item.tool !== 'tape' && !fixed && !op.rule && cv.scribbleErase && geom.isScribble(item.pts)) {
        const targets = geom.scribbleTargets(item.pts, page.items);
        if (targets.length) {
          // Scribble to erase, recorded as two steps: the scribble as ordinary ink, then the erasure.
          // One undo brings everything back with the scribble still there (in case it was not meant
          // as one), a second undo removes the scribble too.
          doc.addItems(page, [item]);
          doc.removeItems(page, [...targets, item]);
          cv.onScribble?.(targets.length);
          cv.queueDraw();
          return;
        }
      }
      doc.addItems(page, [item]);
    } else if (kind === 'erase') {
      if (op.changed) {
        doc.pushDiff(page, op.before);
        cv.onEraseDone?.();
      }
    } else if (kind === 'laser') {
      cv.laserDot = null;
      if (cv.laserTrails.length) cv.laserTimer = window.setTimeout(() => cv._laserExpire(), LASER_HOLD_MS);
    } else if (kind === 'shape') {
      const item = op.item;
      if (Math.hypot(item.x1 - item.x0, item.y1 - item.y0) > 2) doc.addItems(page, [item]);
    } else if (kind === 'lasso') {
      const pts = op.pts;
      const box = geom.bboxOf(pts);
      const items = page.items.filter(/** @param {any} it */ it => cv.lassoFilter.has(lassoKind(it)));
      if (Math.max(box[2] - box[0], box[3] - box[1]) * cv._z(page) < 8) {
        cv.pickAt(x, y);   // a tap selects the topmost item under it
        cv.queueDraw();
        return;
      }
      cv.select(page, op.rect ? geom.rectPick(box, items) : geom.lassoPick(pts, items));
    } else if (kind === 'move') {
      cv.hidden = null;
      const olds = cv.sel.items;
      const { s, origin: [ox, oy], dx, dy } = op;
      if (Math.abs(s - 1) > 1e-3 || Math.hypot(dx, dy) * cv.zoom > 1) {
        const news = olds.map(/** @param {any} it */ it => it.transformed(s, ox, oy, dx, dy));
        if (op.copy) doc.addItems(page, news);   // the originals stay where they were
        else doc.replaceItems(page, olds, news);
        cv.select(page, news);
      } else {
        cv._repaintPage(page, cv.sel.bbox);
      }
      cv.op = null;
      cv.emit('selection-changed');
    }
    cv.queueDraw();
  },

  cancel() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const op = cv.op;
    cv.op = null;
    cv.penDown = cv.mouseDown = false;
    cv.stopHold();
    cv.stopPress();
    if (!op) return;
    if (op.kind === 'laser') {
      cv.laserDot = null;
      if (cv.laserTrails.length) cv.laserTrails.pop();
    } else if (op.kind === 'erase' && op.changed) {
      /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pushDiff(op.page, op.before);
    } else if (op.kind === 'move') {
      cv.hidden = null;
      cv._repaintPage(op.page, cv.sel.bbox);
      cv.emit('selection-changed');
    }
    cv.queueDraw();
  },

  /** @param {any} op @param {number} px @param {number} py */
  _erase(op, px, py) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const page = op.page;
    const r = cv.eraserR;
    const [lx, ly] = op.last;
    op.last = [px, py];
    const reach = [Math.min(lx, px) - r, Math.min(ly, py) - r, Math.max(lx, px) + r, Math.max(ly, py) + r];
    const whole = cv.eraserMode === 'stroke';
    const allowed = cv.eraseFilter;
    /** @type {any[]} */
    const out = [];
    /** @type {number[]|null} */
    let rect = null;
    for (const it of page.items) {
      if (!geom.intersects(it.bbox, /** @type {any} */ (reach)) || !allowed.has(eraseKind(it))) { out.push(it); continue; }
      if (whole || (it.kind === 'h' && it.shape === 'arrow')) {
        const steps = Math.max(1, Math.trunc(Math.hypot(px - lx, py - ly) / (r * 0.7)));
        let hit = false;
        for (let k = 0; k <= steps && !hit; k++) hit = it.hit(lx + (px - lx) * k / steps, ly + (py - ly) * k / steps, r);
        if (hit) rect = /** @type {any} */ (geom.union(/** @type {any} */ (rect), it.bbox)); else out.push(it);
        continue;
      }
      // Standard eraser: cut the touched part out and keep the rest as shorter strokes.
      const pts = it.kind === 's' ? it.pts : it.polyline().map(/** @param {number[]} p */ p => [p[0], p[1], 0.5]);
      const cut = geom.eraseRuns(pts, lx, ly, px, py, r + it.width / 2);
      if (!cut) { out.push(it); continue; }
      const [runs, box] = cut;
      let tool, sens, dash;
      if (it.kind === 's' && !it.dash) {
        const pad = it.pad() + 2;
        rect = /** @type {any} */ (geom.union(/** @type {any} */ (rect), [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]));
        [tool, sens, dash] = [it.tool, it.sens, 0];
      } else {
        rect = /** @type {any} */ (geom.union(/** @type {any} */ (rect), it.bbox));   // a shape or dashed line is redrawn as a whole
        [tool, sens, dash] = it.kind === 's' ? [it.tool, it.sens, it.dash] : ['ball', 1.0, 0];
      }
      for (const run of runs) if (run.length > 1) out.push(new Stroke(tool, it.color, it.width, run, sens, dash));
    }
    if (!rect) return;
    page.items = out;
    op.changed = true;
    cv._repaintPage(page, rect);
  },

  // -- selection -------------------------------------------------------------------------------

  /** @param {any} page @param {any[]} items */
  select(page, items) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (!items.length) cv.sel = null;
    else {
      /** @type {number[]|null} */
      let box = null;
      for (const it of items) box = /** @type {any} */ (geom.union(/** @type {any} */ (box), it.bbox));
      cv.sel = { page, items: [...items], bbox: box };
      cv.emit('selection-made');
    }
    cv.emit('selection-changed');
    cv.queueDraw();
  },

  clearSelection() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (cv.sel) { cv.sel = null; cv.emit('selection-changed'); cv.queueDraw(); }
  },

  /** The selection box in widget coordinates, or null (also while it is being dragged). */
  selectionRect() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    if (!sel || (cv.op && cv.op.kind === 'move')) return null;
    const i = cv._index(sel.page);
    if (i === null) return null;
    const [px, py, pw] = cv._pageRect(i);
    const k = pw / sel.page.w;
    const [x0, y0, x1, y1] = sel.bbox;
    return [px + x0 * k, py + y0 * k, (x1 - x0) * k, (y1 - y0) * k];
  },

  /** Take hold of the selection at a point of the widget: inside it to move it, on its edge
   * (within reach pixels) or its handle to resize it. False if the point is elsewhere.
   * @param {number} x @param {number} y */
  grabSelection(x, y, reach = 7) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    const i = cv._index(sel.page);
    if (i === null) return false;
    const [px, py] = cv._toPage(i, x, y);
    const [x0, y0, x1, y1] = sel.bbox;
    const k = cv._pageRect(i)[2] / sel.page.w;
    // The box as drawn is 4 pixels larger all round.
    const bx0 = x0 - 4 / k, by0 = y0 - 4 / k, bx1 = x1 + 4 / k, by1 = y1 + 4 / k;
    const r = reach / k;
    let origin = [x0, y0];
    let scaling = Math.hypot((px - x1) * k - 4, (py - y1) * k - 4) <= 13;
    if (!scaling) {
      if (!(bx0 - r <= px && px <= bx1 + r && by0 - r <= py && py <= by1 + r)) return false;
      // The edge is a band about the outline; a small selection keeps a middle to move it by.
      const inner = Math.min(r, (bx1 - bx0) / 4, (by1 - by0) / 4);
      if (!(bx0 + inner < px && px < bx1 - inner && by0 + inner < py && py < by1 - inner)) {
        // It grows and shrinks about the point opposite the one taken hold of.
        scaling = true;
        origin = [x0 + x1 - Math.max(x0, Math.min(x1, px)), y0 + y1 - Math.max(y0, Math.min(y1, py))];
      }
    }
    const items = sel.items;
    // Lift the items out of the page raster and carry them as one image.
    const layer = cv._raster(i, sel.bbox, (ctx, env) => { for (const it of items) drawItem(ctx, env, it); });
    cv.hidden = new Set(items);
    cv._repaintPage(sel.page, sel.bbox);
    cv.op = { kind: 'move', page: sel.page, start: [px, py], origin, copy: false, scaling, s: 1.0, dx: 0.0, dy: 0.0, layer, at: [x, y], slack: reach > 7 ? 8 : 0, live: false };
    cv.emit('selection-changed');
    cv.queueDraw();
    return true;
  },

  /** Start dragging a copy of the selection from a point of the widget. @param {number} x @param {number} y */
  copySelectionFrom(x, y) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    const i = sel ? cv._index(sel.page) : null;
    if (i === null) return false;
    const items = sel.items;
    const layer = cv._raster(i, sel.bbox, (ctx, env) => { for (const it of items) drawItem(ctx, env, it); });
    cv.op = { kind: 'move', page: sel.page, start: cv._toPage(i, x, y), origin: sel.bbox.slice(0, 2), copy: true, scaling: false, s: 1.0, dx: 0.0, dy: 0.0, layer, at: [x, y], slack: 8, live: false };
    cv.emit('selection-changed');
    cv.queueDraw();
    return true;
  },

  deleteSelection() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    cv.sel = null;
    if (sel) { /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).removeItems(sel.page, sel.items); cv.emit('selection-changed'); }
  },

  duplicateSelection() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    if (sel) {
      const items = sel.items.map(/** @param {any} it */ it => it.transformed(1, 0, 0, 14, 14));
      /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).addItems(sel.page, items);
      cv.select(sel.page, items);
    }
  },

  /** Give the selected ink, shapes and text a colour; pictures are left as they are. @param {number[]} color */
  recolorSelection(color) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    if (!sel) return;
    const news = sel.items.map(/** @param {any} it */ it => {
      const n = it.transformed(1, 0, 0, 0, 0);
      if ('color' in n) n.color = [...color];
      return n;
    });
    /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).replaceItems(sel.page, sel.items, news);
    cv.select(sel.page, news);
  },

  /** Turn the selection k quarter turns clockwise about its own centre (text stays upright). Pictures are re-encoded first, which takes a moment. @param {number} k */
  async rotateSelection(k) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    if (!sel) return;
    const { prepareRotation } = await import('../core/items.js');
    await prepareRotation(sel.items, k % 4);
    if (cv.sel !== sel) return;   // changed while the pictures were being turned
    const page = sel.page;
    const [x0, y0, x1, y1] = sel.bbox;
    const turned = sel.items.map(/** @param {any} it */ it => it.rotated(k % 4, page.w, page.h));
    /** @type {number[]|null} */
    let box = null;
    for (const it of turned) box = /** @type {any} */ (geom.union(/** @type {any} */ (box), it.bbox));
    const b = /** @type {number[]} */ (box);
    const dx = (x0 + x1 - b[0] - b[2]) / 2, dy = (y0 + y1 - b[1] - b[3]) / 2;
    const news = turned.map(/** @param {any} it */ it => it.transformed(1, 0, 0, dx, dy));
    /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).replaceItems(page, sel.items, news);
    cv.select(page, news);
  },

  /** Move the selection above (or below) everything else on its page. @param {boolean} front */
  restackSelection(front) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    if (!sel) return;
    const page = sel.page;
    const chosen = new Set(sel.items);
    /** @type {[number, any][]} */
    const ordered = [];
    page.items.forEach(/** @param {any} it @param {number} i */ (it, i) => { if (chosen.has(it)) ordered.push([i, it]); });
    const base = front ? page.items.length - ordered.length : 0;
    /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).do({ kind: 'items', page, removed: ordered, added: ordered.map(([, it], j) => [base + j, it]) });
    cv.queueDraw();
  },

  /** The selected area of the page, paper included, as a canvas. @param {number} [scale] */
  selectionImage(scale = 2.0) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const sel = cv.sel;
    if (!sel) return null;
    const page = sel.page;
    let [x0, y0, x1, y1] = sel.bbox;
    x0 = Math.max(0, x0 - 6); y0 = Math.max(0, y0 - 6); x1 = Math.min(page.w, x1 + 6); y1 = Math.min(page.h, y1 + 6);
    const canvas = createCanvas(Math.max(1, Math.round((x1 - x0) * scale)), Math.max(1, Math.round((y1 - y0) * scale)));
    const ctx = context2d(canvas);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Rendered the way a page is, from the selection's corner (the origin is subtracted in doubles).
    renderPage(ctx, page, { ox: x0, oy: y0, perPixel: 1 / scale });
    return canvas;
  },

  copySelection() {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (cv.sel) cv.clip = cv.sel.items.map(/** @param {any} it */ it => it.transformed(1, 0, 0, 0, 0));
    return !!cv.sel;
  },

  /** Put the copied items on the page: a little beside where they were, or centred on a point of the widget. @param {number[]|null} [at] */
  paste(at = null) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    if (!cv.clip.length) return false;
    const doc = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc);
    const loc = at ? cv._locate(at[0], at[1]) : null;
    if (loc) {
      const page = doc.pages[loc[0]];
      /** @type {number[]|null} */
      let box = null;
      for (const it of cv.clip) box = /** @type {any} */ (geom.union(/** @type {any} */ (box), it.bbox));
      const b = /** @type {number[]} */ (box);
      const items = cv.clip.map(/** @param {any} it */ it => it.transformed(1, 0, 0, loc[1] - (b[0] + b[2]) / 2, loc[2] - (b[1] + b[3]) / 2));
      doc.addItems(page, items);
      cv.select(page, items);
      return true;
    }
    const page = doc.pages[cv.currentPageIndex()];
    const items = cv.clip.map(/** @param {any} it */ it => it.transformed(1, 0, 0, 14, 14));
    cv.clip = items;
    doc.addItems(page, items);
    cv.select(page, items);
    return true;
  },

  /** Place an image in the middle of the visible part of the current page, or centred on a point of the widget.
   * @param {Blob} png @param {number} width @param {number} height @param {number[]|null} [at] @param {ImageBitmap|null} [bitmap] */
  insertImage(png, width, height, at = null, bitmap = null) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const doc = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc);
    const loc = at ? cv._locate(at[0], at[1]) : null;
    const i = loc ? loc[0] : cv.currentPageIndex();
    const page = doc.pages[i];
    const k = Math.min(1.0, page.w * 0.6 / width, page.h * 0.6 / height);
    const w = width * k, hh = height * k;
    const [cx, cy] = loc ? [loc[1], loc[2]] : cv._toPage(i, cv.W / 2, cv.H / 2);
    let x = cx - w / 2, y = cy - hh / 2;
    if (!page.board) { x = Math.max(0, Math.min(page.w - w, x)); y = Math.max(0, Math.min(page.h - hh, y)); }
    const item = new Image(x, y, w, hh, png, bitmap);
    doc.addItems(page, [item]);
    cv.select(page, [item]);
  },

  // -- text ------------------------------------------------------------------------------------

  /** A box to write in, at the place that was touched; a text box that is there is edited.
   * @param {number} i @param {any} page @param {number} x @param {number} y @param {number} px @param {number} py */
  editText(i, page, x, y, px, py, note = false) {
    const cv = /** @type {PageCanvas} */ (/** @type {any} */ (this));
    const doc = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc);
    let existing = null;
    for (let k = page.items.length - 1; k >= 0; k--) {
      const it = page.items[k];
      if (it.kind === 't' && geom.intersects(it.bbox, [px, py, px, py])) { existing = it; break; }
    }
    const area = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: 4, style: { width: '280px', minHeight: '96px' }, value: existing ? existing.text : '' }));
    const done = h('button', { class: 'suggested', style: { alignSelf: 'flex-end' } }, tr('完成'));
    const color = [...cv.penColor], size = cv.textSize;
    const r = cv.el.getBoundingClientRect();
    const pop = openPopover(h('div', { class: 'col' }, area, done), {
      anchor: new DOMRect(r.left + x, r.top + y, 1, 1), side: 'auto',
      onClose: () => {
        cv.popover = null;
        const text = area.value.trim();
        if (existing) {
          if (!text) doc.removeItems(page, [existing]);
          else if (text !== existing.text) doc.replaceItems(page, [existing], [new Text(existing.x, existing.y, text, existing.size, existing.color, existing.wrap, existing.bg)]);
        } else if (text && note) {
          doc.addItems(page, [new Text(px, py, text, 13.0, [0.16, 0.15, 0.12], 170.0, [...cv.noteColor])]);
        } else if (text) {
          doc.addItems(page, [new Text(px, py, text, size, color, page.board ? 400.0 : Math.max(60.0, page.w - px - 12))]);
        }
      },
    });
    done.addEventListener('click', () => pop.close());
    cv.popover = pop;
    area.focus();
  },
};

/** @param {any} it */
function lassoKind(it) { return /** @type {Record<string, string>} */ ({ s: 'ink', h: 'shape', i: 'image', t: 'text' })[it.kind]; }

/** @param {any} it */
function eraseKind(it) {
  if (it.kind === 's') return it.tool === 'hl' ? 'hl' : 'pen';
  return it.kind === 'h' ? 'shape' : null;
}

Object.assign(PageCanvas.prototype, methods);
export { lassoKind, eraseKind };
