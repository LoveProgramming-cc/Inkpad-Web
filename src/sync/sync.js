// @ts-check
// Google Drive sync for the notebook library, the same protocol as the desktop app.
// Translated from A:Sync/Sync.swift (the async/await control flow) with B:gdrive.py `_sync`.
//
// Sync is an index-driven delta merge. Every notebook has a permanent id, and one small index
// file on Drive lists each id with its path, content hash, Drive file and state. A sync
// downloads that index, compares it per id with the library and with what both sides looked
// like last time, moves only the notebooks that differ, then writes the index back. Deleted
// notebooks stay in the index as tombstones, which is how a deletion reaches other devices
// instead of being undone by them; renames and moves are just a changed path on the same id.
// Nothing is destroyed: deletions go to the local trash, and a notebook edited on both sides is
// merged item by item.
//
// Two devices may well sync at the same moment, and one of them may be cut off half way and go
// on much later with what it read before. So the index is never taken at its word about a
// notebook's content: what counts is the checksum Drive itself reports for the file, asked for
// again just before the file is replaced. A device that finds another has been there first
// merges instead of overwriting, and the index is read again before it is written, so that
// what others put in it meanwhile is kept.
//
// The library lives in a `Vfs` (platform/vfs.js); this device's record of the last sync is
// kv['sync'] (B's .sync.json), the library metadata kv['library'] (.library.json). The drive is
// anything with the methods of `DriveAPI` below. Nothing here touches a window or a network
// by itself.
import { Document, merge } from '../core/document.js';
import { md5Blob } from '../core/hash.js';
import { now } from '../core/clock.js';
import { tr, trf } from '../core/i18n.js';
import { basename, dirname, join, splitext } from '../core/path.js';
import { withFileLock } from '../core/storage.js';
import { notebookIdOf, setIdOf } from '../core/notebook.js';
import { newId } from '../core/items.js';
import { BLOBS, FORMAT, config, fatten, fetcher, slim, stripped } from './blobs.js';
import { DriveError } from './errors.js';
import { hexId } from '../core/uuid.js';

export { DriveError } from './errors.js';
export { config } from './blobs.js';

/**
 * What the sync needs of a drive (A:`DriveAPI`; sync/drive.js implements it for Google).
 * @typedef {object} DriveAPI
 * @property {((got: number, total: number) => void) | null} onBytes called with (bytes so far, total) during an upload or a download
 * @property {() => Promise<string>} root
 * @property {(name: string, parent: string) => Promise<string|null>} find
 * @property {(id: string) => Promise<any>} getJSON
 * @property {(name: string, value: any, parent: string, id: string|null) => Promise<string>} putJSON create or replace a small JSON file; returns its id
 * @property {(id: string, name: string) => Promise<void>} rename
 * @property {(blob: Blob, name: string, parent: string, id: string|null) => Promise<[string, string|null]>} upload create or replace a file; returns [id, md5]
 * @property {(id: string) => Promise<Blob>} download
 * @property {(parent: string) => Promise<{id: string, name: string, md5: string|null, modified: number}[]>} children
 * @property {(id: string) => Promise<string|null>} md5 the checksum of a file's content as it is on Drive at this moment
 * @property {(id: string) => Promise<boolean>} alive whether a file or folder is still there, and not in the bin
 */

export const ROOT_NAME = 'Inkpad';
export const INDEX_NAME = '_inkpad_index.json';
const EXT = '.inkpad';
const TRASH = '.trash';

/** @returns {{up: number, down: number, conflicts: number, merged: number, removed: number, moved: number, mended: number, meta: boolean}} */
export function emptySummary() {
  return { up: 0, down: 0, conflicts: 0, merged: 0, removed: 0, moved: 0, mended: 0, meta: false };
}

// -- small helpers ------------------------------------------------------------

/** @template T @param {T} v @returns {T} */
const clone = v => structuredClone(v);

/** @param {any} a @param {any} b */
export function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  if (typeof a !== typeof b || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => k in b && same(a[k], b[k]));
}

/** @param {any} x @param {number} [d] */
const num = (x, d = 0) => (typeof x === 'number' ? x : d);

/** Python's `==` between two values that may be missing. */
const eq = (a, b) => (a ?? null) === (b ?? null);

const hidden = (/** @type {string} */ p) => p.split('/').some(s => s.startsWith('.'));
const freshId = () => hexId();

/** @param {import('../platform/vfs.js').Vfs} vfs @param {string} path a path in the library that is free: "name", then "name 2"... */
async function uniquePath(vfs, path) {
  const dir = dirname(path);
  const [stem, ext] = splitext(basename(path));
  let n = 2;
  while (await vfs.exists(path)) {
    path = join(dir, `${stem} ${n}${ext}`);
    n++;
  }
  return path;
}

/** (notebooks, folders) in the library: path -> stat, and a set of paths. @param {import('../platform/vfs.js').Vfs} vfs */
export async function scan(vfs) {
  const { files, dirs } = await vfs.walk('');
  /** @type {Map<string, import('../platform/vfs.js').Stat>} */
  const notebooks = new Map();
  const folders = new Set();
  for (const d of dirs) if (!hidden(d.path)) folders.add(d.path);
  for (const f of files) if (!hidden(f.path) && f.name.endsWith(EXT)) notebooks.set(f.path, f);
  return { notebooks, folders };
}

/** This device's record of the last sync. @param {import('../platform/vfs.js').Vfs} vfs @returns {Promise<Record<string, any>>} */
async function loadState(vfs) {
  const state = await vfs.kvGet('sync');
  return state && typeof state === 'object' ? clone(state) : {};
}

/** @param {import('../platform/vfs.js').Vfs} vfs @param {Record<string, any>} state */
async function saveState(vfs, state) {
  await vfs.kvSet('sync', clone(state));
}

/** @param {import('../platform/vfs.js').Vfs} vfs @returns {Promise<number|null>} when the library last synced, in seconds */
export async function lastSync(vfs) {
  const last = (await loadState(vfs)).last;
  return typeof last === 'number' ? last : null;
}

/** The id of the Drive folder this library last synced with, or "". @param {import('../platform/vfs.js').Vfs} vfs */
export async function cloudFolderOf(vfs) {
  return (await loadState(vfs)).root || '';
}

/** A folder id out of what was typed: the id itself, or the address of the folder. @param {string} typed */
export function parseFolder(typed) {
  let text = typed.trim();
  for (const mark of ['/folders/', 'id=']) {
    const at = text.indexOf(mark);
    if (at >= 0) text = text.slice(at + mark.length);
  }
  for (const stop of ['?', '/', '&', '#']) {
    const at = text.indexOf(stop);
    if (at >= 0) text = text.slice(0, at);
  }
  if (text && /[^\p{L}\p{N}\-_]/u.test(text)) throw new DriveError(tr('这不像是 Google Drive 的文件夹 ID'));
  return text;
}

/**
 * The id of the Drive folder to sync with, checked to be there. `wanted` is the folder the user
 * asked for, or "" for one named Inkpad at the top of their Drive. When it is not the folder
 * this device synced with before, what was remembered about that one is dropped, so that the
 * library is compared with the new folder from nothing. `state` is changed in place.
 * @param {Record<string, any>} state @param {DriveAPI} drive @param {string} wanted
 */
export async function cloudFolder(state, drive, wanted, check = true) {
  if ((state.folder_set ?? '') !== wanted) {
    for (const k of Object.keys(state)) delete state[k];
    state.folder_set = wanted;
  } else if (!check && typeof state.root === 'string' && state.root) {
    return state.root;   // taken on trust; a thorough sync looks
  }
  if (wanted) {
    let there = false;
    try {
      there = await drive.alive(wanted);
    } catch (e) {
      if (!(e instanceof DriveError && (e.code === 403 || e.code === 404))) throw e;
    }
    if (!there) {
      // With the drive.file permission Google shows the app only what the app itself made.
      throw new DriveError(trf('无法使用文件夹 %s：它不存在、在回收站里，或者不是 Inkpad 创建的。Inkpad 只被允许访问它自己创建的文件夹；可以先留空同步一次，把生成的“Inkpad”文件夹在 Google Drive 里移到想放的位置，再把它的 ID 填到其它设备上。', wanted));
    }
    state.root = wanted;
  } else {
    let kept = false;
    if (typeof state.root === 'string' && state.root) kept = await drive.alive(state.root);
    if (!kept) state.root = await drive.root();
  }
  return state.root || '';
}

// -- the index, and notebooks the cloud still holds after they were deleted --------------

/** @returns {Promise<{cloud: any, rootId: string, indexId: string|null}>} */
async function readIndex(vfs, drive, state, folder) {
  const rootId = await cloudFolder(state, drive, folder);
  let indexId = typeof state.index === 'string' ? state.index : null;
  if (indexId === null) indexId = await drive.find(INDEX_NAME, rootId);
  let cloud = {};
  if (indexId) cloud = await drive.getJSON(indexId);
  return { cloud, rootId, indexId };
}

/** Notebooks the index marks as deleted while their file is still on Drive. Nothing is
 * downloaded: this only reads the index. Newest first.
 * @param {import('../platform/vfs.js').Vfs} vfs @param {DriveAPI} drive
 * @returns {Promise<{id: string, path: string, ts: number}[]>} */
export async function cloudDeleted(vfs, drive, folder = '') {
  const state = await loadState(vfs);
  const { cloud } = await readIndex(vfs, drive, state, folder);
  const out = [];
  for (const [nid, entry] of Object.entries(cloud.items ?? {})) {
    if (entry.deleted === true && typeof entry.file === 'string') out.push({ id: nid, path: entry.path ?? nid, ts: num(entry.ts) });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Download the chosen deleted notebooks back to the paths they had; returns how many.
 * @param {import('../platform/vfs.js').Vfs} vfs @param {DriveAPI} drive @param {string[]} ids
 * @param {(fraction: number, text: string) => void} [progress] */
export async function cloudRestore(vfs, drive, ids, folder = '', progress) {
  const state = await loadState(vfs);
  const { cloud, rootId, indexId } = await readIndex(vfs, drive, state, folder);
  const items = cloud.items ?? {};
  const known = state.items ?? {};
  let done = 0;
  /** @type {Record<string, string>|null} */
  let names = null;
  for (const [n, nid] of ids.entries()) {
    const entry = items[nid];
    if (!entry || typeof entry.file !== 'string') continue;
    const rel = entry.path ?? nid + EXT;
    const name = basename(rel);
    progress?.(n / ids.length, name);
    drive.onBytes = (got, total) => { if (total > 0) progress?.((n + got / total) / ids.length, name); };
    const target = await uniquePath(vfs, rel);
    if (names === null) {
      names = {};
      for (const f of await drive.children(rootId)) if (!(f.name in names)) names[f.name] = f.id;
    }
    const all = names;
    const coming = await fatten(await drive.download(entry.file), null, null, fetcher(drive, rootId, () => all));
    await withFileLock(() => vfs.write(target, coming));   // whole before it is given its name in the library
    // It is a live notebook again, on both sides, with what the cloud holds.
    entry.deleted = false;
    entry.trashed = false;
    entry.path = target;
    entry.ts = now();
    known[nid] = { path: target, trashed: false, md5: entry.md5 ?? '', local: await md5Blob(await vfs.read(target)) };
    done++;
  }
  drive.onBytes = null;
  if (done > 0) {
    cloud.items = items;
    state.root = rootId;
    state.index = await drive.putJSON(INDEX_NAME, cloud, rootId, indexId);
    state.items = known;
    await saveState(vfs, state);
  }
  progress?.(1, '');
  return done;
}

// -- the sync ------------------------------------------------------------------

/**
 * @typedef {object} SyncOptions
 * @property {string[]} [skip] notebooks to leave alone (one being edited)
 * @property {string[]|null} [only] if given, nothing but these notebooks is looked at
 * @property {string} [folder] the Drive folder asked for, or "" for the default
 * @property {boolean|null} [thorough] null: decide from the record of the last sync
 * @property {(fraction: number, text: string) => void} [progress]
 * @property {AbortSignal} [signal]
 */

/**
 * Merge the library with the Drive index.
 *
 * `progress(fraction, text)` reports how far along the sync is: one step for reading the index,
 * one per notebook (advancing with the bytes of its transfer) and one for the end.
 *
 * A sync is quick or thorough. A quick one takes the index at its word about what is on Drive,
 * and this device's own record about which notebooks were written since the last sync: it reads
 * the index, moves what differs and writes the index back. It is what runs on leaving a notebook
 * and while one is open. A thorough one also lists the folder on Drive and puts right what does
 * not fit: files deleted there, a folder that is gone, an index that is behind the files. That is
 * done when asked for (`thorough: true`: the user's "sync now", and once when the app starts), when
 * it has not been done for some hours, and when a quick sync comes upon something on Drive that
 * is not there.
 *
 * With `only`, nothing but those notebooks is looked at, which takes a few requests and is what
 * an open notebook is kept up to date with while it is being written in.
 * @param {import('../platform/vfs.js').Vfs} vfs @param {DriveAPI} drive @param {SyncOptions} [opts]
 */
export async function sync(vfs, drive, opts = {}) {
  let all = opts.thorough ?? null;
  if (all === null) {
    const state = await loadState(vfs);
    all = typeof state.index !== 'string' || now() - num(state.checked) > config.thoroughEvery;
  }
  try {
    return await run(vfs, drive, opts, all);
  } catch (e) {
    if (e instanceof DriveError && all === false && e.code === 404) {
      // Something was not where the index said.
      return run(vfs, drive, opts, true);
    }
    throw e;
  }
}

/**
 * @typedef {{path: string, rel: string, inTrash: boolean}} Local  path in the store; rel is the path in the
 *   library (for a notebook in the trash: its file name)
 */

/** @param {import('../platform/vfs.js').Vfs} vfs @param {DriveAPI} drive @param {SyncOptions} opts @param {boolean} thorough */
async function run(vfs, drive, opts, thorough) {
  const { skip = [], only = null, folder = '', progress, signal } = opts;
  const report = progress ?? (() => {});
  report(0, tr('正在读取云端目录…'));
  const state = await loadState(vfs);
  const rootId = await cloudFolder(state, drive, folder, thorough);
  // id -> {'path', 'trashed', 'md5', ...} when both sides last agreed
  const known = clone(state.items ?? {});
  await vfs.mkdir(TRASH);
  const summary = emptySummary();

  // A thorough sync has the folder's listing to go by; a quick one has only the index.
  const inFolder = thorough ? await drive.children(rootId) : null;
  const live = inFolder ? new Set(inFolder.map(f => f.id)) : null;
  /** @type {string|null} */
  let indexId = typeof state.index === 'string' ? state.index : null;
  if (inFolder && live) {
    if (indexId === null || !live.has(indexId)) indexId = inFolder.find(f => f.name === INDEX_NAME)?.id ?? null;
  } else if (indexId === null) {
    indexId = await drive.find(INDEX_NAME, rootId);
  }
  let cloud = {};
  if (indexId) cloud = await drive.getJSON(indexId);
  if (num(cloud.format, 1) > FORMAT) throw new DriveError(tr('云端的笔记是由更新版本的 Inkpad 同步的，请先更新这台设备上的 Inkpad'));
  // The PDFs and pictures kept on Drive as files of their own are listed in the index too.
  /** @type {Record<string, string>} */
  let names = { ...(cloud.blobs ?? {}) };   // name -> Drive file
  const fetch = fetcher(drive, rootId, () => names);
  /** @type {Record<string, any>} */
  const blobsSeen = {};   // id -> the blobs found in the notebook when it was sent: see slim()
  /** @type {Map<string, [string, string]>} */
  const agreed = new Map();   // id -> [checksum, sign] of the local file that matches the cloud's version
  // id -> {'path', 'trashed', 'md5', 'file', 'deleted', 'ts'}
  /** @type {Record<string, any>} */
  const items = {};
  for (const [nid, value] of Object.entries(cloud.items ?? {})) items[nid] = clone(value ?? {});
  for (const part of ['items', 'blobs']) if (cloud[part] == null) cloud[part] = {};
  const read0 = clone(cloud);   // the index as it was read, to tell later what others changed
  if (inFolder && live) {
    for (const nid of Object.keys(items)) {
      const entry = items[nid];
      if (!entry.file || !live.has(entry.file)) {
        if (entry.deleted === true) {
          entry.file = null;   // still a deletion to pass on, with nothing left to restore
        } else {
          // Listed, but its file is gone from Drive. Forgotten here, it is sent again by
          // whichever device still has it.
          delete items[nid];
        }
      }
    }
    /** @type {Map<string, string>} */
    const actual = new Map();
    for (const f of inFolder) if (f.md5 && !actual.has(f.id)) actual.set(f.id, f.md5);
    for (const entry of Object.values(items)) {
      // The file itself says what is in it. The index may be behind: a device that was cut
      // off after an upload never got to write it down.
      if (entry.deleted !== true && entry.file && actual.has(entry.file)) entry.md5 = actual.get(entry.file);
    }
    // The same for the list of blobs: those that are gone are forgotten, and those that are
    // there unlisted (uploaded before the index kept this list) are taken up.
    names = Object.fromEntries(Object.entries(names).filter(([, id]) => live.has(id)));
    for (const f of inFolder) if (f.name.startsWith('blob-') && names[f.name] == null) names[f.name] = f.id;
    state.checked = now();
  }
  /** The index as this sync has it now. */
  const index = () => clone({ ...cloud, items, blobs: names });
  let read = clone(read0);
  let mended = !same(index(), read0);   // whether looking at Drive showed the index to be wrong
  let mineWas = index();                // and as this sync started out with it
  const sent = new Set();               // ids of the notebooks this sync uploaded
  let savedAt = now();
  let moved = 0;

  /** Write the index. It is read again first: whatever another device changed in it while this
   * sync was running is kept, wherever this sync did not change the same thing. */
  const publish = async () => {
    if (indexId !== null && !mended && same(index(), mineWas)) {
      state.index = indexId;   // found, if not written: remembered all the same
      return;                  // nothing to write down
    }
    if (indexId === null) indexId = await drive.find(INDEX_NAME, rootId);
    let latest = {};
    if (indexId) latest = await drive.getJSON(indexId);
    const out = index();
    for (const part of ['items', 'folders', 'blobs']) {
      const ours = out[part] ?? {};
      const was = read[part] ?? {}, began = mineWas[part] ?? {};
      for (const [key, value] of Object.entries(latest[part] ?? {})) {
        if (!same(value, was[key]) && same(ours[key], began[key])) {
          ours[key] = value;
          if (part === 'items') items[key] = clone(value ?? {});
          if (part === 'blobs' && typeof value === 'string') names[key] = value;
        }
      }
      out[part] = ours;
    }
    if (num(latest.meta?.ts) > num(out.meta?.ts)) out.meta = latest.meta;
    indexId = await drive.putJSON(INDEX_NAME, out, rootId, indexId);
    state.index = indexId;
    cloud = clone(out);
    read = clone(out);
    mineWas = clone(out);
    mended = false;
  };

  // What is on this device: id -> {path, rel, inTrash}.
  const skipPaths = new Set(skip);
  const skipIds = new Set();
  /** @type {Map<string, Local>} */
  const local = new Map();
  const { notebooks } = await scan(vfs);
  /** @type {Local[]} */
  const found = [...notebooks.keys()].sort().map(p => ({ path: p, rel: p, inTrash: false }));
  const trashNames = (await vfs.list(TRASH)).filter(e => !e.isDir && e.name.endsWith(EXT)).map(e => e.name).sort();
  for (const n of trashNames) found.push({ path: join(TRASH, n), rel: n, inTrash: true });
  const onlyPaths = only ? new Set(only) : null;
  // A notebook that has not been written since the last sync is known by its place: it is not
  // opened to be asked who it is. This device's record of the last sync is the list of what has
  // been edited: whatever is not in it as it is now.
  /** @type {Map<string, [string, string|null]>} */
  const sameAs = new Map();
  for (const [nid, e] of Object.entries(known)) sameAs.set(`${e.trashed === true}/${e.path ?? ''}`, [nid, typeof e.stat === 'string' ? e.stat : null]);
  const unwritten = new Set();
  const signOf = async (/** @type {string} */ path) => (await vfs.stat(path))?.sign ?? '';
  for (const entry of found) {
    let here = entry;
    if (onlyPaths && !onlyPaths.has(here.path)) continue;
    let nid;
    const hit = sameAs.get(`${here.inTrash}/${here.rel}`);
    if (hit && hit[1] && hit[1] === await signOf(here.path) && !local.has(hit[0])) {
      nid = hit[0];
      unwritten.add(nid);
    } else {
      try {
        nid = await notebookIdOf(vfs, here.path);
      } catch {
        continue;   // not a readable notebook; leave it alone
      }
    }
    if (skipPaths.has(here.path)) {
      skipIds.add(nid);
      continue;
    }
    const other = local.get(nid);
    if (other) {
      // A copy made outside the app shares its original's id; make it a notebook of its own.
      // The original is the one still where the last sync left it, whichever was met first.
      const was = known[nid]?.path;
      if (here.rel === was && other.rel !== was) {
        local.set(nid, here);
        here = other;
      }
      nid = freshId();
      await setIdOf(vfs, here.path, nid);
    }
    if (local.has(nid)) unwritten.delete(nid);   // two files with one id: both are looked at
    local.set(nid, here);
  }

  /** Move a local notebook to where the index says it belongs. */
  const place = async (/** @type {string} */ nid, /** @type {string} */ rel, /** @type {boolean} */ inTrash) => {
    const path = /** @type {Local} */ (local.get(nid)).path;
    let target = inTrash ? join(TRASH, basename(rel)) : rel;
    if (target !== path) {
      target = await uniquePath(vfs, target);
      await vfs.move(path, target);
    }
    local.set(nid, { path: target, rel: inTrash ? basename(target) : target, inTrash });
  };

  /** [what stands for the content, sign] of a notebook here. No notebook is read through for
   * this: one that has not been written since the last sync is what it was then, and one that
   * has been written is another. (Only a record from before the time of writing was kept gives
   * nothing to go by; then the checksum is worked out, once.) */
  const localMd5 = async (/** @type {string} */ nid, /** @type {string} */ path) => {
    const was = known[nid], stat = await signOf(path);
    if (typeof was?.local === 'string' && was.local && was.stat === stat) return /** @type {[string, string]} */ ([was.local, stat]);
    if (typeof was?.stat === 'string' && was.stat) return /** @type {[string, string]} */ (['written ' + stat, stat]);
    return /** @type {[string, string]} */ ([await md5Blob(await vfs.read(path)), stat]);
  };

  /** Upload a local notebook's content and record it in the index entry. */
  const push = async (/** @type {string} */ nid, /** @type {any} */ entry) => {
    const here = /** @type {Local} */ (local.get(nid));
    const file = await vfs.readFile(here.path);
    if (!file) throw new DriveError(trf('“%s”在同步时一直被其它设备更改，请稍后再同步', basename(here.path)));
    const { stat, slim: slimmed, parts, found: seenNow } = await slim(file.blob, file.sign, { seen: known[nid]?.blobs, have: n => names[n] != null });
    blobsSeen[nid] = seenNow;
    for (const [name, part] of [...parts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      // Each of these is uploaded once, whatever is written in the notebook afterwards.
      const [blobId, arrived] = await drive.upload(part, name, rootId, null);
      if (arrived && arrived !== await md5Blob(part)) {
        throw new DriveError(tr('上传的 PDF 或图片在云端的校验值不对，请再同步一次'));   // and it is not listed
      }
      names[name] = blobId;
    }
    const [fileId, sum] = await drive.upload(slimmed, basename(here.rel), rootId, entry.file ?? null);
    // What arrived is what was sent: only then is it written down in the index.
    const sentSum = await md5Blob(slimmed);
    if (sum && sum !== sentSum) throw new DriveError(tr('上传的笔记本在云端的校验值不对，请再同步一次'));
    const theirs = sum ?? sentSum;
    agreed.set(nid, ['written ' + stat, stat]);
    cloud.format = FORMAT;
    entry.file = fileId;
    entry.md5 = theirs;
    entry.path = here.rel;
    entry.trashed = here.inTrash;
    entry.deleted = false;
    entry.ts = now();
    summary.up++;
    sent.add(nid);
  };

  /** Make a notebook and the cloud's version of it the same, losing nothing of either. */
  const settle = async (/** @type {string} */ nid, /** @type {any} */ entry, /** @type {any} */ before) => {
    const path = /** @type {Local} */ (local.get(nid)).path;
    // What both sides last agreed on: the cloud's file, and the one here that matched it.
    // (They are not the same file: the cloud's is without the notebook's PDFs and pictures.)
    let base = before?.md5 ?? null;
    let baseLocal = (typeof before?.local === 'string' && before.local) ? before.local : base;
    let mineSent = before?.sent === true;   // ...which this device had written
    for (let round = 0; round < 5; round++) {
      const [mine, stat] = await localMd5(nid, path);
      const localSame = baseLocal != null && mine === baseLocal;
      const cloudSame = base != null && eq(entry.md5, base);
      if (eq(mine, entry.md5) || (localSame && cloudSame)) {
        const listed = Object.values(before?.blobs ?? {}).map(v => (Array.isArray(v) ? v[v.length - 1] : null)).filter(v => typeof v === 'string');
        if (thorough && listed.some(n => names[n] == null)) {
          await push(nid, entry);   // a PDF or picture of it is gone from Drive: it is sent again
          return;
        }
        if (!agreed.has(nid)) agreed.set(nid, [mine, stat]);
        return;
      }
      if (!entry.file) {
        await push(nid, entry);
        return;
      }
      if (cloudSame) {
        // Only this device has changed it, as far as the index says. A thorough sync asks Drive
        // once more, in case another device sent its version this very moment; a quick one takes
        // the index at its word. (Should two devices cross all the same, nothing is lost: the one
        // written over sees at its next sync that the cloud's version is not its own, and merges
        // its edits back in.)
        const current = thorough ? await drive.md5(entry.file) : null;
        if (current == null || current === base) {
          await push(nid, entry);
          return;
        }
        entry.md5 = current;
        continue;
      }
      // Aside, so that nothing half done is left by the notebook.
      const downloaded = await drive.download(entry.file);
      entry.md5 = await md5Blob(downloaded);
      const theirs = await fatten(downloaded, (await vfs.readFile(path))?.blob ?? null, known[nid]?.blobs, fetch);
      const taken = await withFileLock(async () => {
        const untouched = localSame && (await signOf(path)) === stat;
        let replace = untouched && !mineSent;   // nothing here that the cloud's version lacks
        if (!replace) {
          try {
            const hereFile = /** @type {NonNullable<Awaited<ReturnType<typeof vfs.readFile>>>} */ (await vfs.readFile(path));
            const hereDoc = await Document.load(hereFile.blob, { path, sign: hereFile.sign, vfs });
            const theirDoc = await Document.load(theirs, { vfs });
            if (untouched) {
              // The cloud's version ought to be a later one of what this device sent. If another
              // device wrote over that without having seen it, it is not; then what was written
              // here is put back into it.
              if (merge(theirDoc, hereDoc).every(n => n === 0)) replace = true;
              else await theirDoc._save(path);
            } else {
              // Edited on both sides: merge the two, item by item.
              merge(hereDoc, theirDoc);
              await hereDoc._save(path);
            }
            if (!replace) summary.merged++;
          } catch {
            // Only if merging is not possible is the remote version kept as a notebook of its own.
            const stem = splitext(basename(path))[0] + tr('（云端副本）') + EXT;
            const copy = await uniquePath(vfs, join(dirname(path), stem));
            await vfs.write(copy, theirs);
            try { await setIdOf(vfs, copy, freshId()); } catch { /* keeps its id */ }
            summary.conflicts++;
          }
        }
        if (replace) {
          await vfs.write(path, theirs);
          const sign = await signOf(path);
          agreed.set(nid, ['written ' + sign, sign]);
          summary.down++;
        }
        return replace;
      });
      if (taken) return;
      // What is here now has all of that version in it, and more.
      base = entry.md5;
      baseLocal = null;
      mineSent = false;
    }
    throw new DriveError(trf('“%s”在同步时一直被其它设备更改，请稍后再同步', basename(path)));
  };

  const ids = only === null
    ? [...new Set([...local.keys(), ...Object.keys(items), ...Object.keys(known)])].sort()
    : [...local.keys()].sort();
  const steps = ids.length + 2;
  /** @type {[string, string][]} */
  const unmended = [];   // notebooks here that lack their PDFs and could not be given them back
  for (const [n, nid] of ids.entries()) {
    signal?.throwIfAborted();
    const here = local.get(nid) ?? null, before = known[nid] ?? null;
    let entry = items[nid] ?? null;
    const name = basename(here?.rel ?? entry?.path ?? '');
    report((n + 1) / steps, name);
    // A transfer moves the bar smoothly through this notebook's step.
    drive.onBytes = (got, total) => { if (total > 0) report((n + 1 + got / total) / steps, name); };
    if (skipIds.has(nid)) continue;
    if (here && !unwritten.has(nid) && await stripped(await vfs.read(here.path))) {
      // A notebook here without its PDFs and pictures (see stripped). They are fetched and it is
      // made whole before anything else is done with it; while that is not possible it is left
      // exactly as it is, and above all not uploaded.
      try {
        const whole = await fatten(await vfs.read(here.path), null, null, fetch);
        await withFileLock(() => vfs.write(here.path, whole));
        summary.mended++;
      } catch (e) {
        if (e instanceof DriveError) {
          unmended.push([name, e.message]);
          continue;
        }
        throw e;
      }
    }
    const beforeMd5 = before?.md5 ?? null;
    if (!here && !entry) {
      delete known[nid];
      continue;
    }
    if (!entry && here) {
      // New on this device. Something already in the trash is not worth sending.
      if (here.inTrash) continue;
      entry = {};
      items[nid] = entry;
      await push(nid, entry);
    } else if (!here && entry) {
      if (entry.deleted === true) {
        delete known[nid];
        continue;
      }
      if (before && eq(entry.md5, beforeMd5)) {
        // Gone from this device and untouched elsewhere: leave a tombstone. The file itself
        // stays on Drive, so a deletion can always be recovered from there.
        entry.deleted = true;
        entry.ts = now();
        delete known[nid];
        summary.removed++;
        continue;
      }
      if (entry.trashed === true && !before) continue;   // sitting in another device's trash; no need to fetch it
      if (typeof entry.path !== 'string' || typeof entry.file !== 'string') continue;
      let target = entry.trashed === true ? join(TRASH, basename(entry.path)) : entry.path;
      target = await uniquePath(vfs, target);
      // Put together aside, and moved into the library only when it is whole: a download that is
      // cut off leaves nothing there.
      const coming = await fatten(await drive.download(entry.file), null, null, fetch);
      await vfs.write(target, coming);
      const sign = await signOf(target);
      agreed.set(nid, ['written ' + sign, sign]);
      local.set(nid, { path: target, rel: entry.trashed === true ? basename(target) : target, inTrash: entry.trashed === true });
      summary.down++;
    } else if (here && entry) {
      const [mine] = await localMd5(nid, here.path);
      const wasLocal = (typeof before?.local === 'string' && before.local) ? before.local : beforeMd5;
      const unchanged = before != null && eq(mine, wasLocal);
      let content = true;
      if (entry.deleted === true) {
        if (here.inTrash || unchanged) {
          // Deleted elsewhere and not edited here since: follow, into the trash.
          await place(nid, here.rel, true);
          delete known[nid];
          if (!here.inTrash) summary.removed++;
          continue;
        }
        await push(nid, entry);   // edited after the deletion: the edit wins
        content = false;
      }
      if (content) await settle(nid, entry, before);
      // Name, folder and trash state travel separately from the content.
      const therePath = entry.path ?? null, thereTrash = entry.trashed === true;
      if (here.rel !== therePath || here.inTrash !== thereTrash) {
        if (before && here.rel === before.path && here.inTrash === (before.trashed === true) && typeof therePath === 'string') {
          await place(nid, therePath, thereTrash);
        } else {
          const mineName = basename(here.rel);
          if (entry.file && mineName !== basename(therePath ?? '')) await drive.rename(entry.file, mineName);
          entry.path = here.rel;
          entry.trashed = here.inTrash;
          entry.ts = now();
        }
        summary.moved++;
      }
    }
    const at = local.get(nid);
    entry = items[nid];
    if (!at || !entry) continue;
    entry.path = at.rel;
    entry.trashed = at.inTrash;
    const was = known[nid];
    known[nid] = { path: at.rel, trashed: at.inTrash, md5: entry.md5 ?? '' };
    const a = agreed.get(nid);
    if (a) {
      known[nid].local = a[0];
      known[nid].stat = a[1];
    } else if (typeof was?.local === 'string' && eq(was.md5, entry.md5)) {
      known[nid].local = was.local;
    }
    if (blobsSeen[nid]) known[nid].blobs = blobsSeen[nid];
    else if (was?.blobs) known[nid].blobs = was.blobs;
    if (sent.has(nid) || (was?.sent === true && eq(was.md5, entry.md5))) {
      known[nid].sent = true;   // the cloud's version is the one this device wrote
    }
    if (summary.up + summary.down !== moved) {
      moved = summary.up + summary.down;
      // Write down, in the cloud and here, what has been done so far, so that a sync that is cut
      // off goes on from there the next time.
      if (now() - savedAt >= config.checkpoint) {
        await publish();
        state.items = clone(known);
        await saveState(vfs, state);
        savedAt = now();
      }
    }
  }

  drive.onBytes = null;
  if (only !== null) {
    await publish();
    state.items = clone(known);
    await saveState(vfs, state);
    report(1, '');
    return summary;
  }
  report((steps - 1) / steps, tr('正在更新云端目录…'));
  // Folders, so that empty ones and their removal carry over too.
  /** @type {Record<string, boolean>} */
  const folders = clone(cloud.folders ?? {});   // relative path -> deleted?
  const seen = new Set(state.folders ?? []);
  const { folders: localDirs } = await scan(vfs);
  for (const rel of [...localDirs].sort((a, b) => b.length - a.length)) {
    const visible = (await vfs.list(rel)).filter(e => e.name !== '.DS_Store');
    if (folders[rel] === true && seen.has(rel) && visible.length === 0) {
      await vfs.remove(rel);
      localDirs.delete(rel);
    } else {
      folders[rel] = false;
    }
  }
  for (const rel of Object.keys(folders).sort()) {
    if (folders[rel] !== true && !localDirs.has(rel)) {
      if (seen.has(rel)) {
        folders[rel] = true;
      } else {
        await vfs.mkdir(rel);
        localDirs.add(rel);
      }
    }
  }
  state.folders = [...localDirs].sort();

  // Favourites and folder styles: the newer copy wins as a whole.
  const meta = clone((await vfs.kvGet('library')) ?? {});
  const theirs = cloud.meta ?? null;
  const mineTs = num(meta.ts), theirTs = num(theirs?.ts);
  if (theirs && theirTs > mineTs) {
    for (const key of ['favorites', 'folders']) if (theirs[key] != null) meta[key] = theirs[key];
    meta.ts = theirTs;
    await vfs.kvSet('library', meta);
    summary.meta = true;
  } else if (mineTs > theirTs) {
    cloud.meta = { ts: mineTs, favorites: meta.favorites ?? null, folders: meta.folders ?? null };
  }

  cloud.folders = folders;
  await publish();
  state.items = clone(known);
  state.last = now();
  await saveState(vfs, state);
  report(1, '');
  if (unmended.length) {
    const [name, why] = unmended[0];
    throw new DriveError(trf('“%s”缺少它的 PDF 或图片，暂时无法补全：%s', name, why));
  }
  return summary;
}
