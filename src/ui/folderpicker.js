// @ts-check
// Ask which folder to move things to: the library's folders as a tree to tap in. Only the top
// level shows at first; the arrows open the rest. Nothing is chosen to begin with, so that
// nothing is moved by mistake (B:library.py `_pick_folder`).
import { h, icon } from './ui.js';
import { showDialog } from './dialog.js';
import { basename, dirname, within } from '../core/path.js';
import { tr } from '../core/i18n.js';

/**
 * @param {import('../library/store.js').Store} store @param {string} heading
 * @param {string[]} moving the folders being moved, which cannot go inside themselves
 * @returns {Promise<string|null>} the folder's path ('' is the library's top), null if cancelled
 */
export async function pickFolder(store, heading, moving) {
  const folders = (await store.folders()).filter(f => !moving.some(p => within(f, p)));
  const parents = new Set(folders.filter(f => f !== '').map(f => dirname(f)));
  const opened = new Set(['']);   // only the top level shows at first
  let chosen = /** @type {string|null} */ (null);
  const list = h('div', { class: 'folder-tree scroll' });
  /** @type {HTMLButtonElement} */
  let ok;
  const visible = (/** @type {string} */ f) => {
    if (f === '') return true;
    for (let up = dirname(f); ; up = dirname(up)) {
      if (!opened.has(up)) return false;
      if (up === '') return true;
    }
  };
  const draw = () => {
    if (chosen !== null && !visible(chosen)) chosen = null;
    list.replaceChildren(...folders.filter(visible).map(f => {
      const depth = f === '' ? 0 : f.split('/').length;
      return h('div', { class: ['tree-row', chosen === f && 'picked'], style: { paddingLeft: 4 + 22 * depth + 'px' }, onClick: () => { chosen = f; draw(); } },
        f !== '' && parents.has(f)
          ? h('button', { class: 'flat icon-btn tiny', onClick: (/** @type {Event} */ e) => { e.stopPropagation(); if (opened.has(f)) opened.delete(f); else opened.add(f); draw(); } }, icon(opened.has(f) ? 'chevron' : 'chevron_right', 14))
          : h('span', { style: { width: '34px', flex: 'none' } }),
        icon('documents', 18), h('span', { class: 'ellipsis' }, f === '' ? tr('文稿') : basename(f)));
    }));
    if (ok) ok.disabled = chosen === null;
  };
  const r = await showDialog({
    className: 'alert', dismissed: null,
    build: () => { draw(); return [h('h2', null, heading), h('div', { style: { marginTop: '12px' } }, list)]; },
    footer: close => [h('button', { onClick: () => close(null) }, tr('取消')),
      ok = /** @type {HTMLButtonElement} */ (h('button', { class: 'suggested', disabled: true, onClick: () => close(chosen) }, tr('移动')))],
  });
  return r === undefined ? null : r;
}
