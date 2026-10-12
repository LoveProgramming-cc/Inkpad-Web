// @ts-check
// The library screen: folders and notebooks as a grid of covers (B:library.py `LibraryView`).
// Dragging items onto folders, selecting several, undoing moves, search, sort, trash.
import { h, icon } from '../ui/ui.js';
import { menuPopover } from '../ui/popover.js';
import { alertDialog, askText, confirm, showDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { paperDialog } from '../ui/paperdialog.js';
import { pickFolder } from '../ui/folderpicker.js';
import { folderArt } from './folderart.js';
import { FOLDER_COLORS, TRASH, EXT } from './store.js';
import { GLYPH_NAMES, glyph, swatchIcon } from '../core/icons.js';
import { basename, dirname, join, within } from '../core/path.js';
import { fmtDate, tr, trf } from '../core/i18n.js';
import { now, mono } from '../core/clock.js';
import { pickFiles, saveBlob, pickedTree } from '../platform/files.js';
import { select } from '../ui/controls.js';

const COVER_W = 150, COVER_H = 200;
const MODES = /** @type {const} */ (['docs', 'favs', 'trash']);

/** @typedef {import('./store.js').Entry} Entry */

/**
 * @typedef {object} LibraryHooks
 * @property {import('./store.js').Store} store
 * @property {any} settings        the preferences object; `last_folder` and `sort` are kept in it
 * @property {() => void} saveSettings
 * @property {(path: string) => void} onOpen
 * @property {(folder: string) => void} onImport   import a PDF or a Goodnotes document into a folder
 * @property {(tree: {rel: string, file: File}[], folder: string) => Promise<void>} importTree
 * @property {(title: string, error: any) => void} onError
 * @property {(anchor: Element) => void} cloudPopover
 * @property {() => void} onSettings
 */

export class LibraryView {
  /** @param {LibraryHooks} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.store = hooks.store;
    this.settings = hooks.settings;
    /** @type {'docs'|'favs'|'trash'} */
    this.mode = 'docs';
    // The folder that was open last time is where the library opens again.
    this.folder = '';
    this.cursor = /** @type {string|null} */ (null);   // the folder clicked once: a second click soon after opens it
    this.clickedAt = 0;
    this.dragging = /** @type {string[]} */ ([]);
    /** @type {[string, string][][]} */ this.undoStack = [];
    /** @type {[string, string][][]} */ this.redoStack = [];
    this.selecting = false;
    this.selected = new Set();
    /** @type {Entry[]} */ this.entries = [];
    /** @type {Map<string, {sign: string, url: string}>} */ this.covers = new Map();
    this.syncFraction = 0;
    this.syncText = '';
    /** @type {{bar: HTMLElement, name: HTMLElement, percent: HTMLElement}|null} */ this.syncBar = null;
    this.token = 0;   // a refresh that was overtaken by a newer one throws its result away
    this._suppressClick = false;   // the click that ends a drag is not a click on the item
    /** @type {any} */ this._searchTimer = 0;
    this._build();
  }

  async init() {
    const last = this.settings.last_folder || '';
    this.folder = last && (await this.store.vfs.isDir(last)) && !last.split('/').some((/** @type {string} */ p) => p.startsWith('.')) ? last : '';
    await this.refresh();
  }

  // -- the frame -------------------------------------------------------------

  _build() {
    const modeNames = [tr('文稿'), tr('收藏'), tr('废纸篓')];
    const modeIcons = ['documents', 'star', 'trash'];
    this.nav = h('div', { class: 'nav', role: 'listbox' }, MODES.map((m, i) =>
      h('button', { class: 'nav-row flat', role: 'option', 'aria-selected': String(m === this.mode), dataset: { mode: m },
        onClick: () => this._setMode(m, true) }, icon(modeIcons[i], 22), h('span', null, modeNames[i]))));
    const side = h('aside', { class: 'library-side' }, h('div', { class: 'brand' }, 'Inkpad'), this.nav);

    this.search = /** @type {HTMLInputElement} */ (h('input', { type: 'search', class: 'round', placeholder: tr('搜索'), 'aria-label': tr('搜索'), style: { width: '220px' },
      onInput: () => { clearTimeout(this._searchTimer); this._searchTimer = setTimeout(() => this.refresh(), 120); } }));
    this.cloud = h('button', { class: 'flat icon-btn', title: tr('Google Drive 同步'), onClick: e => this.hooks.cloudPopover(/** @type {Element} */ (e.currentTarget)) }, icon('cloud'));
    const gear = h('button', { class: 'flat icon-btn', title: tr('设置'), onClick: () => this.hooks.onSettings() }, icon('settings'));
    this.modeSelect = select(MODES.map((m, i) => ({ label: modeNames[i], value: m })), this.mode, m => this._setMode(m, true));
    this.modeSelect.classList.add('mode-select');
    const top = h('div', { class: 'lib-top' }, this.modeSelect, h('div', { class: 'grow' }), this.search, this.cloud, gear);

    this.crumbs = h('div', { class: 'crumbs row', hidden: true });
    this.back = h('button', { class: 'icon-btn round-btn', title: tr('返回上一级'), onClick: () => this.openFolder(dirname(this.folder)) }, icon('back'));
    this._dropTarget(this.back, () => dirname(this.folder));
    this.title = h('div', { class: 'library-title ellipsis grow' });
    this.newBtn = h('button', { class: 'suggested pill-btn', onClick: e => this._newMenu(/** @type {Element} */ (e.currentTarget)) }, icon('plus', 16), h('span', null, tr('新建')), icon('chevron', 14));
    this.emptyBtn = h('button', { class: 'pill-btn danger', onClick: () => this._emptyTrash() }, tr('清空废纸篓'));
    this.sort = select([{ label: tr('日期'), value: 'date' }, { label: tr('名称'), value: 'name' }], this.settings.sort === 'name' ? 'name' : 'date', v => {
      this.settings.sort = v; this.hooks.saveSettings(); this.refresh();
    });
    this.sort.classList.add('pill-drop');
    this.selectBtn = h('button', { class: 'icon-btn round-btn', title: tr('选择项目'), onClick: () => this.setSelecting(true) }, icon('check_circle'));
    this.bar = h('div', { class: 'lib-bar row' }, this.back, this.title, this.newBtn, this.emptyBtn, this.sort, this.selectBtn);

    this.selCount = h('div', { class: 'grow dim', style: { marginLeft: '6px' } });
    this.selActions = h('div', { class: 'row', style: { gap: '4px' } });
    this.selbar = h('div', { class: 'lib-bar row', hidden: true },
      h('button', { class: 'pill-btn', onClick: () => this._selectAll() }, tr('全选')), this.selCount, this.selActions,
      h('button', { class: 'suggested pill-btn', style: { marginLeft: '10px' }, onClick: () => this.setSelecting(false) }, tr('完成')));

    this.grid = h('div', { class: 'grid' });
    this.band = h('div', { class: 'band', hidden: true });
    this.empty = h('div', { class: 'statuspage', hidden: true });
    this.scroller = h('div', { class: 'grid-scroll scroll', onContextmenu: e => this._besideMenu(e) }, this.grid, this.band);
    this._wireBand();
    const main = h('main', { class: 'library-main' }, top, this.crumbs, this.bar, this.selbar, this.scroller, this.empty);
    this.el = h('div', { class: 'library' }, side, main);
    this.io = new IntersectionObserver(items => {
      for (const it of items) if (it.isIntersecting) { this.io.unobserve(it.target); this._loadCover(/** @type {HTMLElement} */ (it.target)); }
    }, { root: this.scroller, rootMargin: '300px' });
    this._syncMode();
  }

  _syncMode() {
    this.nav.querySelectorAll('.nav-row').forEach(b => b.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (b).dataset.mode === this.mode)));
    /** @type {HTMLSelectElement} */ (this.modeSelect).selectedIndex = MODES.indexOf(this.mode);
  }

  /** @param {'docs'|'favs'|'trash'} mode @param {boolean} [fromNav] */
  async _setMode(mode, fromNav = false) {
    if (mode === this.mode) {
      // Clicking the section that is already showing goes back to its top.
      if (fromNav && mode === 'docs' && this.folder !== '') await this.openFolder('');
      return;
    }
    this.mode = mode;
    this.folder = '';
    this._syncMode();
    await this.refresh();
  }

  /** @param {string} folder */
  async openFolder(folder) {
    this.folder = folder;
    this.settings.last_folder = folder;
    this.hooks.saveSettings();
    await this.refresh();
  }

  // -- sync state, shown in the cloud menu while that is open ------------------

  /** @param {number} fraction @param {string} text */
  setSyncProgress(fraction, text) {
    this.syncFraction = Math.max(0, Math.min(1, fraction));
    this.syncText = text;
    if (this.syncBar) {
      this.syncBar.bar.style.width = this.syncFraction * 100 + '%';
      this.syncBar.name.textContent = text;
      this.syncBar.name.title = text;
      this.syncBar.percent.textContent = Math.round(this.syncFraction * 100) + '%';
    }
  }

  /** @param {boolean} busy */
  setSyncing(busy) {
    if (busy) this.setSyncProgress(0, '');
    this.cloud.replaceChildren(icon(busy ? 'syncing' : 'cloud'));
    this.cloud.classList.toggle('busy', busy);
    this.cloud.firstElementChild?.classList.toggle('spin', busy);
  }

  // -- the grid ----------------------------------------------------------------

  async refresh() {
    const token = ++this.token;
    const store = this.store;
    if (this.folder !== '' && !(await store.vfs.isDir(this.folder))) this.folder = '';
    const query = this.search.value.trim().toLowerCase();
    let entries, title;
    if (this.mode === 'docs') {
      // A search looks through every folder, not only the one that is open.
      entries = query ? await store.find(query) : await store.entries(this.folder);
      title = query ? tr('搜索结果') : this.folder === '' ? tr('文稿') : basename(this.folder);
    } else if (this.mode === 'favs') {
      entries = await store.favorites();
      title = tr('收藏');
    } else {
      entries = await store.trashed();
      title = tr('废纸篓');
    }
    if (token !== this.token) return;
    if (query && this.mode !== 'docs') entries = entries.filter(e => e.name.toLowerCase().includes(query));
    if (this.settings.sort === 'name') entries.sort((a, b) => Number(!a.isDir) - Number(!b.isDir) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    else entries.sort((a, b) => b.mtime - a.mtime);
    this.entries = entries;
    this.title.textContent = title;
    // The way down to the open folder; each part is a button that goes there.
    const inside = this.mode === 'docs' && this.folder !== '' && !query;
    this.crumbs.hidden = !inside;
    this.crumbs.replaceChildren();
    if (inside) {
      const parts = [tr('文稿'), ...dirname(this.folder).split('/').filter(Boolean)];
      let path = '';
      parts.forEach((name, n) => {
        if (n) path = join(path, name);
        const target = path;
        if (n) this.crumbs.append(icon('chevron_right', 12));
        const step = h('button', { class: 'flat', onClick: () => this.openFolder(target) }, name);
        this._dropTarget(step, () => target);
        this.crumbs.append(step);
      });
    }
    this.back.hidden = !inside;
    this.newBtn.hidden = this.mode !== 'docs';
    this.emptyBtn.hidden = !(this.mode === 'trash' && entries.length > 0);
    for (const p of [...this.selected]) if (!entries.some(e => e.path === p)) this.selected.delete(p);
    this.grid.replaceChildren(...entries.map(e => this._cell(e)));
    // Covers of notebooks that are not shown any more are let go.
    const shown = new Set(entries.map(e => e.path));
    for (const [p, c] of this.covers) if (!shown.has(p)) { URL.revokeObjectURL(c.url); this.covers.delete(p); }
    this._syncSelection();
    this.scroller.hidden = entries.length === 0;
    this.empty.hidden = entries.length !== 0;
    if (!entries.length) {
      this.empty.replaceChildren(h('h2', null, query ? tr('没有匹配的项目') : { docs: tr('还没有笔记'), favs: tr('还没有收藏'), trash: tr('废纸篓是空的') }[this.mode]),
        this.mode === 'docs' && !query ? h('p', null, tr('点击“新建”创建笔记本，或导入一份 PDF。')) : null);
    }
  }

  /** @param {Entry} entry */
  _cell(entry) {
    const isDir = entry.isDir;
    const frame = h('div', { class: 'frame' });
    if (isDir) {
      const st = this.store.folderStyle(entry.path);
      frame.append(folderArt(st.color, st.icon));
    } else {
      const img = h('img', { class: 'cover', width: COVER_W, height: COVER_H, alt: '', draggable: false, style: { width: COVER_W + 'px', height: COVER_H + 'px', visibility: 'hidden' } });
      frame.append(img);
    }
    if (this.mode !== 'trash') {
      const fav = this.store.isFavorite(entry.path);
      frame.append(h('button', { class: ['star flat icon-btn', fav && 'on'], title: fav ? tr('取消收藏') : tr('收藏'),
        style: { top: isDir ? '28px' : '4px' }, onClick: e => { e.stopPropagation(); this._do(() => this.store.toggleFavorite(entry.path)); } }, icon(fav ? 'star_filled' : 'star', 18)));
    }
    const nameBtn = h('button', { class: 'name flat', onClick: e => { e.stopPropagation(); this._menu(entry, /** @type {Element} */ (e.currentTarget)); } },
      h('span', { class: 'ellipsis' }, entry.name), icon('chevron', 14));
    const cell = h('div', { class: ['cell', isDir && 'is-dir'], dataset: { path: entry.path }, tabindex: 0,
      onClick: e => { if (!this._suppressClick) this._activate(entry); e.stopPropagation(); },
      onKeydown: e => { if (e.key === 'Enter' && e.target === cell) this._activate(entry); },
      onContextmenu: e => { e.preventDefault(); e.stopPropagation(); this._menu(entry, new DOMRect(e.clientX, e.clientY, 0, 0)); },
    }, h('div', { class: 'holder' }, frame), nameBtn, h('div', { class: 'caption dim' }, fmtDate(tr('%Y年%-m月%-d日 %H:%M'), entry.mtime)));
    if (!isDir) this.io.observe(cell);
    if (this.mode === 'docs') {
      this._dragSource(cell, entry);
      if (isDir) this._dropTarget(cell, () => entry.path);
    }
    return cell;
  }

  /** The cover is fetched when its cell comes into view. @param {HTMLElement} cell */
  async _loadCover(cell) {
    const path = cell.dataset.path;
    if (!path) return;
    const st = await this.store.vfs.stat(path);
    if (!st) return;
    let c = this.covers.get(path);
    if (!c || c.sign !== st.sign) {
      const png = await this.store.cover(path);
      if (!png) return;
      if (c) URL.revokeObjectURL(c.url);
      c = { sign: /** @type {string} */ (st.sign), url: URL.createObjectURL(png) };
      this.covers.set(path, c);
    }
    const img = /** @type {HTMLImageElement|null} */ (cell.querySelector('img.cover'));
    if (!img) return;
    img.onload = () => {
      const k = Math.min(COVER_W / img.naturalWidth, COVER_H / img.naturalHeight);
      img.style.width = Math.round(img.naturalWidth * k) + 'px';
      img.style.height = Math.round(img.naturalHeight * k) + 'px';
      img.style.visibility = 'visible';
    };
    img.src = c.url;
  }

  // -- clicking ------------------------------------------------------------------

  /** @param {Entry} entry */
  async _activate(entry) {
    if (this.selecting) {
      if (this.selected.has(entry.path)) this.selected.delete(entry.path); else this.selected.add(entry.path);
      this._syncSelection();
      return;
    }
    if (this.mode === 'trash') return;
    if (entry.isDir) {
      // A folder opens on a double click; the first click only marks it.
      const t = mono(), last = [this.cursor, this.clickedAt];
      this.cursor = entry.path; this.clickedAt = t;
      if (last[0] !== entry.path || t - /** @type {number} */ (last[1]) > 500) { this._syncSelection(); return; }
      this.cursor = null;
      this.search.value = '';   // a folder found by searching opens as itself
      this.mode = 'docs';
      this._syncMode();
      await this.openFolder(entry.path);
    } else {
      this.hooks.onOpen(entry.path);
    }
  }

  // -- menus ---------------------------------------------------------------------

  /** @param {Entry} entry @param {Element|DOMRect} anchor */
  _menu(entry, anchor) {
    if (this.mode === 'trash') {
      return menuPopover(anchor, [
        { label: tr('恢复'), icon: 'restore', fn: () => this._do(() => this.store.restore(entry.path)) },
        { label: tr('永久删除'), icon: 'trash', danger: true, fn: () => this._delete(entry) }]);
    }
    const fav = this.store.isFavorite(entry.path);
    /** @type {any[]} */
    const rows = [{ label: tr('重命名'), icon: 'rename', fn: () => this._rename(entry) }];
    if (entry.isDir) {
      rows.push({ label: tr('自定义颜色'), icon: 'palette', fn: () => this._folderColor(entry) },
        { label: tr('设置图标'), icon: 'smile', fn: () => this._folderIcon(entry) },
        { label: tr('导出文件夹…'), icon: 'share', fn: () => this.exportFolder(entry.path) });
    }
    rows.push(null,
      { label: tr('移动到…'), icon: 'move', fn: () => this._move(entry) },
      { label: fav ? tr('取消收藏') : tr('收藏'), icon: 'star', fn: () => this._do(() => this.store.toggleFavorite(entry.path)) },
      null,
      { label: tr('移到废纸篓'), icon: 'trash', danger: true, fn: () => this._do(() => this.store.trash(entry.path)) });
    return menuPopover(anchor, rows);
  }

  /** @param {Element} anchor */
  _newMenu(anchor) {
    menuPopover(anchor, [
      { label: tr('笔记本'), icon: 'cover', fn: () => this._newNotebook() },
      { label: tr('白板'), icon: 'board', fn: () => this._newBoard() },
      { label: tr('导入 PDF 或 Goodnotes…'), icon: 'share', fn: () => this.hooks.onImport(this.folder) },
      { label: tr('导入整个文件夹…'), icon: 'documents', fn: () => this.importFolder() },
      { label: tr('导入存档（.zip）…'), icon: 'restore', fn: () => this.importArchive() },
      null,
      { label: tr('文件夹'), icon: 'documents', fn: () => this._newFolder() }], { align: 'end' });
  }

  /** A right click beside the items: undoing and redoing moves. @param {MouseEvent} e */
  _besideMenu(e) {
    e.preventDefault();
    if (this.mode !== 'docs' || !(this.undoStack.length || this.redoStack.length)) return;
    /** @type {any[]} */
    const rows = [];
    if (this.undoStack.length) rows.push({ label: tr('撤销移动'), icon: 'undo', fn: () => this.undoMove() });
    if (this.redoStack.length) rows.push({ label: tr('重做移动'), icon: 'redo', fn: () => this.redoMove() });
    menuPopover(new DOMRect(e.clientX, e.clientY, 0, 0), rows);
  }

  /** @param {() => Promise<any>|any} fn */
  async _do(fn) {
    try { await fn(); } catch (e) { this.hooks.onError(tr('操作失败'), e); }
    await this.refresh();
  }

  // -- actions ---------------------------------------------------------------------

  async _create(template, title, fallback, cover = null) {
    try {
      const path = await this.store.newNotebook(this.folder, template, title.replaceAll('/', '-') || fallback, cover);
      this.hooks.onOpen(path);
    } catch (e) { this.hooks.onError(tr('无法创建'), e); }
  }

  async _newNotebook() {
    const r = await paperDialog({ template: this.settings.template, heading: tr('新建笔记本'), applyLabel: tr('创建笔记本'), title: '' })
      .catch(e => { this.hooks.onError(tr('无法创建'), e); return null; });
    if (!r) return;
    this.settings.template = { ...r.template, color: [...r.template.color] };
    this.hooks.saveSettings();
    await this._create(r.template, r.title, tr('未命名笔记'), r.cover);
  }

  async _newBoard() {
    const r = await paperDialog({ template: { w: 1, h: 1, paper: 'dots', color: [1, 1, 1] }, heading: tr('新建白板'), applyLabel: tr('创建白板'), title: '', board: true })
      .catch(e => { this.hooks.onError(tr('无法创建'), e); return null; });
    if (r) await this._create(r.template, r.title, tr('未命名白板'));
  }

  async _newFolder() {
    const name = await askText(tr('新建文件夹'), { value: tr('新文件夹') });
    if (name && name.trim()) await this._do(() => this.store.newFolder(this.folder, name.trim()));
  }

  /** @param {Entry} entry */
  async _rename(entry) {
    const name = await askText(tr('重命名'), { value: entry.name });
    if (name && name.trim()) await this._do(() => this.store.rename(entry.path, name));
  }

  /** @param {Entry} entry */
  async _move(entry) {
    const folder = await pickFolder(this.store, trf('移动“%s”到', entry.name), entry.isDir ? [entry.path] : []);
    if (folder !== null) await this.moveItems([entry.path], folder);
  }

  /** @param {Entry} entry */
  async _delete(entry) {
    if (await confirm(trf('永久删除“%s”？', entry.name), tr('它会从废纸篓消失，但仍保留在本机缓存和云端，直到你在设置中清理缓存。'), { ok: tr('永久删除'), danger: true })) {
      await this._do(() => this.store.delete(entry.path));
    }
  }

  async _emptyTrash() {
    if (!(await confirm(tr('清空废纸篓？'), tr('其中的内容会从废纸篓消失，但仍保留在本机缓存和云端，直到你在设置中清理缓存。'), { ok: tr('清空'), danger: true }))) return;
    await this._do(async () => { for (const e of await this.store.trashed()) await this.store.delete(e.path); });
  }

  /** A grid of buttons in a small dialog; cells are [content, value]. @param {string} heading @param {[Node, any][]} cells @param {number} columns */
  _choice(heading, cells, columns) {
    return showDialog({
      className: 'alert', dismissed: undefined,
      build: close => [h('h2', null, heading), h('div', { class: 'choice-grid', style: { gridTemplateColumns: `repeat(${columns}, auto)` } },
        cells.map(([child, value]) => h('button', { class: 'flat choice-cell', onClick: () => close(value) }, child)))],
      footer: close => [h('button', { onClick: () => close(undefined) }, tr('取消'))],
    });
  }

  /** @param {Entry} entry */
  async _folderColor(entry) {
    const c = await this._choice(tr('文件夹颜色'), FOLDER_COLORS.map(col => [swatchIcon(col, false, 34), col]), 4);
    if (c) await this._do(() => this.store.setFolderStyle(entry.path, { color: c }));
  }

  /** @param {Entry} entry */
  async _folderIcon(entry) {
    const c = await this._choice(tr('文件夹图标'), ['', ...GLYPH_NAMES].map(g => [g ? glyph(g, 30) : icon('none', 30), g]), 6);
    if (c !== undefined) await this._do(() => this.store.setFolderStyle(entry.path, { icon: c }));
  }

  // -- moving items ------------------------------------------------------------------

  /**
   * Move items into a folder, as one step that can be undone. Items already there, and a folder
   * asked to go inside itself, are left alone.
   * @param {string[]} paths @param {string} folder @returns {Promise<number>}
   */
  async moveItems(paths, folder) {
    /** @type {[string, string][]} */
    const done = [];
    for (const path of paths) {
      if (dirname(path) === folder || folder === path || within(folder, path)) continue;
      try { done.push([path, await this.store.move(path, folder)]); } catch (e) { this.hooks.onError(tr('操作失败'), e); break; }
    }
    if (done.length) {
      this.undoStack.push(done);
      if (this.undoStack.length > 50) this.undoStack.splice(0, this.undoStack.length - 50);
      this.redoStack.length = 0;
      const where = folder === '' ? tr('文稿') : basename(folder);
      toast(trf('已将 %d 项移到“%s”', done.length, where), { action: { label: tr('撤销'), fn: () => this.undoMove() } });
    }
    this.selected.clear();
    this.selecting = false;
    await this.refresh();
    return done.length;
  }

  /** Take the last move back (or do it again): everything returns to where, and to the name, it had. */
  async _replay(source, dest) {
    if (this.mode !== 'docs' || !source.length) return false;
    /** @type {[string, string][]} */
    const back = [];
    for (const [before, after] of [...source.pop()].reverse()) {
      if (!(await this.store.vfs.exists(after)) || (dirname(before) !== '' && !(await this.store.vfs.isDir(dirname(before))))) continue;   // changed since by something else; leave it be
      try { back.push([after, await this.store.move(after, dirname(before), basename(before))]); } catch (e) { this.hooks.onError(tr('操作失败'), e); break; }
    }
    if (back.length) dest.push(back);
    await this.refresh();
    return true;
  }

  async undoMove() {
    if (await this._replay(this.undoStack, this.redoStack)) { toast(tr('已撤销移动')); return true; }
    return false;
  }

  async redoMove() {
    if (await this._replay(this.redoStack, this.undoStack)) { toast(tr('已重做移动')); return true; }
    return false;
  }

  // -- dragging items into folders ----------------------------------------------------

  /** Let dragged items be dropped on an element, to go into the folder it stands for. @param {HTMLElement} el @param {() => string} folder */
  _dropTarget(el, folder) {
    el.dataset.drop = '1';
    /** @type {any} */ (el)._dropFolder = folder;
  }

  /** @param {HTMLElement} cell @param {Entry} entry */
  _dragSource(cell, entry) {
    cell.addEventListener('pointerdown', e => {
      if (e.button !== 0 || /** @type {Element} */ (e.target).closest('button')) return;
      const x0 = e.clientX, y0 = e.clientY, id = e.pointerId, touch = e.pointerType === 'touch';
      let started = false, ghost = /** @type {HTMLElement|null} */ (null), over = /** @type {HTMLElement|null} */ (null);
      let hold = touch ? setTimeout(() => begin(), 450) : 0;
      const stopTouchScroll = (/** @type {Event} */ ev) => ev.preventDefault();
      const begin = () => {
        if (started) return;
        started = true;
        // Dragging one of several selected items takes them all along.
        this.dragging = this.selecting && this.selected.has(entry.path) ? [...this.selected] : [entry.path];
        const cover = cell.querySelector('.frame');
        ghost = h('div', { class: 'drag-ghost' }, cover ? /** @type {Node} */ (cover.cloneNode(true)) : null, this.dragging.length > 1 ? h('span', { class: 'drag-count' }, String(this.dragging.length)) : null);
        document.body.append(ghost);
        try { cell.setPointerCapture(id); } catch { /* the pointer is gone */ }
        addEventListener('touchmove', stopTouchScroll, { passive: false });
        document.body.classList.add('dragging-items');
        place(x0, y0);
      };
      const place = (/** @type {number} */ x, /** @type {number} */ y) => {
        if (ghost) { ghost.style.left = x - 20 + 'px'; ghost.style.top = y - 20 + 'px'; }
        const t = /** @type {HTMLElement|null} */ (document.elementsFromPoint(x, y).find(n => n instanceof HTMLElement && n.dataset.drop && n !== cell && !ghost?.contains(n)) || null);
        if (t !== over) { over?.classList.remove('drop-active'); over = t; over?.classList.add('drop-active'); }
      };
      const move = (/** @type {PointerEvent} */ ev) => {
        if (ev.pointerId !== id) return;
        if (!started) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= 8) return;
          if (touch) { cleanup(); return; }   // a finger that moves first is scrolling
          begin();
        }
        place(ev.clientX, ev.clientY);
      };
      const cleanup = () => {
        clearTimeout(hold);
        removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel);
        removeEventListener('touchmove', stopTouchScroll);
        document.body.classList.remove('dragging-items');
        ghost?.remove();
        over?.classList.remove('drop-active');
      };
      const up = (/** @type {PointerEvent} */ ev) => {
        if (ev.pointerId !== id) return;
        if (started) place(ev.clientX, ev.clientY);
        const target = over;
        const paths = [...this.dragging];
        const wasDragging = started;
        cleanup();
        this.dragging = [];
        if (wasDragging) {
          this._suppressClick = true;
          setTimeout(() => { this._suppressClick = false; }, 0);
          const folder = target && /** @type {any} */ (target)._dropFolder?.();
          if (typeof folder === 'string') setTimeout(() => this.moveItems(paths, folder), 0);   // after the drag has ended: the item dropped on may itself be rebuilt
        }
      };
      const cancel = () => { cleanup(); this.dragging = []; };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', cancel);
    });
  }

  // -- rubber band and selection --------------------------------------------------------

  _wireBand() {
    this.scroller.addEventListener('pointerdown', e => {
      // A drag that starts on an item carries the item; the rubber band is for the space between. Fingers scroll.
      if (e.pointerType !== 'mouse' || e.button !== 0 || /** @type {Element} */ (e.target).closest('.cell, button')) return;
      const box = this.scroller.getBoundingClientRect();
      const x0 = e.clientX - box.left + this.scroller.scrollLeft, y0 = e.clientY - box.top + this.scroller.scrollTop;
      const keep = (e.ctrlKey || e.shiftKey || e.metaKey) && this.selecting ? new Set(this.selected) : new Set();
      let on = false;
      const move = (/** @type {PointerEvent} */ ev) => {
        const x = ev.clientX - box.left + this.scroller.scrollLeft, y = ev.clientY - box.top + this.scroller.scrollTop;
        if (!on) {
          if (Math.hypot(x - x0, y - y0) < 8 || this.scroller.hidden) return;
          on = true;
          this.selecting = true;
          this.band.hidden = false;
        }
        const r = { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
        Object.assign(this.band.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        const hit = new Set(keep);
        this.grid.querySelectorAll('.cell').forEach(c => {
          const b = c.getBoundingClientRect();
          const cx0 = b.left - box.left + this.scroller.scrollLeft, cy0 = b.top - box.top + this.scroller.scrollTop;
          if (cx0 < r.x + r.w && cx0 + b.width > r.x && cy0 < r.y + r.h && cy0 + b.height > r.y) hit.add(/** @type {HTMLElement} */ (c).dataset.path);
        });
        this.selected = /** @type {Set<string>} */ (hit);
        this._syncSelection();
      };
      const up = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up);
        this.band.hidden = true;
        if (on && !this.selected.size) this.setSelecting(false);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }

  /** @param {boolean} on */
  setSelecting(on) {
    this.selecting = on;
    if (!on) this.selected.clear();
    this._syncSelection();
  }

  _selectAll() {
    const paths = new Set(this.entries.map(e => e.path));
    this.selected = this.selected.size === paths.size && [...paths].every(p => this.selected.has(p)) ? new Set() : paths;
    this._syncSelection();
  }

  /** Bring the bars, the action buttons and the cell highlights in line with the selection. */
  _syncSelection() {
    const on = this.selecting;
    this.selbar.hidden = !on;
    this.bar.hidden = on;
    this.grid.querySelectorAll('.cell').forEach(c => {
      const p = /** @type {HTMLElement} */ (c).dataset.path;
      c.classList.toggle('picked', (on && this.selected.has(/** @type {string} */ (p))) || (!on && p === this.cursor));
    });
    if (!on) return;
    const n = this.selected.size;
    this.selCount.textContent = trf('已选择 %d 项', n);
    /** @type {[string, string, () => void, string][]} */
    const actions = this.mode === 'trash'
      ? [['restore', tr('恢复'), () => this._sel_restore(), ''], ['trash', tr('永久删除'), () => this._sel_delete(), 'danger']]
      : [['share', tr('导出'), () => this._sel_export(), ''], ['duplicate', tr('复制'), () => this._each(p => this.store.duplicate(p)), ''],
        ['move', tr('移动'), () => this._sel_move(), ''], ['trash', tr('废纸篓'), () => this._each(p => this.store.trash(p)), 'danger']];
    this.selActions.replaceChildren(...actions.map(([ic, text, fn, cls]) => h('button', { class: ['flat', cls], disabled: n === 0, onClick: fn }, icon(ic, 18), h('span', null, text))));
  }

  _picked() { return this.entries.filter(e => this.selected.has(e.path)); }

  /** Apply a store operation to every selected item, then leave selection mode. @param {(path: string) => Promise<any>} fn */
  async _each(fn) {
    for (const e of this._picked()) {
      try { await fn(e.path); } catch (err) { this.hooks.onError(tr('操作失败'), err); break; }
    }
    this.selected.clear();
    this.selecting = false;
    await this.refresh();
  }

  async _sel_restore() { await this._each(p => this.store.restore(p)); }

  async _sel_delete() {
    if (await confirm(trf('永久删除 %d 项？', this.selected.size), tr('它会从废纸篓消失，但仍保留在本机缓存和云端，直到你在设置中清理缓存。'), { ok: tr('永久删除'), danger: true })) {
      await this._each(p => this.store.delete(p));
    }
  }

  async _sel_move() {
    const entries = this._picked();
    const folder = await pickFolder(this.store, trf('移动 %d 项到', entries.length), entries.filter(e => e.isDir).map(e => e.path));
    if (folder !== null) await this.moveItems(entries.map(e => e.path), folder);
  }

  async _sel_export() {
    const entries = this._picked();
    const name = (entries.length === 1 ? entries[0].name : 'Inkpad ' + fmtDate('%Y-%m-%d', now()).replace(/\s.*/, '')) + '.zip';
    try {
      const { blob, count } = await this.store.exportPaths(entries.map(e => e.path));
      if (await saveBlob(blob, name, { description: 'Zip', accept: { 'application/zip': ['.zip'] } })) {
        toast(trf('已导出 %d 本笔记', count));
        this.setSelecting(false);
      }
    } catch (e) { this.hooks.onError(tr('导出失败'), e); }
  }

  // -- archives and folders on disk --------------------------------------------------------

  /** Save a folder, or the whole library when folder is its root, as one zip file. @param {string} folder */
  async exportFolder(folder) {
    const whole = folder === '';
    const name = (whole ? 'Inkpad ' + fmtDate('%Y-%m-%d', now()) : basename(folder)) + '.zip';
    try {
      const { blob, count } = await this.store.exportArchive(folder);
      if (await saveBlob(blob, name, { description: 'Zip', accept: { 'application/zip': ['.zip'] } })) toast(trf('已导出 %d 本笔记', count));
    } catch (e) { this.hooks.onError(tr('导出失败'), e); }
  }

  async importArchive() {
    const folder = this.mode === 'docs' ? this.folder : '';
    const [file] = await pickFiles({ accept: '.zip,application/zip' });
    if (!file) return;
    try {
      const count = await this.store.importArchive(file, folder);
      await this.refresh();
      toast(trf('已导入 %d 本笔记', count));
    } catch (e) { this.hooks.onError(tr('导入失败'), e); }
  }

  /** Pick a folder and import everything in it, subfolders and all. */
  async importFolder() {
    const dest = this.mode === 'docs' ? this.folder : '';
    const files = await pickFiles({ directory: true, multiple: true });
    if (!files.length) return;
    await this.hooks.importTree(pickedTree(files), dest);
    await this.refresh();
  }
}
