// @ts-check
// Manage storage: what was deleted for good on this device, and what the cloud still holds of
// deleted notebooks (B:prefs.py `StorageDialog`, `cloud_deleted`, `cloud_restore`).
import { h } from './ui.js';
import { showDialog, confirm, inform } from './dialog.js';
import { toast } from './toast.js';
import { group, actionRow } from './controls.js';
import { cloudDeleted, cloudRestore } from '../sync/sync.js';
import { GoogleDrive } from '../sync/drive.js';
import { connected, folderId } from '../sync/googleauth.js';
import { fmtDate, tr, trf } from '../core/i18n.js';
import { basename } from '../core/path.js';

/** @param {number} bytes */
const size = bytes => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB');

/** @param {any} app */
export async function openStorage(app) {
  const store = app.store;
  const body = h('div');
  /** @type {() => void} */ let draw = () => {};
  const local = async () => {
    const items = await store.archived();
    const total = await store.cacheSize();
    return group(tr('本机已删除的笔记'), trf('永久删除的笔记仍保留在本机，共 %s。清理只影响本机，不会删除云端的任何内容。', size(total)),
      ...(items.length ? items.map((/** @type {any} */ e) => actionRow(e.name.replace(/^\d{8}-\d{6} /, ''), trf('恢复到：%s', store.archivedOrigin(e.path) || tr('文稿')), h('button', { onClick: async () => { await store.unarchive(e.path); await app.library.refresh(); draw(); } }, tr('恢复')))) : [actionRow(tr('没有已删除的项目'), null)]),
      actionRow(tr('清理缓存'), tr('本机上已永久删除的笔记将无法再恢复。云端的内容不受影响。'), h('button', { class: 'danger', disabled: !items.length, onClick: async () => { if (await confirm(tr('清理缓存？'), tr('本机上已永久删除的笔记将无法再恢复。云端的内容不受影响。'), { ok: tr('清理'), danger: true })) { await store.clearCache(); draw(); } } }, tr('清理'))));
  };
  /** @type {{id: string, path: string, ts: number}[]|null} */ let cloudList = null;
  const picked = new Set();
  const cloud = async () => {
    if (!(await connected(app.vfs))) return group(tr('云端保留的已删除笔记'), tr('连接 Google Drive 后可以看到。'));
    const rows = cloudList ? cloudList.map(c => h('label', { class: 'arow' }, h('input', { type: 'checkbox', checked: picked.has(c.id), onChange: (/** @type {Event} */ e) => { if (/** @type {HTMLInputElement} */ (e.target).checked) picked.add(c.id); else picked.delete(c.id); } }),
      h('div', { class: 't' }, h('b', null, basename(c.path).replace(/\.inkpad$/, '')), h('small', null, fmtDate(tr('%Y年%-m月%-d日 %H:%M'), c.ts))))) : [];
    return group(tr('云端保留的已删除笔记'), tr('在本机删除的笔记，云端的文件仍然保留，但不会自动下载回来。先读取云端目录，再选择要还原的笔记。'),
      ...rows, actionRow('', null,
        h('button', { onClick: async () => {
          try { cloudList = await cloudDeleted(app.vfs, new GoogleDrive(app.vfs), await folderId(app.vfs)); picked.clear(); if (!cloudList.length) toast(tr('云端没有已删除的笔记')); draw(); } catch (e) { app.reportError(tr('读取云端目录失败'), e); }
        } }, tr('读取云端目录')),
        h('button', { class: 'suggested', disabled: !cloudList || !picked.size, onClick: async () => {
          try {
            const n = await cloudRestore(app.vfs, new GoogleDrive(app.vfs), [...picked], await folderId(app.vfs));
            toast(trf('已还原 %d 本笔记', n)); cloudList = await cloudDeleted(app.vfs, new GoogleDrive(app.vfs), await folderId(app.vfs)); picked.clear();
            await app.library.refresh(); draw();
          } catch (e) { app.reportError(tr('还原失败'), e); }
        } }, tr('下载所选'))));
  };
  draw = async () => { body.replaceChildren(await local(), await cloud()); };
  await draw();
  await showDialog({ title: tr('管理储存空间'), className: 'prefs', closeButton: true, build: () => body });
  void inform;
}
