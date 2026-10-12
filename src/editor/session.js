// @ts-check
// An open notebook and its file: autosave, and what to do when something else (a sync, another
// tab) wrote the file meanwhile. PORTING.md 7.9; A:AppModel.swift `EditorSession`.
//
//  - Every change to the document (state, pages, meta events) while it is `modified` restarts a
//    1.5 s timer; when it runs out the notebook is written.
//  - A write is put off while something is being done on the canvas (`busy()`) or the last one is
//    still going. Otherwise: if the file is not what this document last read or wrote and nothing
//    is being done, the file's version is folded in first (`absorb`); then it is written with the
//    sign it was last known by, so that a file written by someone else in between is not lost.
//  - If the write finds the file changed (Changed): nothing was written, try again; after three
//    refusals in a row it is written without the check.
import { Document, merge } from '../core/document.js';
import { Changed } from '../core/errors.js';
import { withFileLock, vfs as defaultVfs } from '../core/storage.js';

export const SAVE_DELAY = 1500;

export class EditorSession {
  /**
   * @param {import('../core/document.js').Document} doc @param {object} [o]
   * @param {() => boolean} [o.busy] true while something is being done on the canvas
   * @param {() => void} [o.onEdit] told when the document changed (the sync scheduler wants to know)
   * @param {(err: any) => void} [o.onError] a save that failed
   * @param {() => void} [o.onSaved]
   * @param {import('../platform/vfs.js').Vfs} [o.vfs]
   */
  constructor(doc, { busy = () => false, onEdit, onError, onSaved, vfs } = {}) {
    this.doc = doc;
    this.busy = busy;
    this.onEdit = onEdit;
    this.onError = onError;
    this.onSaved = onSaved;
    this.vfs = vfs ?? doc.store ?? defaultVfs();
    this.timer = 0;
    this.saving = false;
    this.refused = 0;
    this.closed = false;
    this._unlisten = doc.listen((kind) => {
      if ((kind === 'state' || kind === 'pages' || kind === 'meta') && doc.modified) this.schedule();
    });
  }

  schedule(delay = SAVE_DELAY) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.save(), delay);
    this.onEdit?.();
  }

  /** Write now if there is something to write, or as soon as nothing is in the way. */
  async save() {
    clearTimeout(this.timer);
    this.timer = 0;
    const doc = this.doc;
    if (this.closed || !doc.path) return;
    if (this.busy() || this.saving) { this.timer = window.setTimeout(() => this.save(), 400); return; }
    if (!doc.modified) return;
    this.saving = true;
    try {
      await withFileLock(async () => {
        if (this.busy()) throw new Retry();
        // Never write over what something else put in the file: fold it in first.
        if (await doc.stale()) await doc._absorb();
        const snap = await doc.snapshot();
        const blob = await Document.encode(snap);
        const expect = this.refused >= 3 ? null : doc.sign;
        doc.sign = await this.vfs.write(/** @type {string} */ (doc.path), blob, { expect, cover: snap.cover, id: doc.id });
        doc.savedRev = snap.rev;
        this.refused = 0;
      });
      doc.emit('state');
      this.onSaved?.();
    } catch (e) {
      if (e instanceof Changed) { this.refused++; this.timer = window.setTimeout(() => this.save(), 100); }
      else if (e instanceof Retry) this.timer = window.setTimeout(() => this.save(), 400);
      else { this.onError?.(e); }
    } finally {
      this.saving = false;
    }
    // Edited while it was being written: again.
    if (!this.closed && doc.modified && !this.timer) this.schedule(400);
  }

  /** The file was changed by something else: take it in (merging what was done here since, if anything). */
  async absorb() {
    const doc = this.doc;
    if (this.busy()) { setTimeout(() => this.absorb(), 400); return; }
    await doc.absorb();
    if (doc.modified) this.schedule();
  }

  /** Save what is unsaved and stop. */
  async close() {
    clearTimeout(this.timer);
    this.timer = 0;
    // wait for a write that is going on, then write the rest
    for (let n = 0; n < 50 && this.saving; n++) await new Promise(r => setTimeout(r, 40));
    this.closed = false;
    if (this.doc.modified && this.doc.path) {
      this.saving = false;
      const wasBusy = this.busy;
      this.busy = () => false;
      await this.save();
      this.busy = wasBusy;
    }
    this.closed = true;
    this._unlisten();
  }
}

class Retry extends Error {}

export { merge };
