// @ts-check
// The settings dialog (B:prefs.py PrefsDialog; PORTING.md 8.4).
import { h } from './ui.js';
import { showDialog, inform, confirm } from './dialog.js';
import { toast } from './toast.js';
import { group, actionRow, switchRow, expanderRow, segmented, select, switchEl } from './controls.js';
import { openStorage } from './storage.js';
import { pickFiles, saveBlob } from '../platform/files.js';
import { getExportFont, chooseExportFont, clearExportFont } from '../io/exportfont.js';
import { loadClient, saveClient, installClient, exportClient, folderId, setFolderId, connected, disconnect, redirectUri, originUri, isLoopback } from '../sync/googleauth.js';
import { parseFolder, cloudFolderOf, lastSync } from '../sync/sync.js';
import { connect } from '../sync/cloudmenu.js';
import { fmtDate, tr, trf } from '../core/i18n.js';

const TOOL_ROWS = [['lasso', '套索'], ['eraser', '橡皮擦'], ['hl', '荧光笔'], ['shape', '形状'], ['text', '文本'], ['note', '便签'], ['tape', '胶带'], ['laser', '激光笔'], ['image', '插入图片'], ['ruler', '尺子']];
const EVERY = [[5, '5 秒'], [10, '10 秒'], [15, '15 秒'], [30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟']];

/** @param {number} bytes */
function size(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : String(n)) + ' ' + units[i];
}

/** @param {any} app @param {string} [section] */
export async function openPrefs(app, section) {
  const st = app.settings;
  const save = () => app.saveSettings();
  const set = (/** @type {string} */ key, /** @type {any} */ v) => { st[key] = v; save(); app.editor?.syncCanvas(); };
  const sch = app.scheduler;

  // -- appearance
  const appearance = group(tr('外观'), null,
    actionRow(tr('外观'), tr('页面本身始终保持纸张颜色'), segmented([{ label: tr('跟随系统'), value: 'system' }, { label: tr('浅色'), value: 'light' }, { label: tr('深色'), value: 'dark' }], st.theme || 'system', v => {
      set('theme', v); app.applyTheme(v); app.editor?.canvas.themeChanged();
    })),
    actionRow(tr('语言'), null, select([{ label: tr('自动'), value: 'auto' }, { label: '中文', value: 'zh' }, { label: 'English', value: 'en' }, { label: '日本語', value: 'ja' }], st.language || 'auto', async v => {
      st.language = v;
      await app.editor?.session.save();
      await app.flushSettings();
      location.reload();
    })));

  // -- writing
  const writing = group(tr('书写'), null,
    switchRow(tr('涂画以擦除'), null, st.scribble_erase, v => set('scribble_erase', v)),
    switchRow(tr('长按绘制规则形状'), tr('画完停住片刻，笔迹变成直线、矩形或椭圆'), st.hold_shape, v => set('hold_shape', v)),
    switchRow(tr('用手指书写'), tr('打开后单指书写，双指滚动和缩放'), st.finger_draw, v => set('finger_draw', v)),
    switchRow(tr('显示十字光标'), null, st.crosshair, v => set('crosshair', v)),
    switchRow(tr('有手写笔时鼠标不书写'), tr('用过手写笔之后，鼠标只用来移动页面'), st.mouse_hand, v => set('mouse_hand', v)),
    actionRow(tr('翻页方向'), null, segmented([{ label: tr('上下滚动'), value: 'vertical' }, { label: tr('左右翻页'), value: 'horizontal' }], st.paging, v => set('paging', v))),
    switchRow(tr('显示滚动条'), null, st.scrollbars, v => set('scrollbars', v)),
    actionRow(tr('最大放大倍数'), null, select([600, 1000, 2000, 4000].map(p => ({ label: p + '%', value: p / 100 })), st.max_zoom, v => set('max_zoom', v))));

  // -- Google Drive
  const client = await loadClient(app.vfs);
  const idEntry = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: client ? client.client_id : '', placeholder: tr('客户端 ID'), autocomplete: 'off', spellcheck: false }));
  const secretEntry = /** @type {HTMLInputElement} */ (h('input', { type: 'password', value: client ? client.client_secret || '' : '', placeholder: tr('客户端密钥'), autocomplete: 'off' }));
  const folder = await folderId(app.vfs);
  const syncedTo = await cloudFolderOf(app.vfs);
  const folderEntry = /** @type {HTMLInputElement} */ (h('input', { type: 'text', value: folder, placeholder: tr('留空：“我的云端硬盘”里名为 Inkpad 的文件夹'), style: { width: '100%' } }));
  const status = h('small');
  const refreshStatus = async () => {
    const on = await connected(app.vfs);
    const last = await lastSync(app.vfs);
    status.textContent = !on ? tr('尚未连接 Google Drive') : sch.busy ? tr('正在同步…') : sch.error ? tr('上次同步失败：') + sch.error : last ? tr('上次同步：') + fmtDate(tr('%-m月%-d日 %H:%M'), last) : tr('已连接，尚未同步');
    connectBtn.textContent = on ? tr('断开连接') : tr('连接 Google Drive…');
    connectBtn.classList.toggle('suggested', !on);
    syncBtn.disabled = !on;
  };
  const connectBtn = h('button', { onClick: async () => {
    if (await connected(app.vfs)) { await disconnect(app.vfs); sch.error = null; toast(tr('已断开 Google Drive；本机和云端的笔记都保留')); refreshStatus(); }
    else { await commit(); await connect(app); refreshStatus(); }
  } });
  const syncBtn = h('button', { onClick: () => sch.syncNow(false, false) }, tr('立即同步'));
  /** Save what is typed: the credentials and the folder. */
  const commit = async () => {
    try {
      if (idEntry.value.trim()) await saveClient(app.vfs, idEntry.value, secretEntry.value);
      const wanted = parseFolder(folderEntry.value);
      if (wanted !== (await folderId(app.vfs)) && (await loadClient(app.vfs))) {
        if (await confirm(tr('更改同步文件夹？'), tr('这台设备会把文稿库与新的文件夹重新比对。云端和本机的笔记都不会被删除。'), { ok: tr('更改') })) await setFolderId(app.vfs, wanted);
        else folderEntry.value = await folderId(app.vfs);
      }
    } catch (e) { app.reportError(tr('无法保存'), e); }
  };
  const copyable = (/** @type {string} */ label, /** @type {string} */ value) => h('div', { class: 'col', style: { gap: '2px' } }, h('small', { class: 'dim' }, label),
    h('div', { class: 'row' }, h('input', { type: 'text', readonly: true, value, style: { flex: 1 }, onFocus: (/** @type {Event} */ e) => /** @type {HTMLInputElement} */ (e.target).select() }),
      h('button', { onClick: async () => { try { await navigator.clipboard.writeText(value); toast(tr('已拷贝')); } catch { /* */ } } }, tr('拷贝'))));
  const google = group(tr('Google Drive 同步'), tr('同步使用你自己的 Google Cloud OAuth 客户端。在 Google Cloud 控制台里（与桌面版用同一个项目）创建“Web 应用”类型的 OAuth 客户端并启用 Google Drive API，把下面两个地址填进去，再把客户端 ID 和密钥填在这里。应用只申请访问它自己创建的文件。'),
    h('div', { class: 'arow', style: { flexDirection: 'column', alignItems: 'stretch', gap: '8px' } },
      copyable(tr('已获授权的 JavaScript 来源'), originUri()), copyable(tr('已获授权的重定向 URI'), redirectUri()),
      isLoopback() ? h('small', { class: 'dim' }, tr('这是本机地址：也可以直接用桌面版的“桌面应用”客户端。')) : null,
      location.protocol !== 'https:' && !isLoopback() ? h('small', { style: { color: 'var(--danger)' } }, tr('Google 只允许 https 网址或本机地址（localhost）登录。请通过 https 网址（例如 GitHub Pages）打开 Inkpad 后再连接。')) : null),
    actionRow(tr('客户端 ID'), null, idEntry), actionRow(tr('客户端密钥'), null, secretEntry),
    actionRow(tr('凭据'), tr('保存在本机浏览器里，不会发给 Google 以外的地方'),
      h('button', { onClick: commit }, tr('保存凭据')),
      h('button', { onClick: async () => { const [f] = await pickFiles({ accept: '.json,application/json' }); if (f) { try { await installClient(app.vfs, await f.text()); const c = await loadClient(app.vfs); idEntry.value = c ? c.client_id : ''; secretEntry.value = c ? c.client_secret || '' : ''; toast(tr('已导入凭据')); refreshStatus(); } catch (e) { app.reportError(tr('无法使用这个凭据文件'), e); } } } }, tr('从 JSON 导入')),
      h('button', { onClick: async () => { try { await saveBlob(await exportClient(app.vfs), 'inkpad-google-client.json', { description: 'JSON', accept: { 'application/json': ['.json'] } }); } catch (e) { app.reportError(tr('导出失败'), e); } } }, tr('导出为 JSON'))),
    actionRow(tr('当前同步文件夹'), syncedTo ? syncedTo : tr('尚未同步'), syncedTo ? h('button', { class: 'flat', onClick: () => window.open('https://drive.google.com/drive/folders/' + encodeURIComponent(syncedTo), '_blank', 'noopener') }, tr('在浏览器中打开')) : null),
    expanderRow(tr('如何把笔记放到云端硬盘的其它位置'), null,
      h('div', { class: 'arow', style: { flexDirection: 'column', alignItems: 'stretch', gap: '6px' } },
        h('small', { class: 'dim' }, tr('可先留空同步一次，把生成的“Inkpad”文件夹在 Google Drive 里移到想放的位置，再把它的 ID（或网址）填在这里。')), folderEntry,
        h('button', { onClick: commit, style: { alignSelf: 'flex-end' } }, tr('确定')))),
    actionRow(tr('打开的笔记本多久同步一次'), tr('每隔这么久查看一次其它设备写了什么；自己写的内容在停笔几秒后就会同步，与这里无关'),
      select(EVERY.map(([v, l]) => ({ label: tr(/** @type {string} */ (l)), value: v })), st.sync_every, v => { set('sync_every', v); sch.watch(); })),
    actionRow(tr('状态'), null, status), actionRow(tr('连接'), null, connectBtn, syncBtn));
  refreshStatus();
  const offSync = sch.onChange(refreshStatus);

  // -- storage
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = trf('已用 %s，配额 %s', size(e.usage || 0), size(e.quota || 0)); } catch { usage = tr('无法读取'); }
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const storage = group(tr('储存空间'), tr('笔记保存在这个浏览器里。清除网站数据会删掉它们：请连接云端同步，或定期导出整个文稿库。'),
    actionRow(tr('用量'), usage + (persisted ? '' : tr('（浏览器可能在空间不足时清除）'))),
    actionRow(tr('导出整个文稿库…'), null, h('button', { onClick: () => app.library.exportFolder('') }, tr('导出'))),
    actionRow(tr('导入存档（.zip）…'), null, h('button', { onClick: () => app.library.importArchive() }, tr('导入'))),
    actionRow(tr('管理储存空间…'), tr('本机已删除的笔记，和云端保留的已删除笔记'), h('button', { onClick: () => openStorage(app) }, tr('管理'))));

  // -- export font
  const font = await getExportFont(app.vfs);
  const fontName = h('small', null, font ? font.name : tr('尚未选择'));
  const exportGroup = group(tr('导出'), tr('导出 PDF 时，文本框和便签里的文字用这里选的字体，成为可选中、可搜索的矢量文字。'),
    actionRow(tr('导出 PDF 的字体'), null, fontName,
      h('button', { onClick: async () => { const f = await chooseExportFont(app); if (f) fontName.textContent = f.name; } }, tr('选择字体…')),
      h('button', { class: 'flat', onClick: async () => { await clearExportFont(app.vfs); fontName.textContent = tr('尚未选择'); } }, tr('清除'))));

  // -- toolbar
  const hidden = new Set(/** @type {string[]} */ (st.hidden_tools || []));
  const toolbar = group(tr('工具栏'), tr('关掉不用的工具，让工具栏更清爽。'),
    ...TOOL_ROWS.map(([name, label]) => switchRow(tr(label), null, !hidden.has(name), on => {
      if (on) hidden.delete(name); else hidden.add(name);
      set('hidden_tools', [...hidden]);
    })));

  // -- advanced
  const palm = /** @type {HTMLInputElement} */ (h('input', { type: 'number', min: 0, max: 1000, step: 10, value: st.palm_ms ?? 80, style: { width: '90px' },
    onChange: () => set('palm_ms', Math.max(0, Math.min(1000, Number(palm.value) || 0))) }));
  const advanced = group(tr('高级'), null,
    actionRow(tr('防误触时间（毫秒）'), tr('笔离开屏幕后的这段时间内忽略手指触摸；页面在写字时乱跳就调大，手指反应迟钝就调小'), palm),
    switchRow(tr('记录输入日志'), tr('遇到笔或触摸的问题时打开，再把日志发给开发者'), st.input_log, v => set('input_log', v)),
    actionRow(tr('输入日志'), null,
      h('button', { onClick: async () => { const log = await app.vfs.kvGet('input_log', ''); await saveBlob(new Blob([log], { type: 'text/plain' }), 'inkpad-input.log'); } }, tr('下载日志')),
      h('button', { class: 'flat', onClick: async () => { await app.vfs.kvDelete('input_log'); toast(tr('已清空')); } }, tr('清空'))));

  const body = h('div', { style: { padding: '4px 2px' } }, appearance, writing, google, storage, exportGroup, toolbar, advanced);
  const p = showDialog({ title: tr('设置'), className: 'prefs', closeButton: true, build: () => body });
  if (section === 'google') setTimeout(() => google.scrollIntoView(), 50);
  await p;
  offSync();
  await commit();
  void switchEl;
}
