// @ts-check
// The menu of the cloud button in the library (B:window.py `_cloud_popover`).
import { h } from '../ui/ui.js';
import { openPopover } from '../ui/popover.js';
import { toast } from '../ui/toast.js';
import { connected, loadClient, authorize, disconnect, canSignIn } from './googleauth.js';
import { lastSync } from './sync.js';
import { fmtDate, tr } from '../core/i18n.js';

/** @param {any} app @param {Element} anchor */
export async function openCloudMenu(app, anchor) {
  const sch = app.scheduler;
  const lib = app.library;
  const box = h('div', { class: 'col', style: { width: '280px' } });
  const pop = openPopover(box, { anchor, side: 'bottom', align: 'end', onClose: () => { lib.syncBar = null; off(); } });
  const caption = (/** @type {string} */ t) => h('div', { class: 'caption dim' }, t);
  const button = (/** @type {string} */ text, /** @type {() => void} */ fn, cls = '') => h('button', { class: cls, onClick: () => { pop.close(); fn(); } }, text);
  /** Put in the menu what is true now. Done again when a sync ends while it is open. */
  const fill = async () => {
    lib.syncBar = null;
    box.replaceChildren(h('h4', null, 'Google Drive'));
    if (!(await connected(app.vfs))) {
      box.append(caption(tr('把文稿库同步到你的 Google Drive 里的“Inkpad”文件夹。应用只能访问它自己创建的文件。')),
        button(tr('连接 Google Drive…'), () => connect(app), 'suggested'));
      pop.place();
      return;
    }
    const last = await lastSync(app.vfs);
    const status = sch.busy ? tr('正在同步…') : sch.error ? tr('上次同步失败：') + sch.error : last ? tr('上次同步：') + fmtDate(tr('%-m月%-d日 %H:%M'), last) : tr('已连接，尚未同步');
    box.append(caption(status));
    if (sch.busy) {
      // The running sync reports here, and only here. The name of the notebook being moved has two lines to itself.
      const name = h('div', { class: 'caption center', style: { height: '38px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } });
      const bar = h('i', { style: { width: '0%' } });
      const percent = h('div', { class: 'caption dim center mono' });
      box.append(name, h('div', { class: 'progress' }, bar), percent);
      lib.syncBar = { bar, name, percent };
      lib.setSyncProgress(lib.syncFraction, lib.syncText);
    }
    box.append(caption(tr('回到文稿库时自动同步。删除的笔记会进入废纸篓，两边都改过的会保留副本。')),
      button(tr('立即同步'), () => sch.syncNow(false, false), 'suggested'), button(tr('断开连接'), async () => { await disconnect(app.vfs); sch.error = null; toast(tr('已断开 Google Drive；本机和云端的笔记都保留')); }));
    pop.place();
  };
  const off = sch.onChange(() => { if (!pop.el.isConnected) return; fill(); });
  await fill();
}

/** Sign in: needs the client credentials first (the settings have the place to put them). @param {any} app */
export async function connect(app) {
  if (!(await loadClient(app.vfs))) { app.openSettings?.('google'); toast(tr('请先填写 Google 客户端凭据')); return; }
  if (!canSignIn()) {
    // Google signs in only pages served over https, or from this very machine.
    app.reportError(tr('这个地址无法登录 Google'), new Error(tr('Google 只允许 https 网址或本机地址（localhost）登录。请通过 https 网址（例如 GitHub Pages）打开 Inkpad 后再连接。')));
    return;
  }
  try {
    toast(tr('请在弹出的窗口中登录 Google 并授权'));
    const done = await authorize(app.vfs);
    if (done) { toast(tr('已连接 Google Drive')); app.scheduler.syncNow(false, false); }
  } catch (e) { app.reportError(tr('连接 Google Drive 失败'), e); }
}
