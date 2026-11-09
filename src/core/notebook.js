// @ts-check
// Facts about notebook files that sync and the library both need (B:model.notebook_id / set_notebook_id).
import { coverSpecOf, designedCover, notebookId, setNotebookId } from './document.js';
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

/** A notebook's cover as PNG, or null. A designed cover carries the notebook's name, which is the
 * file's name now: the picture stored in the file was drawn with the name it had then, and a rename
 * (in the library, or from another device) does not redraw it. So it is drawn here with the
 * present name; the picture remembered on the file's record says which name it shows.
 * @param {import('../platform/vfs.js').Vfs} vfs @param {string} path */
export async function coverOf(vfs, path) {
  const st = await vfs.stat(path);
  if (!st || st.isDir) return null;
  const base = path.slice(path.lastIndexOf('/') + 1);
  const name = base.lastIndexOf('.') > 0 ? base.slice(0, base.lastIndexOf('.')) : base;
  if (st.cover && (st.coverName === undefined || st.coverName === name)) return st.cover;
  try {
    const z = await ZipReader.open(await vfs.read(path));
    let spec = null;
    try { spec = coverSpecOf(JSON.parse(await z.text('document.json'))); } catch { /* no designed cover to read */ }
    const drawn = spec ? await designedCover(spec, name) : null;
    const png = drawn ?? new Blob([await (await z.blobOf('cover.png')).arrayBuffer()], { type: 'image/png' });
    await vfs.annotate(path, st.rev, drawn ? { cover: png, coverName: name } : { cover: png });
    return png;
  } catch {
    return null;
  }
}
