// @ts-check
// The editor's export menu: vector PDF, one page or all pages as pictures, the .inkpad file itself,
// Goodnotes (B:window.py `_export_*`, `_ask_export`, `_page_range`).
import { h } from '../ui/ui.js';
import { showDialog, inform } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { select } from '../ui/controls.js';
import { saveBlob } from '../platform/files.js';
import { toPng } from '../platform/canvas.js';
import { pageSurface } from '../core/render.js';
import { ZipWriter } from '../core/zip.js';
import { ensureBitmaps } from '../platform/image.js';
import { getExportFont, chooseExportFont } from './exportfont.js';
import { tr, trf } from '../core/i18n.js';

/** '1-3, 5' -> [0, 1, 2, 4]; empty means every page (null). Throws when unreadable. @param {string} text @param {number} total @returns {number[]|null} */
export function pageRange(text, total) {
  text = text.replaceAll('，', ',').replaceAll('、', ',').replaceAll('–', '-').trim();
  if (!text) return null;
  /** @type {number[]} */
  const out = [];
  for (const part of text.split(',')) {
    const [a, , b] = /^\s*(\d+)\s*(-\s*(\d+))?\s*$/.exec(part) || (() => { throw new Error(part); })();
    const first = Number(a), last = Number(b || a);
    if (!(first >= 1 && first <= last && last <= total)) throw new Error(part);
    for (let n = first; n <= last; n++) if (!out.includes(n - 1)) out.push(n - 1);
  }
  return out;
}

/** Ask which pages and which layers to export. @param {any} ed @param {string} heading @param {boolean} withRange
 * @returns {Promise<{pages: number[]|null, paper: boolean, ink: boolean}|null>} */
async function askExport(ed, heading, withRange) {
  const total = ed.doc.pages.length;
  const pages = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: tr('全部页面；也可填 1-3,5'), style: { width: '100%' } }));
  const what = select([{ label: tr('笔迹和背景'), value: 0 }, { label: tr('仅笔迹（透明背景）'), value: 1 }, { label: tr('仅背景'), value: 2 }], 0, () => {});
  const r = await showDialog({
    className: 'alert', dismissed: null,
    build: close => [h('h2', null, heading), h('div', { class: 'col', style: { marginTop: '10px' } },
      withRange ? [h('div', null, trf('页面范围（共 %d 页）', total)), pages] : null, h('div', { style: { marginTop: '4px' } }, tr('导出内容')), what)],
    footer: close => [h('button', { onClick: () => close(null) }, tr('取消')), h('button', { class: 'suggested', onClick: () => close(true) }, tr('导出'))],
  });
  if (!r) return null;
  let picked = null;
  if (withRange) {
    try { picked = pageRange(pages.value, total); } catch { toast(tr('页面范围无法识别，请按 1-3,5 的格式填写')); return null; }
  }
  const mode = /** @type {HTMLSelectElement} */ (what).selectedIndex;
  return { pages: picked, paper: mode !== 1, ink: mode !== 2 };
}

/** @param {any} ed */
export async function exportPdf(ed) {
  const o = await askExport(ed, tr('导出为 PDF'), true);
  if (!o) return;
  const { buildPdf, needsFont } = await import('./exportpdf.js');
  const list = o.pages === null ? ed.doc.pages : o.pages.map(i => ed.doc.pages[i]);
  let font = await getExportFont(ed.app.vfs);
  if (needsFont(list, o.paper, o.ink) && !font) {
    font = await chooseExportFont(ed.app);
    if (!font) return;
  }
  await ed.session.save();
  const dismiss = toast(tr('正在导出…'), { timeout: 600 });
  try {
    const { blob, missing, rasterPages } = await buildPdf(ed.doc, { ...o, font });
    dismiss();
    if (!(await saveBlob(blob, ed.doc.displayName() + '.pdf', { description: tr('PDF 文档'), accept: { 'application/pdf': ['.pdf'] } }))) return;
    toast(tr('已导出到 ') + ed.doc.displayName() + '.pdf');
    const notes = [];
    if (missing.length) notes.push(trf('所选字体缺少 %d 个字符：%s。请换一个字体再导出。', missing.length, missing.slice(0, 12).join(' ')));
    if (rasterPages) notes.push(trf('有 %d 页的 PDF 背景无法按矢量嵌入，已改为图片。', rasterPages));
    if (notes.length) await inform(tr('导出完成，但有需要注意的地方'), notes.join('\n'));
  } catch (e) { dismiss(); ed.app.reportError(tr('导出失败'), e); }
}

/** @param {any} page @param {boolean} paper @param {boolean} ink @returns {Promise<Blob>} */
async function pagePng(page, paper, ink) {
  const items = page.items;
  await ensureBitmaps(items);
  let background;
  if (paper && page.pdf) {
    const scale = Math.min(3.0, 12000 / Math.max(page.w, page.h));
    const { renderBackground } = await import('../editor/pdfqueue.js');
    const bg = await renderBackground(page, Math.max(1, Math.round(page.w * scale)), Math.max(1, Math.round(page.h * scale)), [0, 0, scale, scale]);
    background = (/** @type {any} */ ctx) => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg, 0, 0); ctx.restore(); };
  }
  return toPng(pageSurface(page, 3.0, { paper, ink, background }));
}

/** @param {any} ed */
export async function exportPng(ed) {
  const i = ed.canvas.currentPageIndex();
  const o = await askExport(ed, tr('导出当前页为图片'), false);
  if (!o) return;
  try {
    const blob = await pagePng(ed.doc.pages[i], o.paper, o.ink);
    if (await saveBlob(blob, `${ed.doc.displayName()}-${i + 1}.png`, { description: tr('PNG 图片'), accept: { 'image/png': ['.png'] } })) toast(tr('已导出到 ') + `${ed.doc.displayName()}-${i + 1}.png`);
  } catch (e) { ed.app.reportError(tr('导出失败'), e); }
}

/** @param {any} ed */
export async function exportPngAll(ed) {
  const o = await askExport(ed, tr('导出全部页面为图片…').replace(/…$/, ''), true);
  if (!o) return;
  const indexes = o.pages === null ? ed.doc.pages.map((/** @type {any} */ _, /** @type {number} */ i) => i) : o.pages;
  const name = ed.doc.displayName();
  try {
    const dirPicker = /** @type {any} */ (window).showDirectoryPicker;
    if (dirPicker) {
      let dir;
      try { dir = await dirPicker(); } catch (e) { if ((/** @type {any} */ (e))?.name === 'AbortError') return; throw e; }
      for (const n of indexes) {
        const handle = await dir.getFileHandle(`${name}-${String(n + 1).padStart(2, '0')}.png`, { create: true });
        const w = await handle.createWritable();
        await w.write(await pagePng(ed.doc.pages[n], o.paper, o.ink));
        await w.close();
      }
    } else {
      // No folder to write into: the pictures come as one zip.
      const z = new ZipWriter();
      for (const n of indexes) await z.add(`${name}-${String(n + 1).padStart(2, '0')}.png`, await pagePng(ed.doc.pages[n], o.paper, o.ink), { compress: false });
      if (!(await saveBlob(z.finish(), name + '.zip', { description: 'Zip', accept: { 'application/zip': ['.zip'] } }))) return;
    }
    toast(trf('已导出 %d 张图片', indexes.length));
  } catch (e) { ed.app.reportError(tr('导出失败'), e); }
}

/** The notebook as the .inkpad file it is. @param {any} ed */
export async function exportInkpad(ed) {
  await ed.session.save();
  const blob = await ed.app.vfs.read(ed.doc.path);
  if (await saveBlob(blob, ed.doc.displayName() + '.inkpad', { description: 'Inkpad', accept: { 'application/zip': ['.inkpad'] } })) toast(tr('已导出到 ') + ed.doc.displayName() + '.inkpad');
}

/** @param {any} ed */
export async function exportGoodnotes(ed) {
  const { saveGoodnotes } = await import('./goodnotes.js');
  await ed.session.save();
  const blob = await saveGoodnotes(ed.doc, ed.doc.displayName());
  if (await saveBlob(blob, ed.doc.displayName() + '.goodnotes', { description: tr('Goodnotes 文档'), accept: { 'application/zip': ['.goodnotes'] } })) toast(tr('已导出到 ') + ed.doc.displayName() + '.goodnotes');
}
