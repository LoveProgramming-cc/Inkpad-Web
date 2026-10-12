// @ts-check
// The whiteboard navigator: a small map of where the board is written on, with the part on
// screen marked, the zoom level, and a button that brings all of it into view (B:minimap.py).
import { h, icon } from '../ui/ui.js';
import { densify, union } from '../core/geom.js';
import { pageBox } from '../core/page.js';
import { tr } from '../core/i18n.js';

const MAP_W = 216, MAP_H = 150;

export class Minimap {
  /** @param {import('./canvas.js').PageCanvas} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.cells = new Set();   // occupied grid cells of the board's content, "cx,cy"
    this.cell = 1.0;          // their size in page points
    /** @type {number[]|null} */ this.box = null;   // the page area the cells cover
    /** @type {number[]|null} */ this.fit = null;   // [region x0, region y0, scale, offset x, offset y] of the last frame
    this.timer = 0;
    this.map = /** @type {HTMLCanvasElement} */ (h('canvas', { width: MAP_W * 2, height: MAP_H * 2 }));
    this.zoom = h('button', { class: 'flat', title: tr('恢复 100%'), onClick: () => canvas.setZoom(1.0) });
    const fitBtn = h('button', { class: 'flat icon-btn', title: tr('显示全部内容'), style: { width: '46px', flex: 'none' }, onClick: () => canvas.fitContent() }, icon('fit_all'));
    this.el = h('div', { class: 'minimap', hidden: true }, this.map, h('div', { class: 'sep', style: { margin: 0 } }),
      h('div', { class: 'row', style: { gap: 0 } }, this.zoom, h('div', { style: { width: '1px', alignSelf: 'stretch', background: 'color-mix(in srgb, currentColor 10%, transparent)' } }), fitBtn));
    const go = (/** @type {PointerEvent} */ e) => {
      if (!this.fit) return;
      const r = this.map.getBoundingClientRect();
      const [rx0, ry0, s, ox, oy] = this.fit;
      canvas.centerAt(canvas.currentPageIndex(), rx0 + (e.clientX - r.left - ox) / s, ry0 + (e.clientY - r.top - oy) / s);
    };
    this.map.addEventListener('pointerdown', e => { this.map.setPointerCapture(e.pointerId); go(e); });
    this.map.addEventListener('pointermove', e => { if (this.map.hasPointerCapture(e.pointerId)) go(e); });
    canvas.on('view-changed', () => this.refresh());
  }

  refresh() {
    if (this.el.hidden) return;
    this.zoom.textContent = Math.round(this.canvas.zoom * 100) + '%';
    this.draw();
  }

  /** The board was drawn on: update the picture shortly, not on every stroke point. */
  contentChanged() {
    if (!this.el.hidden && !this.timer) this.timer = window.setTimeout(() => { this.timer = 0; this.render(); }, 350);
  }

  /** @param {boolean} board */
  showFor(board) {
    this.el.hidden = !board;
    if (board) { this.render(); this.refresh(); }
  }

  /** Work out which parts of the board are written on; called a moment after it changes. The map
   * does not draw the ink itself, which would be illegible at this size: it marks the occupied
   * areas with small blocks. */
  render() {
    const cv = this.canvas;
    if (!cv.doc) return;
    const page = cv.doc.pages[cv.currentPageIndex()];
    const box = pageBox(page);
    this.box = box;
    const [x0, y0, x1, y1] = box;
    const cell = Math.max((x1 - x0) / 64, (y1 - y0) / 44, 1e-6);
    const cells = new Set();
    for (const it of page.items) {
      if (it.kind === 'i' || it.kind === 't') {
        const [bx0, by0, bx1, by1] = it.bbox;
        for (let cx = Math.trunc((bx0 - x0) / cell); cx <= Math.trunc((bx1 - x0) / cell); cx++) {
          for (let cy = Math.trunc((by0 - y0) / cell); cy <= Math.trunc((by1 - y0) / cell); cy++) cells.add(cx + ',' + cy);
        }
      } else {
        const line = it.polyline();
        if (line && line.length) for (const p of line.length > 1 ? densify(line, cell * 0.45) : line) cells.add(Math.trunc((p[0] - x0) / cell) + ',' + Math.trunc((p[1] - y0) / cell));
      }
    }
    this.cell = cell; this.cells = cells;
    this.draw();
  }

  draw() {
    const cv = this.canvas;
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.map.getContext('2d'));
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, MAP_W, MAP_H);
    const view = cv.viewBox();
    if (!view) return;
    // The map covers the content and wherever the view currently is.
    let [rx0, ry0, rx1, ry1] = this.box ? /** @type {number[]} */ (union(/** @type {any} */ (this.box), /** @type {any} */ (view))) : view;
    const pad = 0.04 * Math.max(rx1 - rx0, ry1 - ry0);
    rx0 -= pad; ry0 -= pad; rx1 += pad; ry1 += pad;
    const s = Math.min(MAP_W / (rx1 - rx0), MAP_H / (ry1 - ry0));
    const ox = (MAP_W - (rx1 - rx0) * s) / 2, oy = (MAP_H - (ry1 - ry0) * s) / 2;
    this.fit = [rx0, ry0, s, ox, oy];
    if (this.cells.size && this.box) {
      // In the panel's own text colour, so the blocks show in light and dark themes alike.
      ctx.fillStyle = getComputedStyle(this.el).color;
      ctx.globalAlpha = 0.55;
      const [bx, by] = this.box;
      const side = Math.max(this.cell * s + 0.6, 2.0);   // a little overlap, so neighbours read as one block
      for (const key of this.cells) {
        const [cx, cy] = key.split(',').map(Number);
        ctx.fillRect(ox + (bx + cx * this.cell - rx0) * s, oy + (by + cy * this.cell - ry0) * s, side, side);
      }
      ctx.globalAlpha = 1;
    }
    const x = ox + (view[0] - rx0) * s, y = oy + (view[1] - ry0) * s, w = (view[2] - view[0]) * s, hh = (view[3] - view[1]) * s;
    ctx.fillStyle = 'rgba(54,133,227,0.22)'; ctx.fillRect(x, y, w, hh);
    ctx.strokeStyle = 'rgba(54,133,227,0.9)'; ctx.lineWidth = 1.2; ctx.strokeRect(x, y, w, hh);
  }
}
