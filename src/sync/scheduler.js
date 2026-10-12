// @ts-check
// When to sync (B:window.py `sync_now`, `_watch_open`, `_sync_after_edit`, `_follow_sync`; A:AppModel;
// PORTING.md 7.10). Whole-library syncs and syncs of the open notebook alone, quiet or loud.
import { sync, scan, config } from './sync.js';
import { GoogleDrive } from './drive.js';
import { connected, folderId } from './googleauth.js';
import { notebookIdOf } from '../core/notebook.js';
import { now, mono } from '../core/clock.js';
import { toast } from '../ui/toast.js';
import { tr, trf } from '../core/i18n.js';

export class SyncScheduler {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.busy = false;
    /** @type {string|null} */ this.error = null;
    /** @type {[boolean, boolean]|null} */ this.next = null;   // a sync asked for while one was running: [quiet, only the open notebook]
    this.editTimer = 0;
    this.openSynced = 0;    // when the open notebook was last synced (mono ms), and how long that took
    this.openTook = 0;
    this.checked = false;   // the first whole-library sync of this run is a thorough one
    this.lastEnd = 0;
    /** @type {Set<() => void>} */ this.listeners = new Set();
    this.watchTimer = 0;
  }

  /** Something in the cloud menu wants to know when the state changes. @param {() => void} fn */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _changed() { for (const fn of [...this.listeners]) fn(); }

  /** Sync shortly after launch, then every ten minutes in the library, and when the page comes back. */
  start() {
    setTimeout(() => this.syncNow(true), 2000);
    setInterval(() => { if (document.visibilityState === 'visible' && !this.app.editor) this.syncNow(true); }, 600_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.syncNow(true);
      else if (mono() - this.lastEnd > 120_000) this.syncNow(true);
    });
    this.watch();
  }

  /** A notebook that is open is looked up on Drive every `sync_every` seconds for what other devices wrote. */
  watch() {
    clearInterval(this.watchTimer);
    const every = Math.min(300, Math.max(5, Number(this.app.settings.sync_every || 30)));
    this.watchTimer = window.setInterval(() => {
      // A look that comes while a sync is still running is left out, so that a short interval does not queue them up.
      if (this.app.editor && document.visibilityState === 'visible' && !this.editTimer && !this.busy) this.syncOpen();
    }, every * 1000);
  }

  // -- hooks the editor calls -----------------------------------------------------------------------

  /** A notebook was opened: it is synced by itself. @param {any} ed */
  opened(ed) { this.syncOpen(); }

  /** The document changed (and is written soon): sync the open notebook once the pen has rested, and not
   * sooner after the last sync than that one took, so that a large notebook is not sent non-stop. */
  async edited() {
    if (!(await connected(this.app.vfs))) return;
    clearTimeout(this.editTimer);
    const wait = Math.max(6000, this.openSynced + 4 * this.openTook - mono());
    this.editTimer = window.setTimeout(() => {
      this.editTimer = 0;
      if (this.app.editor?.canvas.op || this.busy) this.edited(); else this.syncOpen();
    }, wait);
  }

  /** Back in the library. */
  closed() { this.syncNow(true); }

  async syncOpen() {
    const ed = this.app.editor;
    if (ed && ed.doc.path && (await connected(this.app.vfs))) this.syncNow(true, true);
  }

  // -- the sync -------------------------------------------------------------------------------------------

  /** Sync the library with Google Drive in the background, or with only=true just the notebook that is open.
   * @param {boolean} [quiet] @param {boolean} [only] */
  async syncNow(quiet = false, only = false) {
    const app = this.app;
    if (!(await connected(app.vfs))) return;
    if (this.busy) {
      // Not forgotten: it runs when this one is over. The whole library outranks one notebook.
      const was = this.next;
      this.next = [quiet && (was === null || was[0]), only && (was === null || was[1])];
      return;
    }
    const ed = app.editor;
    only = only && !!ed && !!ed.doc.path;
    const began = mono();
    this.busy = true;
    app.library.setSyncing(true);
    this._changed();
    // The open notebook syncs like any other. It is saved first; what the sync then does to its file
    // is taken into the editor when the sync is over (and before any later save).
    try { if (ed && !ed.canvas.op) await ed.session.save(); } catch { /* the save reports its own error */ }
    // Thorough when the user asks for a sync, and once when the app has started; quick otherwise
    // (the sync decides for itself when it is time to look again): see sync().
    const thorough = !quiet || !this.checked ? true : null;
    if (!only) this.checked = true;
    let result = null, error = null;
    try {
      result = await sync(app.vfs, new GoogleDrive(app.vfs), {
        only: only ? [/** @type {string} */ (ed.doc.path)] : null, folder: await folderId(app.vfs), thorough,
        progress: (f, t) => app.library.setSyncProgress(f, t),
      });
    } catch (e) { error = e; }
    this.busy = false;
    app.library.setSyncing(false);
    this.error = error ? String((/** @type {any} */ (error)).message || error) : null;
    this.lastEnd = mono();
    this._changed();
    // Even a sync that failed may have brought something for the open notebook.
    if (await this.follow()) setTimeout(() => this.follow(), 400);
    this.openSynced = mono();
    if (only) this.openTook = this.openSynced - began;
    if (this.next) {
      const [q, o] = this.next;
      this.next = null;
      setTimeout(() => this.syncNow(q, o), 0);
    }
    if (error) { if (!quiet) toast(trf('同步失败：%s', this.error)); return; }
    const r = /** @type {NonNullable<typeof result>} */ (result);
    if (r.meta) await app.store.reloadMeta();
    const changed = r.down || r.removed || r.conflicts || r.moved || r.meta || r.merged;
    if (changed && !app.editor) await app.library.refresh();
    if (r.merged && !quiet) toast(trf('同步完成：%d 本笔记两边都改过，已自动合并', r.merged));
    if (r.conflicts) toast(trf('同步完成：%d 本笔记两边都改过，云端版本已另存为副本', r.conflicts));
    else if (!quiet) toast(r.up || r.down || r.merged ? trf('同步完成：上传 %d，下载 %d，合并 %d', r.up, r.down, r.merged) : tr('已是最新'));
  }

  /** After a sync the open notebook may have been merged, replaced, moved or deleted (A:followOpenNotebook).
   * True when it should be looked at again in a moment. */
  async follow() {
    const ed = this.app.editor;
    if (!ed) return false;
    if (ed.canvas.op) return true;   // in the middle of a stroke; look again in a moment
    const doc = ed.doc, vfs = this.app.vfs;
    if (!doc.path) return false;
    if (!(await vfs.exists(doc.path))) {
      // Renamed or moved by another device: it is the file with the same id.
      const { notebooks } = await scan(vfs);
      let found = null;
      for (const p of notebooks.keys()) {
        try { if ((await notebookIdOf(vfs, p)) === doc.id) { found = p; break; } } catch { /* not readable */ }
      }
      if (found) {
        doc.path = found;
        doc.sign = '0/0';   // its content may be another too
        ed.updateTitle();
        await ed.session.absorb();
      } else if (!doc.modified) {
        // Deleted on another device: it is in the trash here now.
        await ed.goHome();
        toast(tr('已删除'));
      }
      return false;
    }
    if (await doc.stale()) await ed.session.absorb();
    return false;
  }
}

export { config };
