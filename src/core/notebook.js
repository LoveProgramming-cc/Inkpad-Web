// @ts-check
// Facts about notebook files that sync and the library both need (B:model.notebook_id / set_notebook_id).
import { notebookId, setNotebookId } from './document.js';
import { ZipReader } from './zip.js';
import { withFileLock } from './storage.js';

/** The id of a notebook file, giving it one if it predates ids; cached on the file's record.
 * @param {import('../platform/vfs.js').Vfs} vfs @param {string} path @returns {Promise<string>} */
export async function notebookIdOf(vfs, path) {
  const st = await vfs.stat(path);
  if (st?.id) return st.id;
  const blob = await vfs.read(path);
  const found = await notebookId(blob);
  if (found.blob !== blob) await withFileLock(() => vfs.write(path, found.blob, { id: found.id }));
  else if (st) await vfs.annotate(path, st.rev, { id: found.id });
  return found.id;
}

/** Give a notebook file a different id (a copy made outside the app shares its original's).
 * @param {import('../platform/vfs.js').Vfs} vfs @param {string} path @param {string} id */
export async function setIdOf(vfs, path, id) {
  const blob = await vfs.read(path);
  const next = await setNotebookId(blob, id);
  await withFileLock(() => vfs.write(path, next, { id }));
}

/** A notebook's cover as PNG, or null. @param {import('../platform/vfs.js').Vfs} vfs @param {string} path */
export async function coverOf(vfs, path) {
  const st = await vfs.stat(path);
  if (!st || st.isDir) return null;
  if (st.cover) return st.cover;
  try {
    const z = await ZipReader.open(await vfs.read(path));
    const png = new Blob([await (await z.blobOf('cover.png')).arrayBuffer()], { type: 'image/png' });
    await vfs.annotate(path, st.rev, { cover: png });
    return png;
  } catch {
    return null;
  }
}
