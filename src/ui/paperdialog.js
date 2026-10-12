// @ts-check
// Pick page size, paper colour, orientation and a template (B:dialogs.PaperDialog).
// With `title` (a string, possibly empty) the dialog also asks for a name, as when creating a
// notebook; `board` is the whiteboard variant: fixed large canvas, background style and colour only.
import { h } from './ui.js';
import { showDialog } from './dialog.js';
import { coverPicker } from './coverpicker.js';
import { PAPERS, PAPER_COLORS, SIZES, BOARD_SIZE, Page } from '../core/page.js';
import { drawPaper } from '../core/draw.js';
import { segmented, select } from './controls.js';
import { tr } from '../core/i18n.js';

const PREVIEW_W = 96;

/** A page of the paper, as small as it is shown. @param {string} kind @param {any} t @param {number} maxW @param {number} maxH @param {boolean} board */
function preview(kind, t, maxW, maxH, board) {
  const dpr = window.devicePixelRatio || 1;
  // A whiteboard has no edges: show a patch of its background.
  const page = board ? new Page({ w: maxW * 2.2, h: maxH * 2.2, paper: kind, color: t.color, board: true }) : new Page({ w: t.w, h: t.h, paper: kind, color: t.color });
  const k = Math.min(maxW / page.w, maxH / page.h);
  const w = Math.round(page.w * k), hh = Math.round(page.h * k);
  const canvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'thumb', width: Math.round(w * dpr), height: Math.round(hh * dpr), style: { width: w + 'px', height: hh + 'px' } }));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(w * dpr / page.w, 0, 0, hh * dpr / page.h, 0, 0);
  drawPaper(ctx, { ox: 0, oy: 0, perPixel: page.w / (w * dpr) }, page);
  return canvas;
}

/**
 * @param {object} o
 * @param {{w: number, h: number, paper: string, color: number[]}} o.template
 * @param {string} [o.heading] @param {string} [o.applyLabel] @param {string|null} [o.title] @param {boolean} [o.board]
 * @returns {Promise<{template: any, title: string, cover: [string, number[]]|null}|null>}
 */
export async function paperDialog({ template, heading = tr('纸张样式'), applyLabel = tr('应用'), title = null, board = false }) {
  const { w, h: hh } = template;
  const short = Math.min(w, hh), long = Math.max(w, hh);
  const state = {
    landscape: w > hh,
    size: Math.max(0, SIZES.findIndex(([, s]) => Math.abs(s[0] - short) < 2 && Math.abs(s[1] - long) < 2)),
    color: Math.max(0, PAPER_COLORS.findIndex(([, c]) => Math.max(...c.map((a, i) => Math.abs(a - template.color[i]))) < 0.02)),
    paper: template.paper,
    /** @type {[string, number[]]|null} */ cover: null,
  };
  const tmpl = () => {
    const color = PAPER_COLORS[state.color][1];
    if (board) return { w: BOARD_SIZE[0], h: BOARD_SIZE[1], paper: state.paper, color, board: true };
    let [pw, ph] = SIZES[state.size][1];
    if (state.landscape) [pw, ph] = [ph, pw];
    return { w: pw, h: ph, paper: state.paper, color };
  };
  /** @type {HTMLInputElement|null} */
  let nameInput = null;
  const grid = h('div', { class: 'papers' });
  const big = h('div', { class: 'big-preview' });
  const render = () => {
    const t = tmpl();
    grid.replaceChildren();
    const groups = board ? [[PAPERS[0][0], PAPERS[0][1].filter(k => k[0] !== 'wide')]] : PAPERS;
    for (const [group, kinds] of /** @type {[string, [string, string][]][]} */ (groups)) {
      grid.append(h('div', { class: 'heading' }, tr(group)));
      grid.append(h('div', { class: 'paper-row' }, kinds.map(([kind, name]) =>
        h('button', { class: 'paper-cell flat', 'aria-pressed': String(kind === state.paper), onClick: () => { state.paper = kind; render(); } },
          h('span', { class: 'paper-frame' }, preview(kind, t, PREVIEW_W, 128, board)), h('span', null, tr(name))))));
    }
    big.replaceChildren(preview(state.paper, t, 150, 200, board));
  };
  const options = h('div', { class: 'row paper-options' },
    !board && select(SIZES.map(([name], i) => ({ label: name, value: i })), state.size, v => { state.size = v; render(); }),
    select(PAPER_COLORS.map(([name], i) => ({ label: tr(name), value: i })), state.color, v => { state.color = v; render(); }),
    !board && segmented([{ label: tr('竖向'), value: false }, { label: tr('横向'), value: true }], state.landscape, v => { state.landscape = v; render(); }));
  return showDialog({
    title: heading, className: 'paper-dialog', width: title !== null ? '820px' : '660px', dismissed: null,
    headStart: close => [h('button', { onClick: () => close(null) }, tr('取消'))],
    headEnd: close => [h('button', { class: 'suggested', onClick: () => close({ template: tmpl(), title: nameInput ? nameInput.value.trim() : '', cover: state.cover }) }, applyLabel)],
    build: close => {
      const left = title !== null ? h('div', { class: 'dialog-side col' },
        h('div', { class: 'heading' }, tr('标题')),
        nameInput = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: title, placeholder: board ? tr('未命名的白板') : tr('无标题的笔记本'),
          onKeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !e.isComposing) close({ template: tmpl(), title: /** @type {HTMLInputElement} */ (nameInput).value.trim(), cover: state.cover }); } })),
        !board && h('div', { class: 'heading', style: { marginTop: '14px' } }, tr('封面')),
        !board && coverPicker(null, c => { state.cover = c; }),
        h('div', { class: 'heading', style: { marginTop: '14px' } }, board ? tr('背景') : tr('纸张样式')),
        big) : null;
      render();
      return h('div', { class: 'paper-body' }, left, h('div', { class: 'paper-right' }, options, h('div', { class: 'sep' }), h('div', { class: 'scroll paper-scroll' }, grid)));
    },
  }).then(r => r ?? null);
}
