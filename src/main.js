// @ts-check
// Start-up: open the store, set the language and theme, show the library; and the switch between
// the library and the editor.
import './platform/image.js';
import { Vfs, openIdb } from './platform/vfs.js';
import { setVfs, vfs as getVfs } from './core/storage.js';
import { Store } from './library/store.js';
import { LibraryView } from './library/libraryview.js';
import { loadSettings, saveSettings } from './core/settings.js';
import { installCoverRenderer } from './core/render.js';
import { useLanguage, tr } from './core/i18n.js';
import { h } from './ui/ui.js';
import { inform } from './ui/dialog.js';
import { toast } from './ui/toast.js';
import { menuPopover } from './ui/popover.js';
import { SyncScheduler } from './sync/scheduler.js';
import { startPwa } from './platform/pwa.js';
import { completeRedirect } from './sync/googleauth.js';

/** What the screens share. @type {any} */
export const app = {};

/** @param {string} title @param {any} err */
export function reportError(title, err) {
  console.error(err);
  inform(title, (err && err.message) || String(err));
}
app.reportError = reportError;

// The input log (settings: "record input log"): lines are gathered and written to kv['input_log']
// a little later, so that logging costs the pen nothing; the last 300 KB are kept.
/** @type {string[]} */
let logLines = [];
let logTimer = 0;
app.logInput = (/** @type {string} */ line) => {
  logLines.push(line);
  if (logTimer) return;
  logTimer = window.setTimeout(async () => {
    logTimer = 0;
    const lines = logLines; logLines = [];
    try {
      const old = await app.vfs.kvGet('input_log', '');
      await app.vfs.kvSet('input_log', (old + lines.join('\n') + '\n').slice(-300_000));
    } catch (e) { console.error(e); }
  }, 1000);
};

// An error nobody caught (a dialog that fails to build, say) would otherwise leave the button
// looking dead; show it. The message is all one gets on a tablet, where there is no console.
document.addEventListener('touchstart', () => {}, { passive: true });   // iOS shows :active only when something listens for touches
addEventListener('unhandledrejection', e => { toast(String((e.reason && (e.reason.message || e.reason)) || e.reason)); });
addEventListener('error', e => { if (e.message) toast(e.message); });

/** @param {string} theme 'system' | 'light' | 'dark' */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
}

let saveTimer = 0;
/** Preferences are written a moment after the last change. */
export function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { saveSettings(getVfs(), app.settings).catch(e => console.error(e)); }, 300);
}
app.saveSettings = saveSettingsSoon;
app.applyTheme = applyTheme;
/** Write the preferences now (before the page is reloaded). */
app.flushSettings = async () => { clearTimeout(saveTimer); await saveSettings(getVfs(), app.settings); };

async function boot() {
  const root = /** @type {HTMLElement} */ (document.getElementById('app'));
  let vfs;
  try {
    vfs = new Vfs(await openIdb());
  } catch (e) {
    root.append(h('div', { class: 'statuspage' }, h('h2', null, 'Inkpad'), h('p', null, 'The browser does not allow Inkpad to keep notes here (private browsing, or storage is blocked).'), h('p', { class: 'caption' }, String(e))));
    return;
  }
  vfs.watchOtherTabs();
  setVfs(vfs);
  app.vfs = vfs;
  app.settings = await loadSettings(vfs);
  await useLanguage(app.settings.language);
  applyTheme(app.settings.theme);
  installCoverRenderer();
  app.store = await Store.open(vfs);
  // Ask the browser not to clear the notes when it is short of space (PORTING.md R6, 7.8).
  navigator.storage?.persist?.().catch(() => {});

  app.library = new LibraryView({
    store: app.store, settings: app.settings, saveSettings: saveSettingsSoon,
    onOpen: path => openNotebook(path),
    onImport: folder => importInto(folder),
    importTree: (tree, folder) => importTree(tree, folder),
    onError: reportError,
    cloudPopover: anchor => cloudPopover(anchor),
    onSettings: () => openSettings(),
  });
  root.append(app.library.el);
  await app.library.init();
  app.scheduler = new SyncScheduler(app);
  app.openSettings = openSettings;
  // Back from a trip to Google's sign-in page.
  try { if (await completeRedirect(vfs)) toast(tr('已连接 Google Drive')); } catch (e) { reportError(tr('连接 Google Drive 失败'), e); }
  app.scheduler.start();
  startPwa(app);
  // Other tabs change the library too.
  vfs.onChange(() => { if (app.library && !app.editor) { clearTimeout(app._refreshTimer); app._refreshTimer = setTimeout(() => app.library.refresh(), 150); } });
  addEventListener('keydown', onKey);
  // Files dropped on the window are imported (into the open folder), or in the editor, put on the page as pictures.
  document.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', async e => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    try {
      const { droppedTree } = await import('./platform/files.js');
      const tree = await droppedTree(e.dataTransfer.items);
      if (app.editor) { for (const t of tree) if (t.file.type.startsWith('image/')) await app.editor.addPicture(t.file); return; }
      const { importDropped } = await import('./io/importer.js');
      await importDropped(app, tree, app.library.mode === 'docs' ? app.library.folder : '');
      await app.library.refresh();
    } catch (err) { reportError(tr('无法导入'), err); }
  });
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (app.editor) return;
  const mod = e.ctrlKey || e.metaKey;
  const t = /** @type {HTMLElement} */ (e.target);
  if (!mod || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); app.library.undoMove(); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); app.library.redoMove(); }
}

// -- the editor, settings, sync and import come with their own modules --------------------

/** @param {string} path */
async function openNotebook(path) {
  // A double tap asks twice, and opening takes a moment: a second editor would sit on top of the first.
  if (app.editor || app.opening) return;
  app.opening = true;
  try {
    const { openEditor } = await import('./editor/editorview.js');
    await openEditor(app, path);
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'MODULE_NOT_FOUND' || String(e).includes('Failed to fetch dynamically imported module')) toast('The editor is not built yet');
    else reportError(tr('无法打开'), e);
  } finally { app.opening = false; }
}
app.openNotebook = openNotebook;

/** @param {string} folder */
async function importInto(folder) {
  const { importFiles } = await import('./io/importer.js');
  await importFiles(app, folder);
}

/** @param {{rel: string, file: File}[]} tree @param {string} folder */
async function importTree(tree, folder) {
  const { importFolderTree } = await import('./io/importer.js');
  await importFolderTree(app, tree, folder);
}

/** @param {Element} anchor */
function cloudPopover(anchor) {
  import('./sync/cloudmenu.js').then(m => m.openCloudMenu(app, anchor)).catch(() => toast('Sync is not set up yet'));
}

/** @param {string} [section] */
function openSettings(section) {
  import('./ui/prefs.js').then(m => m.openPrefs(app, section)).catch(e => { console.error(e); reportError(tr('设置'), e); });
}

boot().catch(e => {
  console.error(e);
  document.body.append(h('pre', { style: { padding: '16px', color: 'crimson', whiteSpace: 'pre-wrap' } }, String(e && e.stack || e)));
});
