// @ts-check
// Editor sidebar: page thumbnails in two columns, outline and bookmarks (B:sidebar.py).
import { h, icon } from '../ui/ui.js';
import { pageSurface, pdfBackground } from '../core/render.js';
import { tr, trf } from '../core/i18n.js';

const WIDTH = 124;

export class Sidebar {
  /**
   * @param {(i: number) => void} onPick @param {(page: any, anchor: Element) => void} pageMenu @param {() => void} onAdd
   */
  constructor(onPick, pageMenu, onAdd) {
    this.onPick = onPick; this.pageMenu = pageMenu; this.onAdd = onAdd;
    /** @type {import('../core/document.js').Document|null} */ this.doc = null;
    /** @type {Map<any, HTMLCanvasElement>} */ this.views = new Map();
    /** @type {Map<any, HTMLElement>} */ this.marks = new Map();
    this.dirty = new Set();
    this.timer = 0;
    this.visible = false;
    this.current = -1;
    this._unlisten = () => {};
    this.thumbs = h('div', { class: 'thumbs scroll', style: { flex: '1 1 auto' } });
    this.outline = h('div', { class: 'col scroll', style: { gap: 0, padding: '4px 8px', flex: '1 1 auto' } });
    this.bookmarks = h('div', { class: 'col scroll', style: { gap: 0, padding: '4px 8px', flex: '1 1 auto' } });
    const panes = { thumbs: this.thumbs, outline: this.outline, marks: this.bookmarks };
    const tabs = h('div', { class: 'segmented side-tabs' }, [['thumbs', 'grid', tr('缩略图')], ['outline', 'outline', tr('大纲')], ['marks', 'bookmark', tr('书签')]].map(([name, ic, tip], i) =>
      h('button', { title: tip, 'aria-pressed': String(i === 0), style: { width: '46px' }, onClick: (/** @type {Event} */ e) => {
        tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false'));
        /** @type {Element} */ (e.currentTarget).setAttribute('aria-pressed', 'true');
        for (const [k, el] of Object.entries(panes)) el.hidden = k !== name;
      } }, icon(ic))));
    this.outline.hidden = true; this.bookmarks.hidden = true;
    this.el = h('aside', { class: 'sidebar', hidden: true }, h('div', { style: { display: 'flex', justifyContent: 'center', padding: '10px 0 8px' } }, tabs), this.thumbs, this.outline, this.bookmarks);
  }

  /** @param {import('../core/document.js').Document} doc */
  setDocument(doc) {
    this._unlisten();
    this.doc = doc;
    this._unlisten = doc.listen((kind, ...args) => this._event(kind, ...args));
    this._rebuild();
  }

  /** @param {boolean} on */
  show(on) {
    this.el.hidden = !on;
    this.visible = on;
    if (on) { this.dirty = new Set(this.doc ? this.doc.pages : []); this._schedule(); }
  }

  _event(kind, ...args) {
    if (kind === 'pages') this._rebuild();
    else if (kind === 'meta') this._refreshMeta();
    else if (kind === 'added' || kind === 'dirty') { this.dirty.add(args[0]); this._schedule(); }
  }

  _rebuild() {
    const doc = /** @type {NonNullable<typeof this.doc>} */ (this.doc);
    this.views = new Map(); this.marks = new Map();
    const cells = doc.pages.map((page, n) => {
      const height = Math.round(WIDTH * (page.board ? 0.72 : page.h / page.w));
      const hh = Math.min(height, 200), ww = height > 200 ? Math.round(200 * page.w / page.h) : WIDTH;
      const dpr = window.devicePixelRatio || 1;
      const view = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'thumb', width: Math.round(ww * dpr), height: Math.round(hh * dpr), style: { width: ww + 'px', height: hh + 'px' } }));
      const mark = h('span', { class: 'mark' }, icon('bookmark_filled', 18));
      const more = h('button', { class: 'flat icon-btn', title: tr('页面操作'), style: { minWidth: '34px', minHeight: '28px' }, onClick: (/** @type {Event} */ e) => { e.stopPropagation(); this.pageMenu(page, /** @type {Element} */ (e.currentTarget)); } }, icon('dots', 16));
      this.views.set(page, view); this.marks.set(page, mark);
      return h('div', { class: 'thumb-cell', dataset: { index: n }, onClick: () => this.onPick(n) },
        h('div', { style: { position: 'relative' } }, view, mark), h('div', { class: 'row', style: { width: '100%', justifyContent: 'space-between', paddingLeft: '6px' } }, h('label', null, String(n + 1)), more));
    });
    const add = h('button', { class: 'add-page', style: { width: WIDTH + 'px', height: '150px', flexDirection: 'column', alignSelf: 'start', justifySelf: 'center', marginTop: '8px' }, onClick: () => this.onAdd() },
      icon('plus'), h('span', null, doc.pages[0].board ? tr('添加白板') : tr('添加页面')));
    this.thumbs.replaceChildren(...cells, add);
    this.dirty = new Set(doc.pages);
    this._refreshMeta();
    this._schedule();
    this.select(this.current);
  }

  _refreshMeta() {
    const doc = /** @type {NonNullable<typeof this.doc>} */ (this.doc);
    this.outline.replaceChildren();
    this.bookmarks.replaceChildren();
    doc.pages.forEach((page, n) => {
      const mark = this.marks.get(page);
      if (mark) mark.hidden = !page.bookmark;
      for (const [box, text] of /** @type {[HTMLElement, string|null][]} */ ([[this.outline, page.outline], [this.bookmarks, page.bookmark ? trf('第 %d 页', n + 1) : null]])) {
        if (text) box.append(h('button', { class: 'menu-row flat', onClick: () => this.onPick(n) }, h('span', { class: 'grow ellipsis' }, text), h('span', { class: 'dim' }, String(n + 1))));
      }
    });
    for (const box of [this.outline, this.bookmarks]) if (!box.children.length) box.append(h('div', { class: 'center dim', style: { marginTop: '30px' } }, tr('暂无内容')));
  }

  /** @param {number} index */
  select(index) {
    this.current = index;
    this.thumbs.querySelectorAll('.thumb-cell').forEach(c => c.classList.toggle('current', /** @type {HTMLElement} */ (c).dataset.index === String(index)));
  }

  // -- thumbnails, rendered lazily while the sidebar is visible ---------------------------------

  _schedule() {
    if (!this.timer && this.dirty.size && this.visible) this.timer = window.setTimeout(() => this._flush(), 350);
  }

  _flush() {
    this.timer = 0;
    if (!this.visible) return;
    let n = 0;
    for (const page of [...this.dirty]) {
      if (n++ >= 12) break;
      this.dirty.delete(page);
      const view = this.views.get(page);
      if (!view) continue;
      const draw = (/** @type {any} */ background) => {
        if (!this.views.has(page)) return;
        const surface = pageSurface(page, 0, { size: [view.width, view.height], background });
        const ctx = /** @type {CanvasRenderingContext2D} */ (view.getContext('2d'));
        ctx.clearRect(0, 0, view.width, view.height);
        ctx.drawImage(/** @type {any} */ (surface), 0, 0);
      };
      if (page.pdf) pdfBackground(page, Math.min(view.width / page.w, view.height / page.h)).then(draw);   // behind the ink, once it is rendered
      else draw(undefined);
    }
    this._schedule();
  }
}
