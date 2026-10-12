// @ts-check
// Library paths: '/'-separated, relative to the library root, '' is the root itself.
// Names that start with '.' are invisible to the library (.trash, .deleted).

/** @param {...string} parts */
export function join(...parts) {
  return parts.filter(p => p !== '').join('/');
}

/** @param {string} path */
export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** @param {string} path */
export function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Like Python's os.path.splitext on a base name: a leading dot does not start an extension.
 * @param {string} name @returns {[string, string]} */
export function splitext(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || /^\.+$/.test(name.slice(0, i))) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

/** Whether `path` is `folder` or lies below it. @param {string} path @param {string} folder */
export function within(path, folder) {
  return folder === '' || path === folder || path.startsWith(folder + '/');
}

/** Replace the leading `from` of a path by `to` (a path inside a moved folder). */
export function rebase(path, from, to) {
  return to + path.slice(from.length);
}
