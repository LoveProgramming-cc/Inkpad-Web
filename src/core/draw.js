// @ts-check
// Drawing the things on a page. Translated from the `draw` methods and helpers of B:model.py.
//
// Every function takes `env = {ox, oy, perPixel, onDark, printing}` and draws page point (x, y)
// at (x - ox, y - oy) on the context. The origin is subtracted here, in doubles, and never left
// to the context's matrix, which is single precision: a whiteboard's coordinates are around
// 5e7 and would shake and slip if translated by the matrix (PORTING.md R3, 7.1).
//   ox, oy      page coordinates of the context's (0, 0)
//   perPixel    page points per device pixel (1 / (zoom * dpr)), for the far-away simplification
//   onDark      highlighters do not multiply on dark paper
//   printing    writing a PDF: nothing is simplified
import * as ptext from './ptext.js';
import { css } from './color.js';
import { HL_ALPHA, TAU, Image, Shape, Stroke, Text, dashRuns } from './items.js';
import { pageBox } from './page.js';
import { tr } from './i18n.js';

/**
 * @typedef {object} Env
 * @property {number} ox @property {number} oy @property {number} perPixel
 * @property {boolean} [onDark] @property {boolean} [printing]
 * @typedef {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} Ctx
 */

/** Quadratic midpoint smoothing through the sampled points. @param {Ctx} ctx @param {Env} env @param {number[][]} pts */
function smoothPath(ctx, env, pts) {
  const { ox, oy } = env;
  let px = pts[0][0], py = pts[0][1];
  ctx.moveTo(px - ox, py - oy);
  const n = pts.length;
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[i][0], cy = pts[i][1];
    const mx = (cx + pts[i + 1][0]) / 2, my = (cy + pts[i + 1][1]) / 2;
    ctx.bezierCurveTo(px + (cx - px) * 2 / 3 - ox, py + (cy - py) * 2 / 3 - oy,
      mx + (cx - mx) * 2 / 3 - ox, my + (cy - my) * 2 / 3 - oy, mx - ox, my - oy);
    px = mx; py = my;
  }
  ctx.lineTo(pts[n - 1][0] - ox, pts[n - 1][1] - oy);
}

/** @param {Ctx} ctx @param {Env} env @param {Stroke} s @param {number[][]} pts */
function drawRun(ctx, env, s, pts) {
  const { ox, oy } = env;
  const n = pts.length;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] - ox, pts[0][1] - oy, s.wAt(pts[0][2]) / 2, 0, TAU);
    ctx.fill();
  } else if (s.tool === 'hl' || s.tool === 'ball') {
    ctx.lineWidth = s.width;
    ctx.beginPath();
    smoothPath(ctx, env, pts);
    ctx.stroke();
  } else {
    // Pressure-sensitive: one short segment per sample, each its own width.
    let px = pts[0][0], py = pts[0][1], pp = pts[0][2];
    for (let i = 1; i < n; i++) {
      const cx = pts[i][0], cy = pts[i][1], cp = pts[i][2];
      ctx.beginPath();
      ctx.moveTo(px - ox, py - oy);
      let mx, my;
      if (i < n - 1) {
        mx = (cx + pts[i + 1][0]) / 2; my = (cy + pts[i + 1][1]) / 2;
        ctx.bezierCurveTo(px + (cx - px) * 2 / 3 - ox, py + (cy - py) * 2 / 3 - oy,
          mx + (cx - mx) * 2 / 3 - ox, my + (cy - my) * 2 / 3 - oy, mx - ox, my - oy);
      } else {
        mx = cx; my = cy;
        ctx.lineTo(cx - ox, cy - oy);
      }
      ctx.lineWidth = (s.wAt(pp) + s.wAt(cp)) / 2;
      ctx.stroke();
      px = mx; py = my; pp = cp;
    }
  }
}

/** @param {Ctx} ctx @param {Env} env @param {Stroke} s */
export function drawStroke(ctx, env, s) {
  const pts = s.pts;
  if (!pts.length) return;
  const { ox, oy } = env;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const hl = s.tool === 'hl';
  if (s.tool === 'tape') {
    // Tape covers what is under it; lifted, only a trace of it is left.
    ctx.strokeStyle = css(s.color, s.open ? 0.16 : 1.0);
    ctx.lineWidth = s.width;
    ctx.beginPath();
    smoothPath(ctx, env, pts.length > 1 ? pts : [pts[0], pts[0]]);
    ctx.stroke();
    return;
  }
  if (hl) {
    ctx.save();
    // Multiplying darkens, which is what a marker does on light paper but would make it
    // invisible on a dark one.
    if (!env.onDark) ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = ctx.fillStyle = css(s.color, HL_ALPHA);
  } else {
    ctx.strokeStyle = ctx.fillStyle = css(s.color);
  }
  const perPixel = env.perPixel;
  if (perPixel > 1.5 && !env.printing) {
    // Seen from far away: no pressure detail and no points closer together than a pixel, and
    // never thinner than a hairline, so the stroke stays visible and cheap to draw.
    const step2 = perPixel * perPixel;
    let lx = pts[0][0], ly = pts[0][1];
    ctx.beginPath();
    ctx.moveTo(lx - ox, ly - oy);
    for (let i = 1; i < pts.length - 1; i++) {
      const x = pts[i][0], y = pts[i][1];
      if ((x - lx) ** 2 + (y - ly) ** 2 >= step2) {
        ctx.lineTo(x - ox, y - oy);
        lx = x; ly = y;
      }
    }
    ctx.lineTo(pts[pts.length - 1][0] + 0.001 - ox, pts[pts.length - 1][1] - oy);
    ctx.lineWidth = Math.max(s.width, perPixel * 0.9);
    ctx.stroke();
  } else if (s.dash && pts.length > 1) {
    const w = s.width;
    const [on, off] = s.dash === 1 ? [Math.max(3.0 * w, 2.5), Math.max(2.6 * w, 3.0)] : [0.0, Math.max(2.4 * w, 2.5)];
    for (const run of dashRuns(pts, on, off)) drawRun(ctx, env, s, run);
  } else {
    drawRun(ctx, env, s, pts);
  }
  if (hl) ctx.restore();
}

/** @param {Ctx} ctx @param {Env} env @param {Shape} s */
export function drawShape(ctx, env, s) {
  const { ox, oy } = env;
  const { x0, y0, x1, y1 } = s;
  ctx.strokeStyle = css(s.color);
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (s.shape === 'rect') {
    ctx.rect(Math.min(x0, x1) - ox, Math.min(y0, y1) - oy, Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (s.shape === 'ellipse') {
    const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    if (rx > 0.01 && ry > 0.01) ctx.ellipse((x0 + x1) / 2 - ox, (y0 + y1) / 2 - oy, rx, ry, 0, 0, TAU);
  } else {
    ctx.moveTo(x0 - ox, y0 - oy);
    ctx.lineTo(x1 - ox, y1 - oy);
    if (s.shape === 'arrow') {
      const a = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(8.0, s.width * 4);
      for (const da of [2.6, -2.6]) {
        ctx.moveTo(x1 - ox, y1 - oy);
        ctx.lineTo(x1 + head * Math.cos(a + da) - ox, y1 + head * Math.sin(a + da) - oy);
      }
    }
  }
  ctx.stroke();
}

/** @param {Ctx} ctx @param {Env} env @param {Text} t */
export function drawText(ctx, env, t) {
  const { ox, oy } = env;
  if (t.bg) {
    const [x0, y0, x1, y1] = t.bbox;
    const fold = Math.min(t.size * 0.9, (x1 - x0) / 4, (y1 - y0) / 4);
    ctx.beginPath();
    ctx.moveTo(x0 - ox, y0 - oy);
    ctx.lineTo(x1 - ox, y0 - oy);
    ctx.lineTo(x1 - ox, y1 - fold - oy);
    ctx.lineTo(x1 - fold - ox, y1 - oy);
    ctx.lineTo(x0 - ox, y1 - oy);
    ctx.closePath();
    ctx.fillStyle = css(t.bg);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x1 - ox, y1 - fold - oy);
    ctx.lineTo(x1 - fold - ox, y1 - fold - oy);
    ctx.lineTo(x1 - fold - ox, y1 - oy);
    ctx.closePath();
    ctx.fillStyle = css(t.bg.map(c => c * 0.86));
    ctx.fill();
  }
  ctx.fillStyle = css(t.color);
  ptext.show(ctx, t.x - ox, t.y - oy, t.text, t.size, t.wrap);
}

/** @param {Ctx} ctx @param {Env} env @param {Image} im */
export function drawImage(ctx, env, im) {
  if (im.bitmap) ctx.drawImage(im.bitmap, im.x - env.ox, im.y - env.oy, im.w, im.h);
}

/** @param {Ctx} ctx @param {Env} env @param {any} item */
export function drawItem(ctx, env, item) {
  switch (item.kind) {
    case 's': return drawStroke(ctx, env, item);
    case 'h': return drawShape(ctx, env, item);
    case 't': return drawText(ctx, env, item);
    case 'i': return drawImage(ctx, env, item);
  }
}

// -- paper ----------------------------------------------------------------------

/** Rule colour that suits a paper colour. @param {number[]} c */
function rule(c, strong = false) {
  if ((c[0] + c[1] + c[2]) / 3 > 0.5) {
    const k = strong ? 0.72 : 1.0;
    return [c[0] * 0.80 * k, c[1] * 0.84 * k, c[2] * 0.90 * k];
  }
  const lift = strong ? 0.38 : 0.2;
  return c.map(v => Math.min(1.0, v + lift));
}

/** @param {Ctx} ctx @param {Env} env */
function hlines(ctx, env, x0, x1, y0, y1, step, top = null) {
  let y = y0;
  if (top !== null && top > y0) y = y0 + Math.ceil((top - y0) / step) * step;
  while (y <= y1) {
    ctx.moveTo(x0 - env.ox, y - env.oy);
    ctx.lineTo(x1 - env.ox, y - env.oy);
    y += step;
  }
}

/** A whiteboard's background over box. The board has no edges, so the pattern simply continues
 * wherever it is looked at, negative coordinates included. @param {Ctx} ctx @param {Env} env */
function boardPaper(ctx, env, page, box) {
  const { ox, oy } = env;
  const [x0, y0, x1, y1] = box;
  ctx.fillStyle = css(page.color);
  ctx.fillRect(x0 - ox, y0 - oy, x1 - x0, y1 - y0);
  const kind = page.paper;
  if (kind === 'blank') return;
  /** @type {Record<string, number>} */
  const pitches = { dots: 20.0, grid: 20.0, wide: 32.0 };
  let pitch = pitches[kind] ?? 22.0;
  // Seen from far away the pattern would be millions of marks closer together than a pixel:
  // thin the dots out, and leave rulings off altogether.
  const perPixel = env.perPixel || 1.0;
  let scale = 1.0;
  if (pitch / perPixel < 6) {
    if (kind !== 'dots') return;
    scale = 2 ** Math.ceil(Math.log2(6 * perPixel / pitch));
    pitch *= scale;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0 - ox, y0 - oy, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = ctx.fillStyle = css(rule(page.color));
  ctx.lineWidth = 0.5;
  const fx = Math.floor(x0 / pitch) * pitch, fy = Math.floor(y0 / pitch) * pitch;
  ctx.beginPath();
  if (kind === 'dots') {
    const size = 1.6 * scale;
    for (let y = fy; y < y1 + 1; y += pitch) {
      for (let x = fx; x < x1 + 1; x += pitch) ctx.rect(x - size / 2 - ox, y - size / 2 - oy, size, size);
    }
    ctx.fill();
  } else {
    for (let y = fy; y < y1 + 1; y += pitch) {
      ctx.moveTo(x0 - ox, y - oy);
      ctx.lineTo(x1 - ox, y - oy);
    }
    if (kind === 'grid') {
      for (let x = fx; x < x1 + 1; x += pitch) {
        ctx.moveTo(x - ox, y0 - oy);
        ctx.lineTo(x - ox, y1 - oy);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Paint the paper; `box` limits the work to one area of the page.
 * @param {Ctx} ctx @param {Env} env @param {import('./page.js').Page} page @param {number[]} [box] */
export function drawPaper(ctx, env, page, box) {
  if (page.board) { boardPaper(ctx, env, page, box || pageBox(page)); return; }
  const { ox, oy } = env;
  const { w, h } = page;
  const kind = page.paper;
  let [bx0, by0, bx1, by1] = box || [0.0, 0.0, w, h];
  bx0 = Math.max(0.0, bx0); by0 = Math.max(0.0, by0); bx1 = Math.min(w, bx1); by1 = Math.min(h, by1);
  ctx.fillStyle = css(page.color);
  ctx.fillRect(bx0 - ox, by0 - oy, bx1 - bx0, by1 - by0);
  if (kind === 'blank') return;
  const pitch = 20.0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx0 - ox, by0 - oy, bx1 - bx0, by1 - by0);
  ctx.clip();
  ctx.lineCap = 'butt';
  const ruleColor = css(rule(page.color));
  ctx.strokeStyle = ctx.fillStyle = ruleColor;
  ctx.lineWidth = 0.5;
  const strong = css(rule(page.color, true));
  const line = (/** @type {number} */ ax, /** @type {number} */ ay, /** @type {number} */ bx, /** @type {number} */ by) => {
    ctx.moveTo(ax - ox, ay - oy);
    ctx.lineTo(bx - ox, by - oy);
  };
  ctx.beginPath();
  if (kind === 'dots') {
    const size = 1.2;
    for (let y = Math.max(pitch, Math.floor(by0 / pitch) * pitch); y < by1 + 1; y += pitch) {
      for (let x = Math.max(pitch, Math.floor(bx0 / pitch) * pitch); x < bx1 + 1; x += pitch) {
        ctx.rect(x - size / 2 - ox, y - size / 2 - oy, size, size);
      }
    }
    ctx.fill();
  } else if (kind === 'grid') {
    hlines(ctx, env, bx0, bx1, 20, by1, 20, by0);
    for (let x = Math.max(20.0, Math.floor(bx0 / 20) * 20); x < bx1 + 1; x += 20) line(x, by0, x, by1);
    ctx.stroke();
  } else if (kind === 'cornell') {
    const top = h * 0.09, cue = w * 0.28, bottom = h * 0.80;
    hlines(ctx, env, 0, w, top + 22, bottom - 4, 22);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = strong;
    ctx.lineWidth = 0.9;
    hlines(ctx, env, 0, w, top, top, 1);
    hlines(ctx, env, 0, w, bottom, bottom, 1);
    line(cue, top, cue, bottom);
    ctx.stroke();
  } else if (kind === 'todo') {
    for (let y = 92.0; y < h - 36; y += 28) {
      ctx.rect(36 - ox, y - 11 - oy, 10, 10);
      line(56, y, w - 36, y);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = strong;
    ctx.lineWidth = 0.9;
    hlines(ctx, env, 36, w - 36, 60, 60, 1);
    ctx.stroke();
  } else if (kind === 'weekly') {
    const m = 30.0, top = 56.0;
    const cw = (w - 2 * m) / 2, ch = (h - top - m) / 4;
    ctx.strokeStyle = ctx.fillStyle = strong;
    ctx.lineWidth = 0.8;
    ['周一', '周二', '周三', '周四', '周五', '周六', '周日', '备注'].forEach((name, n) => {
      const x = m + (n % 2) * cw, y = top + Math.floor(n / 2) * ch;
      ctx.beginPath();
      ctx.rect(x - ox, y - oy, cw, ch);
      ctx.stroke();
      ptext.show(ctx, x + 6 - ox, y + 5 - oy, tr(name), 9);
    });
  } else if (kind === 'staff') {
    // Music manuscript: staves of five lines.
    ctx.strokeStyle = strong;
    ctx.lineWidth = 0.6;
    const gap = 7.0, step = 7.0 * 4 + 38;
    for (let y = 78.0; y + gap * 4 < h - 44; y += step) {
      for (let i = 0; i < 5; i++) line(42, y + i * gap, w - 42, y + i * gap);
      line(42, y, 42, y + gap * 4);
      line(w - 42, y, w - 42, y + gap * 4);
    }
    ctx.stroke();
  } else if (kind === 'go') {
    // A 19 x 19 goban with star points, and lines underneath for commentary.
    const side = Math.min(w - 80, (h - 130) * 0.74);
    const cell = side / 18;
    const x0 = (w - side) / 2, y0 = 64.0;
    ctx.strokeStyle = ctx.fillStyle = strong;
    ctx.lineWidth = 0.55;
    for (let i = 0; i < 19; i++) {
      line(x0 + i * cell, y0, x0 + i * cell, y0 + side);
      line(x0, y0 + i * cell, x0 + side, y0 + i * cell);
    }
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.rect(x0 - ox, y0 - oy, side, side);
    ctx.stroke();
    for (const i of [3, 9, 15]) {
      for (const j of [3, 9, 15]) {
        ctx.beginPath();
        ctx.arc(x0 + i * cell - ox, y0 + j * cell - oy, Math.max(1.3, cell * 0.11), 0, TAU);
        ctx.fill();
      }
    }
    ctx.strokeStyle = ruleColor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    hlines(ctx, env, x0, x0 + side, y0 + side + 34, h - 30, 22);
    ctx.stroke();
  } else {
    const wide = kind === 'wide';
    const first = kind === 'legal' ? 70.0 : 50.0;
    hlines(ctx, env, bx0, bx1, first, Math.min(h - 8, by1), wide ? 32 : 22, by0);
    ctx.stroke();
    if (kind === 'legal') {
      ctx.strokeStyle = css([0.86, 0.42, 0.42]);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (const x of [w * 0.13, w * 0.13 + 3]) line(x, 0, x, h);
      ctx.stroke();
    } else if (kind === 'col2' || kind === 'col3') {
      const n = Number(kind[3]);
      ctx.strokeStyle = strong;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let i = 1; i < n; i++) line(w * i / n, 36, w * i / n, h - 24);
      ctx.stroke();
    }
  }
  ctx.restore();
}
