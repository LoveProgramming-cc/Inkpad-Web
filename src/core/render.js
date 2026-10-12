// @ts-check
// Rendering a page, a cover and the pictures made of them (B:model.py `render_page`, `render_cover`,
// `page_surface`, `export_png`).
import { drawItem, drawPaper } from './draw.js';
import { css, isDark } from './color.js';
import * as ptext from './ptext.js';
import { TAU } from './items.js';
import { pageBox } from './page.js';
import { setCoverRenderer } from './document.js';
import { createCanvas, context2d, toPng } from '../platform/canvas.js';

/** Highlighters multiply on light paper only, and not on a PDF page. @param {import('./page.js').Page} page */
export function inkOn(page) {
  return !page.pdf && isDark(page.color);
}

/**
 * Draw background and items; the context is in page points (its matrix has the zoom and at most a
 * small shift - the origin (ox, oy) is subtracted here, see draw.js).
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {import('./page.js').Page} page
 * @param {{printing?: boolean, paper?: boolean, ink?: boolean, ox?: number, oy?: number, perPixel?: number,
 *   background?: (ctx: any, page: import('./page.js').Page) => void, items?: any[]}} [o]
 *   background: draws the PDF page under the ink (it is rendered elsewhere, and cached)
 */
export function renderPage(ctx, page, { printing = false, paper = true, ink = true, ox = 0, oy = 0, perPixel = 1, background, items } = {}) {
  const box = pageBox(page);
  /** @type {import('./draw.js').Env} */
  const env = { ox, oy, perPixel, printing, onDark: inkOn(page) };
  if (!paper) {
    // nothing
  } else if (!page.pdf) {
    drawPaper(ctx, env, page, box);
  } else {
    if (!printing) {
      ctx.fillStyle = 'rgb(255,255,255)';
      ctx.fillRect(-ox, -oy, page.w, page.h);
    }
    background?.(ctx, page);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(box[0] - ox, box[1] - oy, box[2] - box[0], box[3] - box[1]);
  ctx.clip();
  if (ink) {
    if (!paper) env.onDark = true;   // nothing underneath to multiply with
    for (const it of items ?? page.items) drawItem(ctx, env, it);
  }
  ctx.restore();
}

/**
 * Raster of a page (a whiteboard's content); size=[w, h] letterboxes it into fixed pixels.
 * @param {import('./page.js').Page} page @param {number} scale
 * @param {{size?: number[]|null, paper?: boolean, ink?: boolean, background?: (ctx: any, page: import('./page.js').Page) => void}} [o]
 */
export function pageSurface(page, scale, { size = null, paper = true, ink = true, background } = {}) {
  const [x0, y0, x1, y1] = pageBox(page);
  let w, h, sx, sy, dx, dy;
  if (!size) {
    // An image has to stay a size that fits in memory, however far a whiteboard sprawls.
    scale = Math.min(scale, 12000 / Math.max(x1 - x0, y1 - y0));
    w = Math.max(1, Math.round((x1 - x0) * scale)); h = Math.max(1, Math.round((y1 - y0) * scale));
    sx = w / (x1 - x0); sy = h / (y1 - y0); dx = 0.0; dy = 0.0;
  } else {
    [w, h] = size;
    sx = sy = Math.min(w / (x1 - x0), h / (y1 - y0));
    dx = (w - (x1 - x0) * sx) / 2; dy = (h - (y1 - y0) * sy) / 2;
  }
  const canvas = createCanvas(w, h);
  const ctx = context2d(canvas);
  if (size) {
    ctx.fillStyle = css(page.color);
    ctx.fillRect(0, 0, w, h);
  }
  // The shift into the content's box is done on page coordinates (the origin), never as a matrix translate.
  ctx.setTransform(sx, 0, 0, sy, dx, dy);
  renderPage(ctx, page, { paper, ink, ox: x0, oy: y0, perPixel: 1 / Math.min(sx, sy), background });
  return canvas;
}

// -- covers ---------------------------------------------------------------------

function coverText(ctx, x, y, title, size, width, ink, alpha = 0.92) {
  ctx.fillStyle = css(ink, alpha);
  ptext.show(ctx, x, y, title, size, width);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.arc(x + w - r, y + r, r, -TAU / 4, 0);
  ctx.arc(x + w - r, y + h - r, r, 0, TAU / 4);
  ctx.arc(x + r, y + h - r, r, TAU / 4, TAU / 2);
  ctx.arc(x + r, y + r, r, TAU / 2, TAU * 3 / 4);
  ctx.closePath();
}

/** A notebook cover in one of COVER_STYLES, carrying the title.
 * @param {[string, number[]]} spec @param {string} title */
export function renderCover(spec, title, w = 225, h = 300) {
  const [style, color] = spec;
  const canvas = createCanvas(w, h);
  const ctx = context2d(canvas);
  const light = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2] > 0.6;
  const ink = light ? [0.12, 0.12, 0.14] : [1.0, 1.0, 1.0];
  const dark = color.map(c => c * 0.78);
  ctx.fillStyle = css(color);
  ctx.fillRect(0, 0, w, h);
  if (style === 'grid') {
    ctx.strokeStyle = css(ink, 0.10);
    ctx.lineWidth = 0.6;
    const step = w / 12;
    ctx.beginPath();
    for (let i = 1; i < 12; i++) { ctx.moveTo(i * step, 0); ctx.lineTo(i * step, h); }
    for (let i = 1; i <= Math.floor(h / step); i++) { ctx.moveTo(0, i * step); ctx.lineTo(w, i * step); }
    ctx.stroke();
    ctx.fillStyle = css(light ? [1, 1, 1] : dark);
    ctx.fillRect(w * 0.14, h * 0.12, w * 0.72, h * 0.20);
    coverText(ctx, w * 0.19, h * 0.17, title, w * 0.075, w * 0.62, light ? [0.12, 0.12, 0.14] : [1, 1, 1]);
  } else if (style === 'band') {
    ctx.fillStyle = css(dark);
    ctx.fillRect(0, h * 0.66, w, h * 0.34);
    ctx.fillStyle = css(ink, 0.5);
    ctx.fillRect(w * 0.14, h * 0.33, w * 0.16, 2.2);
    coverText(ctx, w * 0.14, h * 0.37, title, w * 0.09, w * 0.76, ink);
  } else if (style === 'ribbon') {
    // A loose ribbon looping across the cover, with a label for the title.
    const accent = !light ? [0.22, 0.70, 0.84] : color.map(c => c * 0.55);
    ctx.lineCap = 'round';
    ctx.lineWidth = w * 0.085;
    ctx.strokeStyle = css(accent);
    ctx.beginPath();
    ctx.moveTo(w * 0.20, -h * 0.05);
    ctx.bezierCurveTo(-w * 0.10, h * 0.30, w * 0.45, h * 0.52, w * 0.52, h * 0.36);
    ctx.bezierCurveTo(w * 0.58, h * 0.22, w * 0.30, h * 0.24, w * 0.42, h * 0.52);
    ctx.bezierCurveTo(w * 0.60, h * 0.92, w * 0.95, h * 0.70, w * 1.08, h * 0.98);
    ctx.stroke();
    ctx.fillStyle = css([1, 1, 1]);
    roundRect(ctx, w * 0.16, h * 0.39, w * 0.68, h * 0.21, 4);
    ctx.fill();
    coverText(ctx, w * 0.21, h * 0.425, title, w * 0.07, w * 0.58, [0.12, 0.12, 0.14]);
  } else if (style === 'label') {
    ctx.strokeStyle = css(ink, 0.28);
    ctx.lineWidth = 1;
    ctx.strokeRect(w * 0.09, h * 0.05, w * 0.84, h * 0.90);
    ctx.fillStyle = css([0.98, 0.97, 0.94]);
    roundRect(ctx, w * 0.20, h * 0.26, w * 0.62, h * 0.24, 3);
    ctx.fill();
    ctx.strokeStyle = css([0, 0, 0], 0.25);
    ctx.lineWidth = 0.8;
    roundRect(ctx, w * 0.225, h * 0.275, w * 0.57, h * 0.21, 2);
    ctx.stroke();
    coverText(ctx, w * 0.26, h * 0.32, title, w * 0.072, w * 0.50, [0.12, 0.12, 0.14]);
  } else {
    const left = w * 0.15;
    coverText(ctx, left, h * 0.13, title, w * 0.075, w * 0.75, ink);
    ctx.strokeStyle = css(ink, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, h * 0.30);
    ctx.lineTo(w * 0.9, h * 0.30);
    for (let i = 0; i < 3; i++) { ctx.moveTo(w * 0.72, h * (0.84 + i * 0.03)); ctx.lineTo(w * 0.9, h * (0.84 + i * 0.03)); }
    ctx.stroke();
  }
  // Shared finish: a soft sheen and the pale spine.
  const sheen = ctx.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = css([1, 1, 1], 0.92);
  ctx.fillRect(0, 0, w * 0.045, h);
  ctx.fillStyle = css([0, 0, 0], 0.16);
  ctx.fillRect(w * 0.045, 0, 1.5, h);
  return canvas;
}

/** Documents get their cover pictures from here. */
export function installCoverRenderer() {
  setCoverRenderer(async doc => {
    if (doc.coverSpec) return toPng(renderCover(doc.coverSpec, doc.displayName()));
    const page = doc.pages[0];
    const [x0, y0, x1, y1] = pageBox(page);
    const scale = 300 / Math.max(x1 - x0, y1 - y0);
    // A page with a PDF behind it has that rendered first (asynchronously), then drawn under the ink.
    const background = page.pdf ? await pdfBackground(page, scale) : undefined;
    // A board's content can have any shape; show it centred on a sheet of its paper.
    const canvas = page.board ? pageSurface(page, 0, { size: [300, 400] }) : pageSurface(page, scale, { background });
    return toPng(canvas);
  });
}

/** The PDF behind a page, drawn at a scale, as a function renderPage can call (it is rendered here, asynchronously).
 * @param {import('./page.js').Page} page @param {number} scale @returns {Promise<((ctx: any) => void)|undefined>} */
export async function pdfBackground(page, scale) {
  try {
    const { renderBackground } = await import('../editor/pdfqueue.js');
    const w = Math.max(1, Math.round(page.w * scale)), h = Math.max(1, Math.round(page.h * scale));
    const bg = await renderBackground(page, w, h, [0, 0, w / page.w, h / page.h]);
    return (/** @type {any} */ ctx) => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg, 0, 0); ctx.restore(); };
  } catch { return undefined; }
}

/** PNG of a page (B: export_png). @param {import('./page.js').Page} page */
export function exportPng(page, scale = 3.0, o = {}) {
  return toPng(pageSurface(page, scale, o));
}
