// @ts-check
// The notebook library: folders, notebooks, favourites, trash (B:library.py `Store`).
// Paths are the library's own ('' is the root); the trash is the hidden folder `.trash` and
// things deleted for good wait in `.deleted` until the cache is cleared.
import { Document, setNotebookId } from '../core/document.js';
import { coverOf, notebookIdOf } from '../core/notebook.js';
import { ZipReader, ZipWriter } from '../core/zip.js';
import { now } from '../core/clock.js';
import { tr } from '../core/i18n.js';
import { basename, dirname, join, splitext, within } from '../core/path.js';
import { copy } from '../core/settings.js';
import { hexId } from '../core/uuid.js';

export const EXT = '.inkpad';
export const ARCHIVE_META = 'inkpad-library.json';
export const TRASH = '.trash';
export const ARCHIVE = '.deleted';
export const FOLDER_COLORS = [[0.49, 0.74, 0.99], [0.36, 0.80, 0.82], [0.47, 0.80, 0.52], [0.98, 0.82, 0.38],
  [0.99, 0.66, 0.38], [0.96, 0.50, 0.50], [0.74, 0.60, 0.96], [0.66, 0.70, 0.76]];

/** @typedef {{path: string, name: string, isDir: boolean, mtime: number}} Entry */

/** @param {import('../platform/vfs.js').Stat} st @returns {Entry} */
function entryOf(st) {
  return { path: st.path, name: st.isDir ? st.name : splitext(st.name)[0], isDir: st.isDir, mtime: st.mtime };
}

/** The new id of a notebook that is a copy of another. */
const freshId = () => hexId();

/** "20261007-164500 " in local time, for names in .deleted. */
function stamp(t = now()) {
  const d = new Date(t * 1000);
  const p = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())} `;
}

export class Store {
  /** @param {import('../platform/vfs.js').Vfs} vfs */
  constructor(vfs) {
    this.vfs = vfs;
    this.root = '';
    /** @type {{favorites: string[], trashed: Record<string, string>, folders: Record<string, any>, archived?: Record<string, string>, ts?: number}} */
    this.meta = { favorites: [], trashed: {}, folders: {} };
  }

  /** @param {import('../platform/vfs.js').Vfs} vfs */
  static async open(vfs) {
    const store = new Store(vfs);
    await vfs.mkdir(TRASH);
    const saved = await vfs.kvGet('library');
    if (saved && typeof saved === 'object') store.meta = copy(saved);
    store.meta.favorites ??= [];
    store.meta.trashed ??= {};   // trash name -> folder it came from
    store.meta.folders ??= {};   // folder -> {color: [r, g, b], icon: name}
    return store;
  }

  /** Pick up favourites and folder styles that a sync brought in. */
  async reloadMeta() {
    const saved = await this.vfs.kvGet('library');
    if (saved && typeof saved === 'object') Object.assign(this.meta, copy(saved));
  }

  async _saveMeta() {
    this.meta.ts = now();
    await this.vfs.kvSet('library', this.meta);
  }

  // -- looking --

  /** What a folder shows: folders and notebooks, not what starts with a dot. @param {string} folder @returns {Promise<Entry[]>} */
  async entries(folder) {
    const out = [];
    for (const st of await this.vfs.list(folder)) {
      if (st.name.startsWith('.')) continue;
      if (st.isDir || st.name.endsWith(EXT)) out.push(entryOf(st));
    }
    return out;
  }

  /** @returns {Promise<Entry[]>} */
  async favorites() {
    const out = [];
    for (const rel of this.meta.favorites) {
      const st = await this.vfs.stat(rel);
      if (st) out.push(entryOf(st));
    }
    return out;
  }

  /** @param {string} path */
  isFavorite(path) { return this.meta.favorites.includes(path); }

  /** @param {string} path */
  async toggleFavorite(path) {
    const favs = this.meta.favorites;
    const i = favs.indexOf(path);
    if (i >= 0) favs.splice(i, 1); else favs.push(path);
    await this._saveMeta();
  }

  /** @param {string} path @returns {{color: number[], icon: string}} */
  folderStyle(path) {
    const style = this.meta.folders[path] || {};
    return { color: style.color || FOLDER_COLORS[0], icon: style.icon || '' };
  }

  /** @param {string} path @param {{color?: number[], icon?: string}} changes */
  async setFolderStyle(path, changes) {
    const style = (this.meta.folders[path] ??= {});
    Object.assign(style, changes);
    await this._saveMeta();
  }

  /** Every folder in the library as a tree read downwards: the root, then each folder followed
   * at once by everything inside it. @returns {Promise<string[]>} */
  async folders() {
    const { dirs } = await this.vfs.walk('');
    /** @type {Map<string, string[]>} */
    const kids = new Map();
    for (const d of dirs) {
      if (d.path.split('/').some(p => p.startsWith('.'))) continue;
      const parent = dirname(d.path);
      if (!kids.has(parent)) kids.set(parent, []);
      /** @type {string[]} */ (kids.get(parent)).push(d.path);
    }
    const out = [];
    const walk = (/** @type {string} */ folder) => {
      out.push(folder);
      const names = (kids.get(folder) || []).sort((a, b) => {
        const x = basename(a).toLowerCase(), y = basename(b).toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (const p of names) walk(p);
    };
    walk('');
    return out;
  }

  /** A path in `folder` that is free: "name", then "name 2", "name 3"... @param {string} folder @param {string} name */
  async unique(folder, name, ext = '') {
    let path = join(folder, name + ext);
    let n = 2;
    while (await this.vfs.exists(path)) {
      path = join(folder, `${name} ${n}${ext}`);
      n++;
    }
    return path;
  }

  // -- making --

  /** @param {string} folder @param {object} template @param {string|null} [name] @param {[string, number[]]|null} [cover] */
  async newNotebook(folder, template, name = null, cover = null) {
    const path = await this.unique(folder, name || tr('未命名笔记'), EXT);
    const doc = new Document(template);
    doc.store = this.vfs;
    doc.path = path;   // the cover shows the name
    doc.coverSpec = cover;
    await doc.save(path);
    return path;
  }

  /** @param {string} folder @param {string} name */
  async newFolder(folder, name) {
    const path = await this.unique(folder, name);
    await this.vfs.mkdir(path);
    return path;
  }

  // -- changing --

  /** Keep favourites pointing at an item (and what is inside it) after a move. */
  async _moved(oldPath, newPath) {
    const favs = this.meta.favorites;
    for (let i = 0; i < favs.length; i++) {
      if (within(favs[i], oldPath)) favs[i] = newPath + favs[i].slice(oldPath.length);
    }
    const styles = this.meta.folders;
    for (const rel of Object.keys(styles)) {
      if (within(rel, oldPath)) {
        styles[newPath + rel.slice(oldPath.length)] = styles[rel];
        delete styles[rel];
      }
    }
    await this._saveMeta();
  }

  /** @param {string} path @returns {Promise<boolean>} */
  _isDir(path) { return this.vfs.isDir(path); }

  /** @param {string} path @param {string} name @returns {Promise<string>} the new path */
  async rename(path, name) {
    name = name.trim().replaceAll('/', '-');
    const ext = (await this._isDir(path)) ? '' : EXT;
    if (!name || join(dirname(path), name + ext) === path) return path;
    const next = await this.unique(dirname(path), name, ext);
    await this.vfs.move(path, next);
    await this._moved(path, next);
    return next;
  }

  /** Move an item into a folder, under another name if one is given (as when a move is
   * undone and it gets back the name it had). Returns where it is now.
   * @param {string} path @param {string} folder @param {string|null} [name] */
  async move(path, folder, name = null) {
    const base = name || basename(path);
    if (dirname(path) === folder && base === basename(path)) return path;
    if (folder === path || within(folder, path)) throw new Error(tr('文件夹不能移动到它自己里面'));
    const [stem, ext] = (await this._isDir(path)) ? [base, ''] : splitext(base);
    const next = await this.unique(folder, stem, ext);
    await this.vfs.move(path, next);
    await this._moved(path, next);
    return next;
  }

  /** @param {string} path */
  async trash(path) {
    const base = basename(path);
    const [stem, ext] = (await this._isDir(path)) ? [base, ''] : splitext(base);
    const next = await this.unique(TRASH, stem, ext);
    this.meta.favorites = this.meta.favorites.filter(r => !within(r, path));
    this.meta.trashed[basename(next)] = dirname(path);
    await this.vfs.move(path, next);
    await this._saveMeta();
  }

  /** @returns {Promise<Entry[]>} */
  async trashed() { return this.entries(TRASH); }

  /** @param {string} path a path inside the trash */
  async restore(path) {
    const origin = this.meta.trashed[basename(path)] ?? '';
    delete this.meta.trashed[basename(path)];
    const folder = (await this._isDir(origin)) || origin === '' ? origin : '';
    const base = basename(path);
    const [stem, ext] = (await this._isDir(path)) ? [base, ''] : splitext(base);
    await this.vfs.move(path, await this.unique(folder, stem, ext));
    await this._saveMeta();
  }

  /** Remove something from the trash. It is kept out of sight until the cache is cleared. @param {string} path */
  async delete(path) {
    if (dirname(path) !== TRASH) throw new Error('only trashed items can be deleted');
    const base = basename(path);
    const [stem, ext] = (await this._isDir(path)) ? [base, ''] : splitext(base);
    const kept = await this.unique(ARCHIVE, stamp() + stem, ext);
    await this.vfs.move(path, kept);
    // Where it lived before the trash, so that it can be put back there.
    this.meta.archived ??= {};
    this.meta.archived[basename(kept)] = this.meta.trashed[base] ?? '';
    delete this.meta.trashed[base];
    await this._saveMeta();
  }

  /** Give a notebook file a new id. @param {string} path */
  async _reId(path) {
    const blob = await this.vfs.read(path);
    const id = freshId();
    await this.vfs.write(path, await setNotebookId(blob, id), { id });
  }

  /** A copy next to the original. Copies are notebooks of their own, with new ids. @param {string} path */
  async duplicate(path) {
    const base = basename(path);
    const isDir = await this._isDir(path);
    const [stem, ext] = isDir ? [base, ''] : splitext(base);
    const next = await this.unique(dirname(path), stem + tr(' 副本'), ext);
    if (isDir) {
      await this.vfs.mkdir(next);
      const { files, dirs } = await this.vfs.walk(path);
      const visible = (/** @type {string} */ p) => !p.slice(path.length + 1).split('/').some(s => s.startsWith('.'));
      for (const d of dirs) if (visible(d.path)) await this.vfs.mkdir(next + d.path.slice(path.length));
      for (const f of files) {
        if (!visible(f.path)) continue;
        const target = next + f.path.slice(path.length);
        await this.vfs.write(target, await this.vfs.read(f.path));
        if (f.name.endsWith(EXT)) await this._reId(target);
      }
      const style = this.meta.folders[path];
      if (style) {
        this.meta.folders[next] = copy(style);
        await this._saveMeta();
      }
    } else {
      await this.vfs.write(next, await this.vfs.read(path));
      await this._reId(next);
    }
    return next;
  }

  // -- archives --

  /** Write the given notebooks and folders (with everything below them) into one zip file.
   * @param {string[]} paths @returns {Promise<{blob: Blob, count: number}>} */
  async exportPaths(paths) {
    let count = 0;
    /** @type {Record<string, any>} */
    const styles = {};
    const used = new Set();
    const z = new ZipWriter();
    for (const path of paths) {
      let top = basename(path);
      let n = 2;
      while (used.has(top)) {   // two selected items may share a name (favourites, trash)
        const [stem, ext] = splitext(basename(path));
        top = `${stem} ${n}${ext}`;
        n++;
      }
      used.add(top);
      if (!(await this._isDir(path))) {
        await this._addNotebook(z, path, top);
        count++;
        continue;
      }
      const { files, dirs } = await this.vfs.walk(path);
      const hidden = (/** @type {string} */ p) => p.slice(path.length + 1).split('/').some(s => s.startsWith('.'));
      const inside = (/** @type {string} */ p) => top + p.slice(path.length);
      z.addDir(top);
      if (this.meta.folders[path]) styles[top] = this.meta.folders[path];
      for (const d of dirs) {
        if (hidden(d.path)) continue;
        z.addDir(inside(d.path));
        if (this.meta.folders[d.path]) styles[inside(d.path)] = this.meta.folders[d.path];
      }
      for (const f of files) {
        if (f.name.endsWith(EXT) && !hidden(f.path)) { await this._addNotebook(z, f.path, inside(f.path)); count++; }
      }
    }
    await z.add(ARCHIVE_META, JSON.stringify({ app: 'Inkpad', folders: styles }), { compress: false });
    return { blob: z.finish(), count };
  }

  /** Notebooks are stored as they are; their parts are compressed already. */
  async _addNotebook(z, path, name) {
    await z.add(name, await this.vfs.read(path), { compress: false });
  }

  /** Write a folder (or the whole library) with everything below it into one zip file.
   * @param {string} folder @returns {Promise<{blob: Blob, count: number}>} */
  async exportArchive(folder) {
    let count = 0;
    /** @type {Record<string, any>} */
    const styles = {};
    const z = new ZipWriter();
    const { files, dirs } = await this.vfs.walk(folder);
    const cut = folder === '' ? 0 : folder.length + 1;
    const hidden = (/** @type {string} */ p) => p.slice(cut).split('/').some(s => s.startsWith('.'));
    for (const d of dirs) {
      if (hidden(d.path)) continue;
      z.addDir(d.path.slice(cut));
      if (this.meta.folders[d.path]) styles[d.path.slice(cut)] = this.meta.folders[d.path];
    }
    for (const f of files) {
      if (f.name.endsWith(EXT) && !hidden(f.path)) { await this._addNotebook(z, f.path, f.path.slice(cut)); count++; }
    }
    await z.add(ARCHIVE_META, JSON.stringify({ app: 'Inkpad', folders: styles }), { compress: false });
    return { blob: z.finish(), count };
  }

  /** Unpack an exported zip into folder. Existing notebooks are never overwritten.
   * @param {Blob} src @param {string} folder @returns {Promise<number>} how many notebooks came in */
  async importArchive(src, folder) {
    let count = 0;
    const z = await ZipReader.open(src);
    /** @type {Record<string, any>} */
    let styles = {};
    try { styles = JSON.parse(await z.text(ARCHIVE_META)).folders || {}; } catch { /* no styles */ }
    for (const e of z.entries) {
      const name = e.name;
      const parts = name.split('/').filter(Boolean);
      if (!parts.length || parts.some(p => p === '.' || p === '..' || p.startsWith('.')) || name.startsWith('/')) continue;
      if (name.endsWith('/')) {
        await this.vfs.mkdir(join(folder, ...parts));
      } else if (name.endsWith(EXT)) {
        const targetDir = join(folder, ...parts.slice(0, -1));
        if (targetDir) await this.vfs.mkdir(targetDir);
        const target = await this.unique(targetDir, parts[parts.length - 1].slice(0, -EXT.length), EXT);
        await this.vfs.write(target, await z.blobOf(name));
        count++;
      }
    }
    const known = this.meta.folders;
    for (const [rel, style] of Object.entries(styles)) {
      const path = join(folder, ...rel.split('/'));
      if ((await this._isDir(path)) && !(path in known) && style && typeof style === 'object') known[path] = style;
    }
    await this._saveMeta();
    return count;
  }

  // -- what was deleted for good --

  /** What was deleted for good and is still kept on this device. @returns {Promise<Entry[]>} */
  async archived() { return this.entries(ARCHIVE); }

  /** Bring a permanently deleted item back to the folder it was in (recreated if need be). @param {string} path */
  async unarchive(path) {
    const base = basename(path);
    this.meta.archived ??= {};
    const origin = this.meta.archived[base] ?? '';
    delete this.meta.archived[base];
    if (origin) await this.vfs.mkdir(origin);
    let [stem, ext] = (await this._isDir(path)) ? [base, ''] : splitext(base);
    // Deleted items carry a date prefix ("20261007-164500 name") so they never collide.
    const m = /^(\d{8}-\d{6}) (.+)$/s.exec(stem);
    if (m) stem = m[2];
    const next = await this.unique(origin, stem, ext);
    await this.vfs.move(path, next);
    await this._saveMeta();
    return next;
  }

  /** The folder a deleted item would be restored to. @param {string} path */
  archivedOrigin(path) { return this.meta.archived?.[basename(path)] ?? ''; }

  /** Notebooks and folders anywhere in the library whose name contains query (lower case).
   * @param {string} query @returns {Promise<Entry[]>} */
  async find(query) {
    const { files, dirs } = await this.vfs.walk('');
    const out = [];
    for (const st of [...dirs, ...files]) {
      if (st.path.split('/').some(p => p.startsWith('.'))) continue;
      if (!st.isDir && !st.name.endsWith(EXT)) continue;
      if (splitext(st.name)[0].toLowerCase().includes(query)) out.push(entryOf(st));
    }
    return out;
  }

  async cacheSize() {
    let total = 0;
    for (const f of (await this.vfs.walk(ARCHIVE)).files) total += f.size;
    return total;
  }

  /** Really delete what was deleted before. Nothing in the cloud is touched. */
  async clearCache() {
    await this.vfs.remove(ARCHIVE);
    this.meta.archived = {};
    await this._saveMeta();
  }

  // -- notebook files --

  /** The id of a notebook file, giving it one if it predates ids. @param {string} path @returns {Promise<string>} */
  notebookId(path) { return notebookIdOf(this.vfs, path); }

  /** A notebook's cover as PNG, or null. @param {string} path @returns {Promise<Blob|null>} */
  cover(path) { return coverOf(this.vfs, path); }
}
