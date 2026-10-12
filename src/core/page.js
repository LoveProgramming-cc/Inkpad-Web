// @ts-check
// Pages (B:model.py `Page`, `page_box`) and the fixed lists of paper sizes, colours and kinds.
import { union } from './geom.js';
import { newId } from './items.js';

export const A4 = [595.0, 842.0];

export const SIZES = [['A4', [595.0, 842.0]], ['A5', [420.0, 595.0]], ['A3', [842.0, 1191.0]],
  ['B5', [499.0, 709.0]], ['Letter', [612.0, 792.0]]];
export const PAPER_COLORS = [['白色纸张', [1.0, 1.0, 1.0]], ['黄色纸张', [0.976, 0.965, 0.902]], ['深色纸张', [0.13, 0.13, 0.15]]];
export const COVER_STYLES = ['simple', 'label', 'ribbon', 'band', 'grid'];
export const COVER_COLORS = [[0.69, 0.61, 0.50], [0.13, 0.15, 0.27], [0.17, 0.27, 0.45], [0.24, 0.46, 0.38], [0.70, 0.26, 0.26],
  [0.33, 0.34, 0.37], [0.93, 0.75, 0.30], [0.89, 0.89, 0.88]];
export const PAPERS = [
  ['基本样式', [['blank', '空白'], ['dots', '点阵纸'], ['ruled', '窄行距'], ['wide', '宽行距'], ['grid', '方格纸']]],
  ['书写用纸', [['cornell', '康奈尔'], ['legal', '拍纸簿'], ['col2', '双栏'], ['col3', '三栏']]],
  ['日程与计划', [['todo', '待办清单'], ['weekly', '周计划']]],
  ['音乐与棋类', [['staff', '五线谱'], ['go', '围棋棋谱']]],
];

// A whiteboard has no edges at all: its items may lie anywhere, at negative coordinates
// too, and the canvas shows whatever part is looked at. The size below is only nominal; it
// gives a new board's first strokes coordinates of a comfortable magnitude.
export const BOARD_SIZE = [1e8, 1e8];

export class Page {
  /**
   * @param {object} [o]
   * @param {number} [o.w] @param {number} [o.h] @param {string} [o.paper]
   * @param {import('./pdfdoc.js').PdfDoc|null} [o.pdf] @param {number} [o.pdfPage]
   * @param {number[]} [o.color] @param {boolean} [o.board]
   */
  constructor({ w = A4[0], h = A4[1], paper = 'blank', pdf = null, pdfPage = 0, color = [1.0, 1.0, 1.0], board = false } = {}) {
    this.w = w; this.h = h;
    this.paper = paper;
    this.color = [...color];
    this.id = newId();
    this.rev = 0;               // counts changes to the items, so an unchanged page is not serialised again
    /** @type {Set<string>} */
    this.gone = new Set();      // ids of items removed from this page, kept so that a sync can tell
    /** @type {[number, string]|null} */
    this._blob = null;          // (rev, serialised items)
    this.board = board;         // a whiteboard: one very large page, shown and exported cropped to its content
    this.pdf = pdf;
    this.pdfPage = pdfPage;
    this.rot = 0;               // quarter turns applied to the PDF background
    this.bookmark = false;
    /** @type {string|null} */
    this.outline = null;        // outline title, if the page is in the outline
    /** @type {any[]} */
    this.items = [];
    this.mt = 0.0;              // when the settings above were last changed, for merging two versions
    /** @type {string|null} */
    this._sign = null;          // ...and what they were when that was last looked at
  }

  template() { return { w: this.w, h: this.h, paper: this.paper, color: this.color }; }

  blankLike() { return new Page({ w: this.w, h: this.h, paper: this.paper, color: this.color, board: this.board }); }

  clone() {
    const page = new Page({ w: this.w, h: this.h, paper: this.paper, pdf: this.pdf, pdfPage: this.pdfPage, color: this.color, board: this.board });
    page.rot = this.rot;
    page.items = this.items.map(it => it.transformed(1, 0, 0, 0, 0));
    return page;
  }

  /** A copy turned k quarter turns clockwise, content included. Pictures must have been
   * prepared with `prepareRotation` (items.js) first. @param {number} k */
  rotated(k) {
    const [w, h] = k % 2 ? [this.h, this.w] : [this.w, this.h];
    const page = new Page({ w, h, paper: this.paper, pdf: this.pdf, pdfPage: this.pdfPage, color: this.color, board: this.board });
    page.rot = (this.rot + k) % 4;
    page.bookmark = this.bookmark; page.outline = this.outline;
    page.items = this.items.map(it => it.rotated(k, this.w, this.h));
    return page;
  }
}

/** The part of a page worth showing: all of it, or a whiteboard's content. @param {Page} page */
export function pageBox(page) {
  if (!page.board) return [0.0, 0.0, page.w, page.h];
  /** @type {number[]|null} */
  let box = null;
  for (const it of page.items) box = union(/** @type {any} */ (box), it.bbox);
  if (box === null) return [page.w / 2 - 400, page.h / 2 - 300, page.w / 2 + 400, page.h / 2 + 300];
  // Pad, and keep a sensible minimum size and shape.
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const w = Math.max(box[2] - box[0] + 80, 400), h = Math.max(box[3] - box[1] + 80, 300);
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}
