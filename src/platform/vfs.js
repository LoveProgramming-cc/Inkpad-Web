// @ts-check
// The library's files: a small file system over IndexedDB (or memory, for tests).
// PORTING.md 3.4. Logical paths work like B's directory tree: '/'-separated, '' is the root,
// names starting with '.' are the library's own (.trash, .deleted).
//
// Records
//   files  {path, blob, size, mtime (seconds), rev, id?, cover?}
//   dirs   {path, mtime}
//   kv     {name, value}
// `rev` comes from one counter for the whole store and goes up with every write, so
// "rev/size" tells one writing of a file from the next (B's file_sign). Moving a file keeps
// its rev and mtime, as renaming one does on disk.
import { Changed, Exists, NotFound } from '../core/errors.js';
import { now } from '../core/clock.js';
import { basename, dirname, rebase, within } from '../core/path.js';

/**
 * @typedef {object} FileRec
 * @property {string} path @property {Blob} blob @property {number} size @property {number} mtime
 * @property {number} rev @property {string} [id] @property {Blob} [cover]
 * @typedef {{path: string, mtime: number}} DirRec
 * @typedef {{path: string, name: string, isDir: boolean, mtime: number, size: number, rev: number, sign: string|null, id?: string, cover?: Blob}} Stat
 */

const KEY_END = '￿';

/** @param {FileRec} r */
const signOf = r => `${r.rev}/${r.size}`;

/** @param {FileRec|DirRec} r @param {boolean} isDir @returns {Stat} */
function statOf(r, isDir) {
  const f = /** @type {FileRec} */ (r);
  return {
    path: r.path, name: basename(r.path), isDir, mtime: r.mtime, size: isDir ? 0 : f.size, rev: isDir ? 0 : f.rev,
    sign: isDir ? null : signOf(f), id: isDir ? undefined : f.id, cover: isDir ? undefined : f.cover,
  };
}

// -- backends -----------------------------------------------------------------
// A backend runs functions inside one transaction. Inside, `t.files`, `t.dirs`, `t.kv` are
// tables with get/put/delete/range. Inside a transaction only these calls may be awaited.

/** @typedef {{get(key: string): Promise<any>, put(rec: any): Promise<void>, delete(key: string): Promise<void>, range(prefix: string): Promise<any[]>}} Table */
/** @typedef {{files: Table, dirs: Table, kv: Table}} Tx */
/** @typedef {{tx<T>(mode: 'r'|'rw', fn: (t: Tx) => Promise<T>): Promise<T>, close?(): void}} Backend */

export class MemBackend {
  constructor() {
    this.data = { files: new Map(), dirs: new Map(), kv: new Map() };
    /** @type {Promise<any>} */
    this.chain = Promise.resolve();
  }

  /** @param {Map<string, any>} map @param {string} keyField @returns {Table} */
  _table(map, keyField) {
    return {
      get: async key => map.get(key),
      put: async rec => { map.set(rec[keyField], rec); },
      delete: async key => { map.delete(key); },
      range: async prefix => [...map.keys()].filter(k => k.startsWith(prefix)).sort().map(k => map.get(k)),
    };
  }

  async tx(mode, fn) {
    const run = this.chain.then(() => fn({
      files: this._table(this.data.files, 'path'), dirs: this._table(this.data.dirs, 'path'), kv: this._table(this.data.kv, 'name'),
    }));
    this.chain = run.catch(() => {});
    return run;
  }
}

/** Opens the IndexedDB database. @param {string} [name] @returns {Promise<Backend>} */
export function openIdb(name = 'inkpad') {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('files', { keyPath: 'path' });
      db.createObjectStore('dirs', { keyPath: 'path' });
      db.createObjectStore('kv', { keyPath: 'name' });
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('the database is open in an older version of this page'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve({
        close() { db.close(); },
        tx(mode, fn) {
          return new Promise((res, rej) => {
            const t = db.transaction(['files', 'dirs', 'kv'], mode === 'rw' ? 'readwrite' : 'readonly');
            /** @param {string} store @returns {Table} */
            const table = store => {
              const s = t.objectStore(store);
              /** @template T @param {IDBRequest<T>} r @returns {Promise<T>} */
              const wrap = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
              return {
                get: key => wrap(s.get(key)),
                put: async rec => { await wrap(s.put(rec)); },
                delete: async key => { await wrap(s.delete(key)); },
                range: prefix => wrap(s.getAll(IDBKeyRange.bound(prefix, prefix + KEY_END))),
              };
            };
            let result;
            let failed = false;
            t.oncomplete = () => res(result);
            t.onabort = () => rej(t.error || new Error('transaction aborted'));
            t.onerror = () => { /* surfaced through onabort */ };
            fn({ files: table('files'), dirs: table('dirs'), kv: table('kv') }).then(v => { result = v; }, e => {
              failed = true;
              try { t.abort(); } catch { /* already finished */ }
              rej(e);
            });
          });
        },
      });
    };
  });
}

// -- the file system ------------------------------------------------------------

export class Vfs {
  /** @param {Backend} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Set<(paths: string[]) => void>} */
    this.listeners = new Set();
  }

  /** Called with the paths that changed, after this store changed them or (with
   * `watchOtherTabs`) another tab did. Returns an unsubscribe function. @param {(paths: string[]) => void} fn */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @param {string[]} paths */
  _changed(paths) {
    for (const fn of [...this.listeners]) { try { fn(paths); } catch (e) { console.error(e); } }
    this._announce?.(paths);
  }

  /** Tell other tabs of the same origin what changed, and hear what they change. */
  watchOtherTabs(channelName = 'inkpad-library') {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(channelName);
    this._announce = paths => ch.postMessage({ paths });
    ch.onmessage = e => {
      for (const fn of [...this.listeners]) { try { fn(e.data.paths); } catch (err) { console.error(err); } }
    };
  }

  // -- reading --

  /** A file, a folder, or null. @param {string} path @returns {Promise<Stat|null>} */
  async stat(path) {
    return this.backend.tx('r', async t => {
      if (path === '') return statOf({ path: '', mtime: 0 }, true);
      const f = await t.files.get(path);
      if (f) return statOf(f, false);
      const d = await t.dirs.get(path);
      return d ? statOf(d, true) : null;
    });
  }

  /** @param {string} path */
  async exists(path) { return (await this.stat(path)) !== null; }

  /** @param {string} path */
  async isDir(path) { return (await this.stat(path))?.isDir === true; }

  /** What is directly inside a folder, files and folders, hidden ones too. @param {string} dir @returns {Promise<Stat[]>} */
  async list(dir) {
    const prefix = dir === '' ? '' : dir + '/';
    return this.backend.tx('r', async t => {
      const out = [];
      for (const f of await t.files.range(prefix)) if (!f.path.slice(prefix.length).includes('/')) out.push(statOf(f, false));
      for (const d of await t.dirs.range(prefix)) if (!d.path.slice(prefix.length).includes('/')) out.push(statOf(d, true));
      return out;
    });
  }

  /** Everything below a folder, at any depth, sorted by path. @param {string} [root]
   * @returns {Promise<{files: Stat[], dirs: Stat[]}>} */
  async walk(root = '') {
    const prefix = root === '' ? '' : root + '/';
    return this.backend.tx('r', async t => ({
      files: (await t.files.range(prefix)).map(f => statOf(f, false)),
      dirs: (await t.dirs.range(prefix)).map(d => statOf(d, true)),
    }));
  }

  /** The file with the sign it has at this moment. @param {string} path
   * @returns {Promise<{blob: Blob, sign: string, stat: Stat}|null>} */
  async readFile(path) {
    return this.backend.tx('r', async t => {
      const f = await t.files.get(path);
      return f ? { blob: f.blob, sign: signOf(f), stat: statOf(f, false) } : null;
    });
  }

  /** @param {string} path @returns {Promise<Blob>} */
  async read(path) {
    const f = await this.readFile(path);
    if (!f) throw new NotFound(path);
    return f.blob;
  }

  // -- writing --

  /**
   * Put a file in place (made new or replaced as a whole). With `expect`, the sign the file had
   * when it was last read or written, Changed is thrown if something else has written it since
   * - the check and the write are one transaction. Returns the new sign.
   * @param {string} path @param {Blob} blob
   * @param {{expect?: string|null, cover?: Blob, id?: string}} [o]
   */
  async write(path, blob, { expect = null, cover, id } = {}) {
    if (path === '' || path.startsWith('/') || path.endsWith('/')) throw new Error('bad path ' + JSON.stringify(path));
    const sign = await this.backend.tx('rw', async t => {
      const old = await t.files.get(path);
      if (expect !== null && (old ? signOf(old) : null) !== expect) throw new Changed(path);
      if (!old && (await t.dirs.get(path))) throw new Exists(path);
      const rev = await this._nextRev(t);
      const t0 = now();
      /** @type {FileRec} */
      const rec = { path, blob, size: blob.size, mtime: t0, rev };
      if (id) rec.id = id;
      if (cover) rec.cover = cover;
      await t.files.put(rec);
      await this._ensureParents(t, path, t0, !old);
      return signOf(rec);
    });
    this._changed([path]);
    return sign;
  }

  /** Remember something worked out about a file (its id, its cover) without changing it,
   * provided it is still the file with this rev. @param {string} path @param {number} rev
   * @param {{id?: string, cover?: Blob}} fields */
  async annotate(path, rev, fields) {
    await this.backend.tx('rw', async t => {
      const f = await t.files.get(path);
      if (f && f.rev === rev) await t.files.put({ ...f, ...fields });
    });
  }

  async _nextRev(t) {
    const rec = await t.kv.get('__rev');
    const rev = (rec ? rec.value : 0) + 1;
    await t.kv.put({ name: '__rev', value: rev });
    return rev;
  }

  /** Make every folder above `path` exist; the folder directly above gets a new mtime when
   * something was added to it. */
  async _ensureParents(t, path, t0, added) {
    let dir = dirname(path);
    let first = true;
    while (dir !== '') {
      const rec = await t.dirs.get(dir);
      if (!rec) {
        await t.dirs.put({ path: dir, mtime: t0 });
      } else if (first && added) {
        await t.dirs.put({ path: dir, mtime: t0 });
      }
      first = false;
      dir = dirname(dir);
    }
  }

  async _touchDir(t, dir, t0) {
    if (dir === '') return;
    const rec = await t.dirs.get(dir);
    if (rec) await t.dirs.put({ path: dir, mtime: t0 });
  }

  /** Make a folder and the ones above it. @param {string} path */
  async mkdir(path) {
    if (path === '') return;
    await this.backend.tx('rw', async t => {
      if (await t.files.get(path)) throw new Exists(path);
      const t0 = now();
      let dir = path;
      let created = false;
      while (dir !== '') {
        const rec = await t.dirs.get(dir);
        if (!rec) { await t.dirs.put({ path: dir, mtime: t0 }); created = true; if (dirname(dir) !== '') await this._touchDir(t, dirname(dir), t0); }
        dir = dirname(dir);
      }
      return created;
    });
    this._changed([path]);
  }

  /** Remove an empty folder. @param {string} path */
  async rmdir(path) {
    await this.backend.tx('rw', async t => {
      const prefix = path + '/';
      if ((await t.files.range(prefix)).length || (await t.dirs.range(prefix)).length) throw new Error('folder not empty: ' + path);
      await t.dirs.delete(path);
      await this._touchDir(t, dirname(path), now());
    });
    this._changed([path]);
  }

  /** Remove a file, or a folder with everything in it. Removing what is not there is not an error. @param {string} path */
  async remove(path) {
    const gone = await this.backend.tx('rw', async t => {
      const prefix = path + '/';
      let n = 0;
      if (await t.files.get(path)) { await t.files.delete(path); n++; }
      if (await t.dirs.get(path)) {
        for (const f of await t.files.range(prefix)) { await t.files.delete(f.path); n++; }
        for (const d of await t.dirs.range(prefix)) { await t.dirs.delete(d.path); n++; }
        await t.dirs.delete(path);
        n++;
      }
      if (n) await this._touchDir(t, dirname(path), now());
      return n;
    });
    if (gone) this._changed([path]);
  }

  /**
   * Move a file or a whole folder (one transaction). Its contents, mtime and rev stay as they
   * were. Fails if the target exists, unless `overwrite` is set (files only, like os.replace).
   * @param {string} from @param {string} to @param {{overwrite?: boolean}} [o]
   */
  async move(from, to, { overwrite = false } = {}) {
    if (from === to) return;
    if (within(to, from) && from !== '') throw new Error('cannot move a folder into itself');
    await this.backend.tx('rw', async t => {
      const t0 = now();
      const file = await t.files.get(from);
      const dir = file ? null : await t.dirs.get(from);
      if (!file && !dir) throw new NotFound(from);
      const clash = (await t.files.get(to)) || (await t.dirs.get(to));
      if (clash && !(overwrite && file && (await t.files.get(to)))) throw new Exists(to);
      if (file) {
        await t.files.delete(from);
        await t.files.put({ ...file, path: to });
      } else {
        const prefix = from + '/';
        const files = await t.files.range(prefix), dirs = await t.dirs.range(prefix);
        await t.dirs.delete(from);
        await t.dirs.put({ path: to, mtime: dir.mtime });
        for (const f of files) { await t.files.delete(f.path); await t.files.put({ ...f, path: rebase(f.path, from, to) }); }
        for (const d of dirs) { await t.dirs.delete(d.path); await t.dirs.put({ ...d, path: rebase(d.path, from, to) }); }
      }
      await this._ensureParents(t, to, t0, true);
      await this._touchDir(t, dirname(from), t0);
    });
    this._changed([from, to]);
  }

  // -- small values (settings, sync state, credentials) --

  /** @param {string} name @param {any} [fallback] */
  async kvGet(name, fallback = undefined) {
    return this.backend.tx('r', async t => {
      const rec = await t.kv.get(name);
      return rec ? rec.value : fallback;
    });
  }

  /** @param {string} name @param {any} value */
  async kvSet(name, value) {
    await this.backend.tx('rw', async t => { await t.kv.put({ name, value }); });
  }

  /** @param {string} name */
  async kvDelete(name) {
    await this.backend.tx('rw', async t => { await t.kv.delete(name); });
  }
}

/** A store in memory, for tests. */
export function memoryVfs() { return new Vfs(new MemBackend()); }
