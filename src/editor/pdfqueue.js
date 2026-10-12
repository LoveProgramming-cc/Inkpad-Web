// @ts-check
// Rasterising PDF page backgrounds off the drawing path (B:render.py `Worker`, canvas.py
// `_request_bg`, `_bg_ready`, `_prefetch`; PORTING.md 7.1).
//
// Requests go into a priority queue (visible pages 0, pages just outside 1-3; within a priority the
// newest request first). One render runs at a time; a request that is out of date when its turn
// comes (the page was scrolled far away, or asked for again) is skipped, and a running one is
// cancelled with pdf.js's renderTask.cancel(). The last BG_KEEP rendered backgrounds are remembered.
import { BG_KEEP, MAX_PIXELS } from './canvas.js';
import { createCanvas, context2d } from '../platform/canvas.js';

/** @typedef {{priority: number, seq: number, valid: () => boolean, run: () => Promise<void>}} Job */

/** The matrix taking a PDF page's points to the pixels of a window: scale, then the rotation the
 * notebook page applies to its background (B:model.render_pdf_bg), then minus the window origin.
 * @param {number} rot quarter turns @param {number} ow @param {number} oh the PDF page's own size
 * @param {number} sx @param {number} sy @param {number} ox @param {number} oy @returns {number[]} */
export function pdfMatrix(rot, ow, oh, sx, sy, ox, oy) {
  const k = rot % 4;
  // p' = R p + T  with R = rotation by k quarter turns, T as in B
  const [c, s] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
  const [tx, ty] = [[0, 0], [oh, 0], [ow, oh], [0, ow]][k];
  // device = S (R p + T) - o
  return [sx * c, sy * s, -sx * s, sy * c, sx * tx - ox, sy * ty - oy];
}

class Queue {
  constructor() {
    /** @type {Job[]} */ this.jobs = [];
    this.seq = 0;
    this.busy = false;
  }

  /** @param {number} priority @param {() => boolean} valid @param {() => Promise<void>} run */
  submit(priority, valid, run) {
    this.jobs.push({ priority, seq: this.seq++, valid, run });
    this.pump();
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        // Within a priority the newest request goes first: it is what is on screen now.
        this.jobs.sort((a, b) => a.priority - b.priority || b.seq - a.seq);
        const job = this.jobs.shift();
        if (!job) break;
        try {
          if (!job.valid()) continue;
          await job.run();
        } catch (e) {
          if (!(e && /** @type {any} */ (e).name === 'RenderingCancelledException')) console.error('inkpad: pdf render failed:', e);   // a broken page must not stop the queue
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

const queue = new Queue();

/** Render a page's PDF background into a new canvas of pw x ph pixels, white underneath.
 * view = [ox, oy, sx, sy] renders the window at pixel offset (ox, oy) of the page scaled by (sx, sy).
 * @param {any} page @param {number} pw @param {number} ph @param {number[]} view */
export async function renderBackground(page, pw, ph, view) {
  const canvas = createCanvas(pw, ph);
  const ctx = context2d(canvas, false);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, pw, ph);
  const [ow, oh] = await page.pdf.pageSize(page.pdfPage);
  const task = await page.pdf.render(page.pdfPage, ctx, pdfMatrix(page.rot, ow, oh, view[2], view[3], view[0], view[1]));
  await task.promise;
  return canvas;
}

/** What a PageCanvas asks for PDF backgrounds (canvas.bgSource). */
export const bgSource = {
  /** Have a PDF page's background rendered, unless that is done or under way.
   * @param {import('./canvas.js').PageCanvas} cv @param {any} page @param {number} i @param {number[]} full @param {number} priority */
  request(cv, page, i, full, priority) {
    const pending = cv.pending.get(page);
    if (pending && pending.full[0] === full[0] && pending.full[1] === full[1] && (priority || cv._covers(pending.win, page, i, full))) return;
    const win = cv._window(page, i, full);
    const key = full[0] + 'x' + full[1] + '@' + win.join(',');
    const ready = cv.bgs.get(page)?.get(key);
    if (ready) {
      // Rendered before and still remembered: no waiting, no white page.
      cv.bgs.get(page).delete(key); cv.bgs.get(page).set(key, ready);
      cv.pending.delete(page);
      cv._build(page, full, win, ready);
      return;
    }
    const mark = { full, win, key };
    cv.pending.set(page, mark);
    queue.submit(priority, () => {
      if (cv.pending.get(page) !== mark) return false;
      if (!bgSource.near(cv, page)) { cv.pending.delete(page); return false; }   // scrolled far away while this waited in line: drop it, it can be asked for again
      return true;
    }, async () => {
      const bg = await renderBackground(page, win[2], win[3], [win[0], win[1], full[0] / page.w, full[1] / page.h]);
      bgSource.ready(cv, page, mark, bg);
    });
  },

  /** @param {import('./canvas.js').PageCanvas} cv @param {any} page */
  near(cv, page) {
    const i = cv._index(page);
    return i !== null && cv.shown[0] - 3 <= i && i <= cv.shown[1] + 3;
  },

  /** @param {import('./canvas.js').PageCanvas} cv @param {any} page @param {any} mark @param {any} bg */
  ready(cv, page, mark, bg) {
    let per = cv.bgs.get(page);
    if (!per) { per = new Map(); cv.bgs.set(page, per); }
    per.set(mark.key, bg);
    // remembered backgrounds: the last BG_KEEP of them, counted over all pages
    let total = 0;
    for (const m of cv.bgs.values()) total += m.size;
    while (total > BG_KEEP) {
      const [p0, m0] = cv.bgs.entries().next().value;
      const k0 = m0.keys().next().value;
      m0.delete(k0); total--;
      if (!m0.size) cv.bgs.delete(p0);
    }
    if (cv.pending.get(page) !== mark) return;
    cv.pending.delete(page);
    if (cv._index(page) !== null) { cv._build(page, mark.full, mark.win, bg); cv.queueDraw(); }
  },

  /** Render the pages just outside the view ahead of time, so scrolling meets no blanks. @param {import('./canvas.js').PageCanvas} cv @param {number} first @param {number} last */
  prefetch(cv, first, last) {
    const pages = /** @type {NonNullable<typeof cv.doc>} */ (cv.doc).pages;
    [last + 1, first - 1, last + 2].forEach((i, step) => {
      if (i >= 0 && i < pages.length && pages[i].pdf) {
        const page = pages[i];
        const full = cv._fullSize(page);
        const entry = cv.cache.get(page);
        if (full[0] * full[1] <= MAX_PIXELS && (!entry || entry.full[0] !== full[0] || entry.full[1] !== full[1])) bgSource.request(cv, page, i, full, 1 + step);
      }
    });
  },
};
