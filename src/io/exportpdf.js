// @ts-check
// A vector PDF of a notebook (B:model.export_pdf; PORTING.md 7.5). Ink stays paths, text stays text
// in the font the user chose, and the pages of an imported PDF are embedded, not redrawn. pdf-lib
// (and, for the font, fontkit) are loaded only here.
import { PdfCtx } from './pdfctx.js';
import * as ptext from '../core/ptext.js';
import { renderPage } from '../core/render.js';
import { pageBox } from '../core/page.js';
import { tr } from '../core/i18n.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
let libPromise = null, fontkitPromise = null;

function loadPdfLib() { return (libPromise ??= import(/* @vite-ignore */ VENDOR + 'pdf-lib/pdf-lib.esm.min.js')); }

/** fontkit is a UMD file: loaded as a classic script, it puts itself on globalThis. */
function loadFontkit() {
  return (fontkitPromise ??= new Promise((resolve, reject) => {
    if (/** @type {any} */ (globalThis).fontkit) { resolve(/** @type {any} */ (globalThis).fontkit); return; }
    const s = document.createElement('script');
    s.src = VENDOR + 'fontkit/fontkit.umd.min.js';
    s.onload = () => resolve(/** @type {any} */ (globalThis).fontkit);
    s.onerror = () => reject(new Error('could not load fontkit'));
    document.head.append(s);
  }));
}

/** Whether anything to export has text in it, so that a font is needed. @param {import('../core/page.js').Page[]} pages */
export function needsFont(pages, paper = true, ink = true) {
  return pages.some(p => (ink && p.items.some(it => it.kind === 't')) || (paper && !p.pdf && p.paper === 'weekly'));
}

/**
 * @param {import('../core/document.js').Document} doc
 * @param {object} o
 * @param {number[]|null} [o.pages] page indexes, null for all
 * @param {boolean} [o.paper] @param {boolean} [o.ink]
 * @param {{name: string, blob: Blob}|null} [o.font] the font text is set in
 * @param {(fraction: number) => void} [o.progress]
 * @param {((item: any) => boolean)|null} [o.itemFilter] leave out the items it says no to (Goodnotes wants only the background)
 * @returns {Promise<{blob: Blob, missing: string[], rasterPages: number}>}
 */
export async function buildPdf(doc, { pages = null, paper = true, ink = true, font = null, progress, itemFilter = null } = {}) {
  const { PDFDocument } = await loadPdfLib();
  const list = pages === null ? doc.pages : pages.map(i => doc.pages[i]);
  const out = await PDFDocument.create();
  let pdfFont = null;
  if (font && needsFont(list, paper, ink)) {
    out.registerFontkit(await loadFontkit());
    pdfFont = await out.embedFont(new Uint8Array(await font.blob.arrayBuffer()), { subset: true });
  }
  /** @type {Set<string>} */ const missing = new Set();
  let rasterPages = 0;
  /** @type {Map<any, any>} */ const sources = new Map();   // PdfDoc -> {doc: pdf-lib document}
  const metrics = pdfFont ? {
    width: (/** @type {string} */ t, /** @type {number} */ size) => pdfFont.widthOfTextAtSize(t, size),
    lineHeight: (/** @type {number} */ size) => pdfFont.heightAtSize(size),
    ascent: (/** @type {number} */ size) => pdfFont.heightAtSize(size, { descender: false }),
  } : null;
  if (metrics) ptext.setMetrics(metrics);
  try {
    for (const [n, page] of list.entries()) {
      progress?.(n / list.length);
      const [x0, y0, x1, y1] = pageBox(page);
      // PDF pages cannot be larger than 200 inches; a sprawling whiteboard is scaled to fit.
      const k = Math.min(1.0, 14400 / Math.max(x1 - x0, y1 - y0));
      const W = (x1 - x0) * k, H = (y1 - y0) * k;
      const pdfPage = out.addPage([W, H]);
      /** @type {Map<string, string>} */ const gs = new Map();
      /** @type {Map<Blob, string>} */ const imgs = new Map();
      /** @type {Map<any, string>} */ const fonts = new Map();
      const res = {
        gstate: (/** @type {{ca: number, blend: string}} */ spec) => {
          const key = `${spec.ca}|${spec.blend}`;
          let name = gs.get(key);
          if (!name) {
            const dict = out.context.obj({ Type: 'ExtGState', CA: spec.ca, ca: spec.ca, BM: spec.blend });
            name = pdfPage.node.newExtGState('GS', dict).asString().slice(1);
            gs.set(key, name);
          }
          return name;
        },
        image: (/** @type {Blob} */ png) => /** @type {string} */ (imgs.get(png)),
        fontName: (/** @type {any} */ f) => {
          let name = fonts.get(f);
          if (!name) { name = pdfPage.node.newFontDictionary('F', f.ref).asString().slice(1); fonts.set(f, name); }
          return name;
        },
      };
      // Pictures are embedded before the page is drawn (embedding is asynchronous, drawing is not).
      for (const it of ink ? page.items : []) {
        if (it.kind === 'i' && !imgs.has(it.data)) {
          const img = await out.embedPng(new Uint8Array(await it.data.arrayBuffer()));
          imgs.set(it.data, pdfPage.node.newXObject('Im', img.ref).asString().slice(1));
        }
      }
      const ctx = new PdfCtx(res, { pdfFont, onMissing: chars => chars.forEach(c => missing.add(c)) });
      ctx.out.push(`${k} 0 0 ${-k} 0 ${H} cm`);
      /** @type {((ctx: any, page: any) => void)|undefined} */
      let background;
      if (paper && page.pdf) {
        const how = await background_(out, sources, page, pdfPage);
        if (how.kind === 'embedded') background = c => c.drawEmbeddedPage(how.name, how.w, how.h, page.rot);
        else if (how.kind === 'raster') {
          rasterPages++;
          background = c => { c.out.push('q', `${page.w} 0 0 ${-page.h} 0 ${page.h} cm`, `/${how.name} Do`, 'Q'); };
        }
      }
      // Text is laid out again with the chosen font's metrics, so it fits the notes it is on. The
      // copies are made while those metrics are in force; the page's own items are not touched.
      const items = ink ? page.items.filter(it => !itemFilter || itemFilter(it)).map(it => {
        if (it.kind === 't') return it.transformed(1, 0, 0, 0, 0);
        if (it.kind === 'i') { const c = it.transformed(1, 0, 0, 0, 0); c.bitmap = { png: it.data }; return c; }
        return it;
      }) : [];
      renderPage(/** @type {any} */ (ctx), page, { printing: true, paper, ink, ox: x0, oy: y0, perPixel: 1, background, items });
      const stream = out.context.stream(ctx.stream());
      pdfPage.node.addContentStream(out.context.register(stream));
    }
    progress?.(1);
    const bytes = await out.save();
    return { blob: new Blob([bytes], { type: 'application/pdf' }), missing: [...missing], rasterPages };
  } finally {
    if (metrics) ptext.setMetrics(null);
  }
}

/**
 * The original PDF page as a background: embedded as it is (vector, selectable); a page that cannot
 * be (encrypted or damaged, or turned by its own /Rotate) is drawn as a picture instead.
 * @returns {Promise<{kind: 'embedded', name: string, w: number, h: number}|{kind: 'raster', name: string}|{kind: 'none'}>}
 */
async function background_(out, sources, page, pdfPage) {
  const { PDFDocument } = await loadPdfLib();
  try {
    const jsPage = await page.pdf._page(page.pdfPage);
    if (jsPage.rotate % 360 !== 0) throw new Error('rotated page');
    let src = sources.get(page.pdf);
    if (!src) {
      src = { doc: await PDFDocument.load(new Uint8Array(await page.pdf.blob.arrayBuffer())), embedded: new Map() };
      sources.set(page.pdf, src);
    }
    let emb = src.embedded.get(page.pdfPage);
    if (!emb) { [emb] = await out.embedPdf(src.doc, [page.pdfPage]); src.embedded.set(page.pdfPage, emb); }
    return { kind: 'embedded', name: pdfPage.node.newXObject('Bg', emb.ref).asString().slice(1), w: emb.width, h: emb.height };
  } catch {
    try {
      const { renderBackground } = await import('../editor/pdfqueue.js');
      const bg = await renderBackground(page, Math.round(page.w * 2), Math.round(page.h * 2), [0, 0, 2, 2]);
      const blob = await new Promise(res => /** @type {HTMLCanvasElement} */ (bg).toBlob ? /** @type {HTMLCanvasElement} */ (bg).toBlob(res, 'image/jpeg', 0.85) : /** @type {any} */ (bg).convertToBlob({ type: 'image/jpeg', quality: 0.85 }).then(res));
      const img = await out.embedJpg(new Uint8Array(await /** @type {Blob} */ (blob).arrayBuffer()));
      return { kind: 'raster', name: pdfPage.node.newXObject('Bg', img.ref).asString().slice(1) };
    } catch { return { kind: 'none' }; }
  }
}

export { tr };
