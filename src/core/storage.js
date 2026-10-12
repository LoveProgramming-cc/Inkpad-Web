// @ts-check
// The file store the library and the documents live in, and the lock that goes with it.
// Everything above this layer reaches storage through here, so tests can swap in a memory store.

/** @type {import('../platform/vfs.js').Vfs | null} */
let current = null;

/** @param {import('../platform/vfs.js').Vfs} v */
export function setVfs(v) { current = v; }

export function vfs() {
  if (!current) throw new Error('storage is not open');
  return current;
}

// PORTING.md 7.8: B holds a reentrant lock while a notebook file is compared with what is
// expected and replaced. Web Locks are not reentrant, so only the outermost public function
// takes it (Document.save, an editor's autosave write, the places in sync that put another
// device's version in place), and what it calls does not. Inside, only storage is awaited.
/** @type {Promise<any>} */
let chain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withFileLock(fn) {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return /** @type {Promise<T>} */ (navigator.locks.request('inkpad-file', fn));
  }
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}
