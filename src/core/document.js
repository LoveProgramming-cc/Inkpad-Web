// @ts-check
// The document: pages, undo history, item-by-item merging and the .inkpad file format.
// Translated from B:model.py `Document`, `merge`, `notebook_id`, `set_notebook_id`.
// Saving to storage (`save`, `absorb`, `stale`) is added with the storage layer.
import { union } from './geom.js';
import { KINDS, SaveCtx, itemId, newId } from './items.js';
import { Page } from './page.js';
import { PdfDoc } from './pdfdoc.js';
import { ZipReader, ZipWriter } from './zip.js';
import { md5Hex } from './hash.js';
import { now } from './clock.js';
import { tr } from './i18n.js';
import { pageBox } from './page.js';
import { vfs, withFileLock } from './storage.js';
import { hexId } from './uuid.js';

export const GONE_LIMIT = 20000;

export { Changed } from './errors.js';

/** @param {string} text */
function digest(text) { return md5Hex(text).slice(0, 16); }

/** A page's settings: what is kept in document.json about it, apart from what is drawn on it. */
const SETTINGS = ['w', 'h', 'paper', 'color', 'board', 'pdf', 'pdfPage', 'rot', 'bookmark', 'outline'];

/** @param {Page} page */
function pageSign(page) {
  return JSON.stringify([page.w, page.h, page.paper, page.color, !!page.board,
    page.pdf ? page.pdf.key : null, page.pdfPage, page.rot, !!page.bookmark, page.outline || null]);
}

/** @param {Set<string>} s */
function lastSorted(s) {
  // Python's sorted(set)[-LIMIT:]: sorted by string value, the end of the list.
  const a = [...s].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return a.length > GONE_LIMIT ? a.slice(-GONE_LIMIT) : a;
}

/** Renders a designed cover to PNG; installed by the rendering code (M3). Documents without
 * one get a 1x1 picture, which is all the tests need.
 * @type {((doc: Document) => Promise<Blob>) | null} */
let coverRenderer = null;
/** @param {typeof coverRenderer} fn */
export function setCoverRenderer(fn) { coverRenderer = fn; }

const BLANK_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

/**
 * @typedef {['items', Page, [number, any][], [number, any][]]} ItemsAction
 */

export class Document {
  /** @param {object|null} [template] page settings for the first page */
  constructor(template = null) {
    this.pages = [new Page(template || {})];
    /** @type {string|null} */
    this.path = null;
    this.rev = 0;
    this.savedRev = 0;
    /** @type {any[]} */
    this.undoStack = [];
    /** @type {any[]} */
    this.redoStack = [];
    /** @type {Set<(...e: any[]) => void>} */
    this.listeners = new Set();
    /** @type {Blob|null} */
    this._cover = null;
    this.id = hexId();   // stable across renames and moves; what sync tracks
    /** @type {Set<string>} */
    this.gonePages = new Set();                           // ids of pages removed from the document
    /** @type {[string, number[]]|null} */
    this.coverSpec = null;                                // [style, colour] of a designed cover; null shows the first page
    /** @type {string|null} */
    this.sign = null;                                     // the file's sign as this document last read or wrote it
    /** @type {import('../platform/vfs.js').Vfs|null} */
    this.store = null;                                    // where the file is; the app's one store unless set
    this.orderMt = 0.0;                                   // when the pages were last put in another order
    /** @type {string[]|null} */
    this._order = null;                                   // ...and the order they were in when that was last looked at
  }

  get modified() { return this.rev !== this.savedRev; }

  /** Listeners get ('added', page, items) for a pure append, ('dirty', page, rect) for anything
   * else on one page, ('pages') for structure changes, ('meta') for bookmarks and outline, and
   * ('state') whenever the undo or saved state may have changed. Returns an unsubscribe function.
   * @param {(...e: any[]) => void} fn */
  listen(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @param {string} kind @param {...any} args */
  emit(kind, ...args) {
    if (kind === 'pages' || ((kind === 'added' || kind === 'dirty') && this.pages.length && args[0] === this.pages[0])) {
      this._cover = null;
    }
    for (const fn of [...this.listeners]) fn(kind, ...args);
  }

  /** Mark a change that is not on the undo stack (bookmarks, outline). */
  touch() {
    this.rev += 1;
    this.emit('meta');
    this.emit('state');
  }

  // -- undo ---------------------------------------------------------------
  // Undo actions are plain objects:
  //   {kind: 'items', page, removed, added}  with [[index, item], ...] lists
  //   {kind: 'pages', removed, added}        with [[index, page], ...] lists
  //   {kind: 'template', page, old, new}     with Page.template() objects

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  do(action) {
    this._apply(action, true);
    this.push(action);
  }

  /** Note what an action changed: the page is dirty, and removed items leave tombstones. */
  _mark(action, forward = true) {
    if (action.kind === 'items') {
      const { page, removed, added } = action;
      const [out, into] = forward ? [removed, added] : [added, removed];
      page.rev += 1;
      const kept = new Set(into.map(([, it]) => it));
      for (const [, it] of out) if (!kept.has(it)) page.gone.add(itemId(it));
      for (const [, it] of into) page.gone.delete(itemId(it));
    } else if (action.kind === 'pages') {
      const { removed, added } = action;
      const [out, into] = forward ? [removed, added] : [added, removed];
      for (const [, page] of out) this.gonePages.add(page.id);
      for (const [, page] of into) this.gonePages.delete(page.id);
    }
  }

  /** Record an action whose effect is already applied. */
  push(action) {
    this._mark(action);
    this.undoStack.push(action);
    if (this.undoStack.length > 300) this.undoStack.splice(0, this.undoStack.length - 300);
    this.redoStack.length = 0;
    this.rev += 1;
    this.emit('state');
  }

  undo() {
    const action = this.undoStack.pop();
    if (action) {
      this._apply(action, false);
      this._mark(action, false);
      this.redoStack.push(action);
      this.rev += 1;
      this.emit('state');
    }
  }

  redo() {
    const action = this.redoStack.pop();
    if (action) {
      this._apply(action, true);
      this._mark(action, true);
      this.undoStack.push(action);
      this.rev += 1;
      this.emit('state');
    }
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Take `out` away from `seq`, then put `into` back at its indexes (in index order). */
  static _swap(seq, out, into) {
    const gone = new Set(out.map(([, obj]) => obj));
    let w = 0;
    for (let r = 0; r < seq.length; r++) if (!gone.has(seq[r])) seq[w++] = seq[r];
    seq.length = w;
    for (const [index, obj] of [...into].sort((a, b) => a[0] - b[0])) seq.splice(Math.min(index, seq.length), 0, obj);
  }

  _apply(action, forward) {
    if (action.kind === 'items') {
      const { page, removed, added } = action;
      const [out, into] = forward ? [removed, added] : [added, removed];
      const before = page.items.length;
      Document._swap(page.items, out, into);
      if (!out.length && into.length && Math.min(...into.map(([i]) => i)) >= before) {
        this.emit('added', page, into.map(([, it]) => it));
      } else {
        let rect = null;
        for (const [, it] of [...out, ...into]) rect = union(rect, it.bbox);
        this.emit('dirty', page, rect);
      }
    } else if (action.kind === 'pages') {
      const { removed, added } = action;
      const [out, into] = forward ? [removed, added] : [added, removed];
      Document._swap(this.pages, out, into);
      this.emit('pages');
    } else if (action.kind === 'template') {
      const { page, old, new: now_ } = action;
      Object.assign(page, forward ? now_ : old);
      this.emit('pages');
      this.emit('dirty', page, null);
    }
  }

  addItems(page, items) {
    const n = page.items.length;
    this.do({ kind: 'items', page, removed: [], added: items.map((it, i) => [n + i, it]) });
  }

  removeItems(page, items) {
    const index = new Map(page.items.map((it, i) => [it, i]));
    this.do({ kind: 'items', page, removed: items.map(it => [index.get(it), it]), added: [] });
  }

  replaceItems(page, olds, news) {
    const index = new Map(page.items.map((it, i) => [it, i]));
    const pairs = olds.map((o, i) => [o, news[i]]).sort((a, b) => index.get(a[0]) - index.get(b[0]));
    this.do({
      kind: 'items', page,
      removed: pairs.map(([o]) => [index.get(o), o]),
      added: pairs.map(([o, n]) => [index.get(o), n]),
    });
  }

  /** Record an edit made directly on page.items, given the list from before it. */
  pushDiff(page, before) {
    const nowSet = new Set(page.items), old = new Set(before);
    const removed = [], added = [];
    before.forEach((it, i) => { if (!nowSet.has(it)) removed.push([i, it]); });
    page.items.forEach((it, i) => { if (!old.has(it)) added.push([i, it]); });
    if (removed.length || added.length) this.push({ kind: 'items', page, removed, added });
  }

  // -- PDF ------------------------------------------------------------------

  /** One page per page of the PDF, each with the PDF page as its background. @param {PdfDoc} pdf */
  static async pdfPages(pdf) {
    const n = await pdf.nPages();
    const pages = [];
    for (let i = 0; i < n; i++) {
      const [w, h] = await pdf.pageSize(i);
      pages.push(new Page({ w, h, pdf, pdfPage: i }));
    }
    return pages;
  }

  /** A notebook made of a PDF. @param {Blob} blob */
  static async fromPdf(blob) {
    const doc = new Document();
    doc.pages = await Document.pdfPages(await PdfDoc.fromBlob(blob));
    doc.rev = 1;   // not on disk yet
    return doc;
  }

  // -- cover --------------------------------------------------------------

  setCover(spec) {
    this.coverSpec = spec;
    this._cover = null;
    this.touch();
  }

  displayName() {
    if (!this.path) return tr('未命名笔记');
    const base = this.path.slice(this.path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  }

  /** The cover as PNG: the designed one, or the first page shrunk. @returns {Promise<Blob>} */
  async cover() {
    if (!this._cover) {
      const png = coverRenderer ? await coverRenderer(this) : new Blob([BLANK_PNG], { type: 'image/png' });
      // A change made while the picture was being drawn has dropped the cache already; do not put a stale one back.
      this._cover ??= png;
    }
    return this._cover;
  }

  // -- file format --------------------------------------------------------
  // The file is a zip:
  //   document.json    the page list (id, size, paper, background, bookmark, ...) and what
  //                    was removed from it
  //   pages/<id>.json  one page's items, each with a permanent id, and the ids of the items
  //                    that were removed from the page
  //   pdf/N.pdf, img/N.png, cover.png, id
  // Pages are separate so that only a changed page is serialised again, and items have ids
  // and leave tombstones so that two versions of a notebook can be merged item by item.

  /** Note the time on the settings of every page that has changed them, and on the order of
   * the pages if that has changed, since this was last done. When two versions of a notebook
   * are merged, the later change is the one that stays. */
  stamp() {
    const t = now();
    for (const page of this.pages) {
      const sign = pageSign(page);
      if (sign !== page._sign) { page.mt = t; page._sign = sign; }
    }
    const ids = this.pages.map(p => p.id);
    if (this._order !== null && this._order.join() !== ids.join()) {
      const here = new Set(ids), before = new Set(this._order);
      if (this._order.filter(i => here.has(i)).join() !== ids.filter(i => before.has(i)).join()) this.orderMt = t;
    }
    this._order = ids;
  }

  /**
   * Everything needed to write the file, as data that no further editing can change.
   * The part that looks at the document runs before the first await.
   */
  async snapshot() {
    this.stamp();
    const ctx = new SaveCtx();
    /** @type {PdfDoc[]} */
    const pdfs = [];
    const pdfIndex = new Map();
    const pages = [];
    /** @type {Record<string, string>} */
    const blobs = {};
    for (const page of this.pages) {
      /** @type {any} */
      const d = { id: page.id, w: page.w, h: page.h, paper: page.paper, color: [...page.color] };
      if (page.board) d.board = true;
      if (page.pdf) {
        // Provisional number by identity; equal copies are folded together below.
        if (!pdfIndex.has(page.pdf)) { pdfIndex.set(page.pdf, pdfs.length); pdfs.push(page.pdf); }
        d.pdf = pdfIndex.get(page.pdf);
        d.pdf_page = page.pdfPage;
        d.rot = page.rot;
      }
      if (page.bookmark) d.bookmark = true;
      if (page.outline) d.outline = page.outline;
      if (page.mt) d.mt = page.mt;
      pages.push(d);
      const hasImage = page.items.some(it => it.kind === 'i');
      if (page._blob === null || page._blob[0] !== page.rev || hasImage) {
        const items = [];
        for (const it of page.items) {
          const data = it.toData(ctx);
          data.id = itemId(it);
          items.push(data);
        }
        // Tombstones are only needed until every device has seen the removal; cap them.
        page._blob = [page.rev, JSON.stringify({ items, gone: lastSorted(page.gone) })];
      }
      blobs[page.id] = page._blob[1];
    }
    const rev = this.rev, id = this.id, gone = lastSorted(this.gonePages);
    const orderMt = this.orderMt, coverSpec = this.coverSpec;
    // The same PDF is written once. The key only picks out which ones to look at: two are the
    // same when their content is.
    /** @type {PdfDoc[]} */
    const unique = [];
    const slots = new Map();
    const final = [];
    for (const pdf of pdfs) {
      const list = slots.get(pdf.key) || [];
      let found = list.find(n => unique[n] === pdf);
      if (found === undefined) for (const n of list) if (await unique[n].sameAs(pdf)) { found = n; break; }
      if (found === undefined) { found = unique.length; unique.push(pdf); list.push(found); slots.set(pdf.key, list); }
      final.push(found);
    }
    for (const d of pages) if ('pdf' in d) d.pdf = final[d.pdf];
    /** @type {any} */
    const meta = { format: 'inkpad', version: 3, pages, id, gone };
    if (orderMt) meta.order_mt = orderMt;
    if (coverSpec !== null) meta.cover = [coverSpec[0], [...coverSpec[1]]];
    return { json: JSON.stringify(meta), pages: blobs, pdfs: unique.map(p => p.blob), images: [...ctx.images], cover: await this.cover(), rev, id };
  }

  _vfs() { return this.store ?? vfs(); }

  /** Whether the file was written by something else (a sync) since this document read it. */
  async stale() {
    if (this.path === null || this.sign === null) return false;
    const st = await this._vfs().stat(this.path);
    return st !== null && st.sign !== this.sign;
  }

  /** Take in what something else wrote to the file, keeping what was done here since. */
  absorb() {
    return withFileLock(() => this._absorb());
  }

  /** `absorb` without the lock, for callers that hold it (the lock is not reentrant). */
  async _absorb() {
    const file = await this._vfs().readFile(/** @type {string} */ (this.path));
    if (!file) return;
    const other = await Document.load(file.blob, { path: this.path, sign: file.sign, vfs: this.store });
    this.sign = other.sign;
    if (merge(this, other).some(Boolean)) {
      this.emit('pages');
      for (const page of this.pages) this.emit('dirty', page, null);
    }
    this.emit('state');
  }

  /**
   * Write the notebook to its file (or to `path`, which then becomes its file). Never writes over
   * what a sync brought: that is folded in first. With `expect`, the sign this document knows
   * the file by, it throws Changed instead if something else has written it since.
   * @param {string|null} [path] @param {{expect?: string|null}} [o]
   */
  save(path = null, o = {}) {
    return withFileLock(() => this._save(path, o));
  }

  /** `save` without the lock, for callers that hold it (the lock is not reentrant).
   * @param {string|null} [path] @param {{expect?: string|null}} [o] */
  async _save(path = null, { expect = null } = {}) {
    const target = path || this.path;
    if (!target) throw new Error('no path to save to');
    if (target === this.path && expect === null && await this.stale()) {
      try { await this._absorb(); } catch { /* unreadable; this document is the better of the two */ }
    }
    const snap = await this.snapshot();
    const blob = await Document.encode(snap);
    this.sign = await this._vfs().write(target, blob, { expect, cover: snap.cover, id: this.id });
    this.path = target;
    this.savedRev = snap.rev;
    this.emit('state');
  }

  /** The file for a snapshot. @param {Awaited<ReturnType<Document['snapshot']>>} snap @returns {Promise<Blob>} */
  static async encode(snap) {
    const z = new ZipWriter();
    await z.add('document.json', snap.json);
    for (const [pageId, text] of Object.entries(snap.pages)) await z.add(`pages/${pageId}.json`, text);
    await z.add('id', snap.id, { compress: false });
    await z.add('cover.png', snap.cover, { compress: false });
    for (let i = 0; i < snap.pdfs.length; i++) await z.add(`pdf/${i}.pdf`, snap.pdfs[i], { compress: false });  // stored: PDFs are already compressed
    for (let i = 0; i < snap.images.length; i++) await z.add(`img/${i}.png`, snap.images[i], { compress: false });
    return z.finish();
  }

  /**
   * @param {Blob} blob the .inkpad file
   * @param {{path?: string|null, sign?: string|null, vfs?: import('../platform/vfs.js').Vfs|null}} [o]
   * @returns {Promise<Document>}
   */
  static async load(blob, { path = null, sign = null, vfs: store = null } = {}) {
    const z = await ZipReader.open(blob);
    const meta = JSON.parse(await z.text('document.json'));
    if (meta.format !== 'inkpad') throw new Error(tr('不是 Inkpad 文档'));
    // The same PDF or picture stored twice is read once, and so saved once from then on.
    /** @type {PdfDoc[]} */
    const pdfs = [];
    /** @type {Map<string, PdfDoc[]>} */
    const samePdf = new Map();
    for (let n = 0; z.has(`pdf/${n}.pdf`); n++) {
      const e = /** @type {import('./zip.js').ZipEntry} */ (z.entry(`pdf/${n}.pdf`));
      // A size and checksum seen before is a sign that it may be a second copy; it is one when its content is the same.
      const key = `${e.size}/${e.crc}`;
      const data = await z.blobOf(e.name);
      const fresh = new PdfDoc(data, key);
      let twin = null;
      for (const p of samePdf.get(key) || []) if (await p.sameAs(fresh)) { twin = p; break; }
      if (!twin) { twin = fresh; samePdf.set(key, [...(samePdf.get(key) || []), fresh]); }
      pdfs.push(twin);
    }
    const ctx = new SaveCtx();
    /** @type {Map<string, Blob[]>} */
    const sameImage = new Map();
    for (let n = 0; z.has(`img/${n}.png`); n++) {
      const e = /** @type {import('./zip.js').ZipEntry} */ (z.entry(`img/${n}.png`));
      const key = `${e.size}/${e.crc}`;
      const data = await z.blobOf(e.name);
      let twin = null;
      for (const other of sameImage.get(key) || []) if (await sameBytes(other, data)) { twin = other; break; }
      if (!twin) { twin = data; sameImage.set(key, [...(sameImage.get(key) || []), data]); }
      ctx.images.push(twin);
    }
    /** @type {Map<string, any>} */
    const contents = new Map();
    for (const d of meta.pages) {
      if (d.id && z.has(`pages/${d.id}.json`)) contents.set(d.id, JSON.parse(await z.text(`pages/${d.id}.json`)));
    }
    const doc = new Document();
    doc.id = meta.id || doc.id;
    doc.pages = [];
    for (const [n, d] of meta.pages.entries()) {
      const page = new Page({ w: d.w, h: d.h, paper: d.paper ?? 'blank', color: d.color ?? [1.0, 1.0, 1.0], board: d.board ?? false });
      if ('pdf' in d) {
        page.pdf = pdfs[d.pdf];
        page.pdfPage = d.pdf_page;
        page.rot = d.rot ?? 0;
      }
      page.bookmark = d.bookmark ?? false;
      page.outline = d.outline ?? null;
      // Files from before version 3 have no ids. B derives them from the content so that two
      // devices opening the same old file agree on them.
      page.id = d.id || digest(`${doc.id}/${n}`);
      const content = contents.get(page.id) ?? { items: d.items ?? [] };
      for (const data of content.items) {
        const item = KINDS[data.k].fromData(data, ctx);
        // Items of such files get a fresh id (A's way; B's content-derived ones cannot be
        // reproduced exactly without Python's float formatting - PORTING.md R11).
        item.id = data.id || newId();
        page.items.push(item);
      }
      page.gone = new Set(content.gone ?? []);
      page.mt = d.mt ?? 0.0;
      page._sign = pageSign(page);
      doc.pages.push(page);
    }
    if (!doc.pages.length) doc.pages = [new Page()];
    doc.gonePages = new Set(meta.gone ?? []);
    doc.orderMt = meta.order_mt ?? 0.0;
    doc._order = doc.pages.map(p => p.id);
    doc.path = path;
    doc.sign = sign;
    doc.store = store;
    const cover = meta.cover;
    if (cover) {
      // Older files stored a bare colour.
      doc.coverSpec = typeof cover[0] === 'string' ? [cover[0], [...cover[1]]] : ['simple', [...cover]];
    }
    return doc;
  }
}

/** @param {Blob} a @param {Blob} b */
async function sameBytes(a, b) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  const x = new Uint8Array(await a.arrayBuffer()), y = new Uint8Array(await b.arrayBuffer());
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Fold another version of the same notebook into mine, item by item.
 *
 * A page or an item that either side removed stays removed; everything else that either
 * side has is kept. A page's settings (paper, background, bookmark...) are those of the
 * side that changed them last, and so is the order of the pages. Returns what changed in
 * mine: [pages added, pages removed, items added, items removed, settings taken over].
 * @param {Document} mine @param {Document} theirs
 * @returns {[number, number, number, number, number]}
 */
export function merge(mine, theirs) {
  mine.stamp();
  theirs.stamp();
  const gonePages = new Set([...mine.gonePages, ...theirs.gonePages]);
  const counts = [0, 0, 0, 0, 0];
  const byId = new Map(mine.pages.map(p => [p.id, p]));
  const other = new Map(theirs.pages.map(p => [p.id, p]));
  // The pages are in the order of the side that arranged them last. A page only the other
  // side has goes after the page it follows there.
  const [lead, follow] = theirs.orderMt > mine.orderMt ? [theirs, mine] : [mine, theirs];
  const order = lead.pages.map(p => p.id);
  const have = new Set(order);
  /** @type {string|null} */
  let previous = null;
  for (const page of follow.pages) {
    if (!have.has(page.id)) {
      order.splice(previous !== null && have.has(previous) ? order.indexOf(previous) + 1 : order.length, 0, page.id);
      have.add(page.id);
    }
    previous = page.id;
  }
  const pages = order.filter(i => !gonePages.has(i)).map(i => byId.get(i) || other.get(i));
  const was = mine.pages.map(p => p.id);
  counts[0] = pages.filter(p => !byId.has(p.id)).length;
  mine.pages = pages.length ? pages : mine.pages.slice(0, 1);
  const nowIds = new Set(mine.pages.map(p => p.id));
  counts[1] = was.filter(i => !nowIds.has(i)).length;
  if (was.filter(i => nowIds.has(i)).join() !== mine.pages.filter(p => byId.has(p.id)).map(p => p.id).join()) counts[4] += 1;
  mine.orderMt = Math.max(mine.orderMt, theirs.orderMt);
  mine._order = mine.pages.map(p => p.id);
  let changed = false;
  for (const page of mine.pages) {
    const their = other.get(page.id);
    if (their === undefined || their === page) continue;
    if (their.mt > page.mt) {
      for (const key of SETTINGS) /** @type {any} */ (page)[key] = /** @type {any} */ (their)[key];
      page.mt = their.mt; page._sign = pageSign(page);
      counts[4] += 1;
    }
    const gone = new Set([...page.gone, ...their.gone]);
    const haveIds = new Set(page.items.map(itemId));
    const fresh = their.items.filter(/** @param {any} it */ it => !haveIds.has(itemId(it)) && !gone.has(itemId(it)));
    const kept = page.items.filter(/** @param {any} it */ it => !gone.has(itemId(it)));
    counts[2] += fresh.length;
    counts[3] += page.items.length - kept.length;
    if (fresh.length || kept.length !== page.items.length || gone.size !== page.gone.size) {
      page.items = kept.concat(fresh);
      page.gone = gone;
      page.rev += 1;
      changed = true;
    }
  }
  const goneChanged = gonePages.size !== mine.gonePages.size;
  if (changed || goneChanged || counts.some(Boolean)) {
    mine.gonePages = gonePages;
    mine.undoStack.length = 0;
    mine.redoStack.length = 0;
    mine.rev += 1;
  }
  return /** @type {[number, number, number, number, number]} */ (counts);
}

/**
 * The stable id of a notebook file, giving it one if it predates ids.
 * Returns the id and the file to keep (a new Blob when the id had to be added).
 * @param {Blob} blob @returns {Promise<{id: string, blob: Blob}>}
 */
export async function notebookId(blob) {
  const z = await ZipReader.open(blob);
  if (z.has('id')) return { id: await z.text('id'), blob };
  const id = hexId();
  const w = new ZipWriter();
  for (const e of z.entries) w.addRaw(e.name, { method: e.method, crc: e.crc, size: e.size, raw: await z.raw(e) });
  await w.add('id', id, { compress: false });
  return { id, blob: w.finish() };
}

/** Give a notebook file a different id (a file copied by hand shares its original's).
 * @param {Blob} blob @param {string} newId_ @returns {Promise<Blob>} */
export async function setNotebookId(blob, newId_) {
  const z = await ZipReader.open(blob);
  const w = new ZipWriter();
  const done = new Set();
  for (const e of z.entries) {
    if (e.name === 'id' || done.has(e.name)) continue;
    done.add(e.name);
    const last = /** @type {import('./zip.js').ZipEntry} */ (z.entry(e.name));
    if (e.name === 'document.json') {
      const meta = JSON.parse(await z.text('document.json'));
      meta.id = newId_;
      await w.add('document.json', JSON.stringify(meta));
    } else {
      w.addRaw(last.name, { method: last.method, crc: last.crc, size: last.size, raw: await z.raw(last) });
    }
  }
  await w.add('id', newId_, { compress: false });
  return w.finish();
}

export { pageBox };
