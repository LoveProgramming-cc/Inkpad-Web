// @ts-check
// An embedded PDF whose pages serve as backgrounds (B:pdf.py, poppler there; pdf.js here).
// pdf.js is loaded only when a PDF page is first needed (PORTING.md 7.4): opening a notebook never
// needs it, because the pages' sizes are in document.json.
import { crc32Blob, sha256Blob } from './hash.js';
import { tr } from './i18n.js';

const VENDOR = typeof document !== 'undefined' ? new URL('../vendor/pdfjs/', import.meta.url).href : '';
let pdfjsPromise = null;

/** Load pdf.js once. */
function loadPdfjs() {
  return (pdfjsPromise ??= import(/* @vite-ignore */ VENDOR + 'pdf.min.mjs').then(m => {
    m.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';
    return m;
  }));
}

export class PdfDoc {
  /**
   * @param {Blob} blob the PDF's bytes
   * @param {string} key  `${size}/${crc32}`: something two copies of the same PDF have in common,
   *   for finding them quickly. Whether they are the same is settled by comparing their content.
   *   A notebook holds a PDF once however many times it was imported into it, or came into it
   *   with pages merged from another device.
   */
  constructor(blob, key) {
    this.blob = blob;
    this.key = key;
    /** @type {Promise<string>|null} */
    this._sha = null;
    /** @type {Promise<any>|null} */
    this._doc = null;
    /** @type {Map<number, [number, number]>} */
    this._sizes = new Map();
    /** @type {Map<number, Promise<any>>} */
    this._pages = new Map();
  }

  /** Reads the key from the bytes themselves (an imported file; a zip already knows its CRCs). @param {Blob} blob */
  static async fromBlob(blob) {
    return new PdfDoc(blob, `${blob.size}/${await crc32Blob(blob)}`);
  }

  /** SHA-256 of the content, worked out once. Two PDFs with the same size, CRC and hash are the same file. */
  sha256() {
    return (this._sha ??= sha256Blob(this.blob));
  }

  /** @param {PdfDoc} other */
  async sameAs(other) {
    return this === other || (this.key === other.key && (await this.sha256()) === (await other.sha256()));
  }

  /** Open the document (once). pdf.js is told to look for CJK character maps and the standard fonts
   * here: without them Chinese and Japanese PDFs come out blank. @returns {Promise<any>} */
  open() {
    return (this._doc ??= (async () => {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await this.blob.arrayBuffer());
      try {
        return await pdfjs.getDocument({ data, cMapUrl: VENDOR + 'cmaps/', cMapPacked: true, standardFontDataUrl: VENDOR + 'standard_fonts/', isEvalSupported: false }).promise;
      } catch (e) {
        this._doc = null;
        throw new Error(tr('PDF 无法打开') + ((/** @type {any} */ (e))?.message ? ': ' + (/** @type {any} */ (e)).message : ''));
      }
    })());
  }

  async nPages() { return (await this.open()).numPages; }

  /** @param {number} i @returns {Promise<any>} */
  _page(i) {
    let p = this._pages.get(i);
    if (!p) { p = this.open().then(d => d.getPage(i + 1)); this._pages.set(i, p); }
    return p;
  }

  /** Size in points, with the page's own rotation in it. @param {number} i @returns {Promise<[number, number]>} */
  async pageSize(i) {
    let size = this._sizes.get(i);
    if (!size) {
      const page = await this._page(i);
      const vp = page.getViewport({ scale: 1 });
      size = [vp.width, vp.height];
      this._sizes.set(i, size);
    }
    return size;
  }

  /**
   * Draw a page. `transform` is the 6-number matrix from page points to device pixels of `ctx`.
   * Returns a task whose `promise` settles when it is drawn and whose `cancel()` stops it.
   * @param {number} i @param {any} ctx @param {number[]} transform @param {boolean} [printing]
   * @returns {Promise<{promise: Promise<void>, cancel: () => void}>}
   */
  async render(i, ctx, transform, printing = false) {
    const page = await this._page(i);
    const viewport = page.getViewport({ scale: 1 });
    const task = page.render({ canvasContext: ctx, viewport, transform, intent: printing ? 'print' : 'display' });
    return { promise: task.promise, cancel: () => task.cancel() };
  }

  /** Where text occurs on a page: boxes in points, measured from the top left. Only a word that lies
   * inside one run of text is found (weaker than poppler, PORTING.md 7.4). @param {number} i @param {string} query @returns {Promise<number[][]>} */
  async find(i, query) {
    const page = await this._page(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const q = query.toLowerCase();
    /** @type {number[][]} */
    const out = [];
    for (const it of content.items) {
      const str = /** @type {string} */ (it.str);
      if (!str) continue;
      const lower = str.toLowerCase();
      for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + Math.max(1, q.length))) {
        const [a, b, c, d, e, f] = /** @type {number[]} */ (it.transform);
        const w = it.width, len = Math.max(1, str.length);
        // the run is laid along (a, b) from (e, f); the hit is the part of its width the match covers
        const along = Math.hypot(a, b) || 1;
        const ux = a / along, uy = b / along;
        const x0 = e + ux * w * at / len, y0 = f + uy * w * at / len, x1 = e + ux * w * (at + q.length) / len, y1 = f + uy * w * (at + q.length) / len;
        const hgt = it.height || Math.hypot(c, d);
        const nx = -uy * hgt, ny = ux * hgt;
        const pts = [[x0, y0], [x1, y1], [x0 + nx, y0 + ny], [x1 + nx, y1 + ny]].map(([x, y]) => viewport.convertToViewportPoint(x, y));
        out.push([Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]);
      }
    }
    return out;
  }
}
