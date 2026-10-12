// @ts-check
// Where a query occurs on a page: in its text boxes and notes, and in the PDF under it
// (B:model.find_text). Boxes are in page points.
import { rotBox } from './items.js';

/** @param {import('./page.js').Page} page @param {string} query @returns {Promise<number[][]>} */
export async function findText(page, query) {
  query = query.trim().toLowerCase();
  /** @type {number[][]} */
  const out = [];
  if (!query) return out;
  if (page.pdf && /** @type {any} */ (page.pdf).find) {
    const pdf = /** @type {any} */ (page.pdf);
    const [ow, oh] = await pdf.pageSize(page.pdfPage);
    for (const box of await pdf.find(page.pdfPage, query)) out.push(rotBox(page.rot % 4, ow, oh, box));
  }
  for (const it of page.items) if (it.kind === 't' && it.text.toLowerCase().includes(query)) out.push(it.bbox);
  return out;
}
