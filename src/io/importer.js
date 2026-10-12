// @ts-check
// Bringing files in: PDFs and Goodnotes documents (as notebooks), .inkpad files, whole folders
// (B:library.py `import_tree`, window.py `_import_to_library`, `_import_pdf`).
import { h } from '../ui/ui.js';
import { showDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { pickFiles } from '../platform/files.js';
import { Document } from '../core/document.js';
import { PdfDoc } from '../core/pdfdoc.js';
import { setIdOf } from '../core/notebook.js';
import { EXT } from '../library/store.js';
import { basename, dirname, join, splitext } from '../core/path.js';
import { tr, trf } from '../core/i18n.js';
import { inform } from '../ui/dialog.js';
import { hexId } from '../core/uuid.js';

/** @param {string} name */
const kindOf = name => name.toLowerCase().split('.').pop() || '';

/** A notebook made from a PDF. @param {any} app @param {string} folder @param {string} name @param {Blob} blob */
export async function importPdf(app, folder, name, blob) {
  const path = await app.store.unique(folder, name, EXT);
  const doc = await Document.fromPdf(blob);
  doc.store = app.vfs;
  await doc.save(path);
  return path;
}

/** A notebook made from a Goodnotes document; returns [path, what was read]. @param {any} app @param {string} folder @param {Blob} blob */
export async function importGoodnotes(app, folder, blob) {
  const { loadGoodnotes } = await import('./goodnotes.js');
  const { doc, title, stats } = await loadGoodnotes(blob);
  const path = await app.store.unique(folder, title.replaceAll('/', '-'), EXT);
  doc.store = app.vfs;
  await doc.save(path);
  return [path, stats];
}

/** @param {any} stats */
function goodnotesText(stats) {
  let text = trf('已导入 %d 笔、%d 个文本框', stats.strokes + (stats.shapes || 0), stats.texts);
  if (stats.skipped) text += trf('；有 %d 个元素无法识别，已跳过', stats.skipped);
  return text;
}

/** The "import PDF or Goodnotes" menu entry. @param {any} app @param {string} folder */
export async function importFiles(app, folder) {
  const files = await pickFiles({ accept: '.pdf,.goodnotes,.inkpad', multiple: true });
  if (!files.length) return;
  await importList(app, folder, files);
}

/** PDFs, Goodnotes documents and notebooks (and archives) given as files. @param {any} app @param {string} folder @param {File[]} files */
export async function importList(app, folder, files) {
  const opened = [];
  for (const file of files) {
    try {
      const kind = kindOf(file.name);
      const stem = splitext(file.name)[0];
      if (kind === 'goodnotes') {
        const [path, stats] = await importGoodnotes(app, folder, file);
        toast(goodnotesText(stats));
        opened.push(path);
      } else if (kind === 'zip') {
        toast(trf('已导入 %d 本笔记', await app.store.importArchive(file, folder)));
      } else if (kind === 'inkpad') {
        const path = await app.store.unique(folder, stem, EXT);
        await app.vfs.write(path, file);
        await setIdOf(app.vfs, path, hexId());
        opened.push(path);
      } else {
        opened.push(await importPdf(app, folder, stem, file));
      }
    } catch (e) { app.reportError(tr('无法导入'), e); }
  }
  await app.library.refresh();
  if (opened.length === 1) app.openNotebook(opened[0]);
  else if (opened.length) toast(trf('已导入 %d 本笔记', opened.length));
}

/** A progress window that cannot be closed. @param {string} title */
function progressDialog(title) {
  const bar = h('i', { style: { width: '0%' } });
  const text = h('div', { class: 'caption dim ellipsis', style: { marginTop: '6px' } });
  /** @type {(v?: any) => void} */ let shut = () => {};
  showDialog({ className: 'alert', build: close => { shut = close; return [h('h2', null, title), h('div', { class: 'progress', style: { marginTop: '12px', minWidth: '320px' } }, bar), text]; } });
  return { update(/** @type {number} */ f, /** @type {string} */ t) { bar.style.width = Math.round(f * 100) + '%'; text.textContent = t || Math.round(f * 100) + '%'; }, close: () => shut() };
}

/**
 * Import every Goodnotes document, PDF and Inkpad notebook under a folder, keeping its folder
 * structure. @param {any} app @param {{rel: string, file: File}[]} tree @param {string} folder
 */
export async function importFolderTree(app, tree, folder) {
  const found = tree.filter(t => !t.rel.split('/').some(s => s.startsWith('.')) && /\.(goodnotes|pdf|inkpad)$/i.test(t.rel)).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  if (!found.length) { await inform(tr('没有可导入的文件'), tr('文件夹里没有 Goodnotes 文档、PDF 或 Inkpad 笔记本。')); return; }
  const rootName = found[0].rel.split('/')[0];
  const top = await app.store.unique(folder, rootName || tr('导入'));
  const progress = progressDialog(tr('正在导入…'));
  let done = 0;
  /** @type {[string, string][]} */ const failed = [];
  try {
    for (const [n, { rel, file }] of found.entries()) {
      const inner = rel.split('/').slice(1).join('/') || basename(rel);   // inside the chosen folder
      progress.update(n / found.length, inner);
      const target = join(top, dirname(inner) === '.' ? '' : dirname(inner));
      const stem = splitext(basename(inner))[0].replaceAll('/', '-');
      try {
        if (target) await app.vfs.mkdir(target);
        const kind = kindOf(inner);
        if (kind === 'goodnotes') await importGoodnotes(app, target, file);
        else if (kind === 'pdf') await importPdf(app, target, stem, file);
        else {
          const path = await app.store.unique(target, stem, EXT);
          await app.vfs.write(path, file);
          await setIdOf(app.vfs, path, hexId());
        }
        done++;
      } catch (e) { failed.push([inner, (/** @type {any} */ (e)).message || String(e)]); }
    }
  } finally { progress.update(1, ''); progress.close(); }
  await app.library.refresh();
  if (failed.length) await inform(trf('已导入 %d 本，%d 个文件未能导入', done, failed.length), failed.slice(0, 12).map(f => `${f[0]}：${f[1]}`).join('\n'));
  else toast(trf('已导入 %d 本笔记', done));
}

/** Add the pages of a PDF to the open notebook. @param {any} ed @param {boolean} positioned */
export async function importPdfPages(ed, positioned) {
  const [file] = await pickFiles({ accept: '.pdf,application/pdf' });
  if (!file) return;
  let pages;
  try { pages = await Document.pdfPages(await PdfDoc.fromBlob(file)); } catch (e) { ed.app.reportError(tr('无法导入 PDF'), e); return; }
  if (positioned) ed.ops.addPages(pages);
  else {
    const at = ed.canvas.currentPageIndex() + 1;
    ed.doc.do({ kind: 'pages', removed: [], added: pages.map((p, i) => [at + i, p]) });
    ed.canvas.scrollToPage(at);
  }
  toast(trf('已导入 %d 页', pages.length));
}

/** Things dropped on the window: loose files are imported one by one, folders as folders (B: "dropping files is importing").
 * @param {any} app @param {{rel: string, file: File}[]} tree @param {string} folder */
export async function importDropped(app, tree, folder) {
  const loose = tree.filter(t => !t.rel.includes('/')).map(t => t.file);
  const folders = tree.filter(t => t.rel.includes('/'));
  if (loose.length) await importList(app, folder, loose);
  if (folders.length) {
    /** @type {Map<string, {rel: string, file: File}[]>} */ const byRoot = new Map();
    for (const t of folders) { const root = t.rel.split('/')[0]; if (!byRoot.has(root)) byRoot.set(root, []); /** @type {any[]} */ (byRoot.get(root)).push(t); }
    for (const list of byRoot.values()) await importFolderTree(app, list, folder);
  }
}
