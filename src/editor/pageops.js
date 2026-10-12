// @ts-check
// Page operations (B:window.py add/copy/paste/duplicate/rotate/delete/clear/template, bookmarks, outline).
import { Page } from '../core/page.js';
import { prepareRotation } from '../core/items.js';
import { askText } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { paperDialog } from '../ui/paperdialog.js';
import { tr, trf } from '../core/i18n.js';

export class PageOps {
  /** @param {any} editor the editor view: it has `doc`, `canvas`, `settings` and `page()` */
  constructor(editor) {
    this.ed = editor;
    /** @type {Page|null} */ this.clip = null;
  }

  get doc() { return this.ed.doc; }
  get canvas() { return this.ed.canvas; }
  /** @param {Page} page */
  index(page) { return this.doc.pages.indexOf(page); }

  /** @param {Page} page */
  toggleBookmark(page) { page.bookmark = !page.bookmark; this.doc.touch(); }

  /** @param {Page} page */
  async editOutline(page) {
    if (page.outline) { page.outline = null; this.doc.touch(); return; }
    const text = await askText(tr('添加到大纲'), { value: trf('第 %d 页', this.index(page) + 1) });
    if (text && text.trim()) { page.outline = text.trim(); this.doc.touch(); }
  }

  /** @param {Page} page */
  copyPage(page) { this.clip = page.clone(); toast(tr('已拷贝页面')); }

  /** @param {Page} after @param {Page} page */
  insertPage(after, page) {
    const i = this.index(after) + 1;
    this.doc.do({ kind: 'pages', removed: [], added: [[i, page]] });
    this.canvas.scrollToPage(i);
  }

  /** @param {Page} page */
  pastePage(page) { if (this.clip) this.insertPage(page, this.clip.clone()); }
  /** @param {Page} page */
  duplicatePage(page) { this.insertPage(page, page.clone()); }
  /** @param {Page} page */
  addAfter(page) { this.insertPage(page, page.blankLike()); }
  addEnd() { this.addAfter(this.doc.pages[this.doc.pages.length - 1]); }

  /** Turn a page k quarter turns clockwise, its content with it. Pictures are re-encoded first. @param {Page} page @param {number} k */
  async rotatePage(page, k) {
    await prepareRotation(page.items, k % 4);
    const i = this.index(page);
    if (i < 0) return;
    this.canvas.clearSelection();
    this.doc.do({ kind: 'pages', removed: [[i, page]], added: [[i, page.rotated(k)]] });
  }

  /** @param {Page} page */
  deletePage(page) {
    const i = this.index(page);
    const added = this.doc.pages.length === 1 ? [[0, page.blankLike()]] : [];
    this.doc.do({ kind: 'pages', removed: [[i, page]], added });
  }

  /** @param {Page} page */
  clearPage(page) {
    if (page.items.length) {
      this.canvas.clearSelection();
      this.doc.removeItems(page, [...page.items]);
    }
  }

  /** @param {Page} page */
  async changeTemplate(page) {
    if (page.pdf) { toast(tr('PDF 页面不能更换纸张模板')); return; }
    const r = await paperDialog({ template: /** @type {any} */ (page.template()), board: page.board });
    if (!r) return;
    const template = r.template;
    if (!page.board) { this.ed.settings.template = { ...template, color: [...template.color] }; this.ed.saveSettings(); }
    const next = { w: template.w, h: template.h, paper: template.paper, color: [...template.color] };
    if (JSON.stringify(next) !== JSON.stringify(page.template())) this.doc.do({ kind: 'template', page, old: page.template(), new: next });
  }

  /** The pages were pulled past an end: add one like its neighbour there. @param {number} side */
  pullAdd(side) {
    const pages = this.doc.pages;
    const i = side > 0 ? pages.length : 0;
    this.doc.do({ kind: 'pages', removed: [], added: [[i, pages[side > 0 ? pages.length - 1 : 0].blankLike()]] });
    this.canvas.scrollToPage(i);
  }

  addIndex() {
    const pos = this.ed.settings.add_pos;
    if (pos === 'last') return this.doc.pages.length;
    return this.index(this.ed.page()) + (pos === 'after' ? 1 : 0);
  }

  /** @param {Page[]} pages */
  addPages(pages) {
    const i = this.addIndex();
    this.doc.do({ kind: 'pages', removed: [], added: pages.map((p, n) => [i + n, p]) });
    this.canvas.scrollToPage(i);
  }

  async gotoPage() {
    const total = this.doc.pages.length;
    const text = await askText(tr('前往页面'), { value: String(this.canvas.currentPageIndex() + 1), label: trf('共 %d 页', total), ok: tr('前往') });
    const n = Number(text);
    if (text !== null && Number.isInteger(n) && n >= 1 && n <= total) this.canvas.scrollToPage(n - 1);
  }
}

export { Page };
