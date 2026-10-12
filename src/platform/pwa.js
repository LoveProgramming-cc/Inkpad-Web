// @ts-check
// Inkpad as an installed app: the service worker that makes it work without a network, the offer
// to reload when a new version has arrived, installing, and files opened with it.
import { toast } from '../ui/toast.js';
import { tr } from '../core/i18n.js';

/** @type {any} the browser's own install prompt, kept for when the user asks */
let prompt = null;
let offline = false;

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;
export const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const canInstall = () => !!prompt;
/** Whether the app is kept for use without a network. */
export const worksOffline = () => offline;
/** A service worker needs https; a development server is left alone, so that a reload always shows the files as they are. */
export const offlineSupported = () => 'serviceWorker' in navigator && location.protocol === 'https:';

/** Show the browser's install prompt. @returns {Promise<boolean>} whether it was accepted */
export async function install() {
  if (!prompt) return false;
  const p = prompt;
  prompt = null;
  p.prompt();
  const choice = await p.userChoice.catch(() => null);
  return !!choice && choice.outcome === 'accepted';
}

/** @param {any} app */
export function startPwa(app) {
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); prompt = e; });
  addEventListener('appinstalled', () => { prompt = null; });

  // Files opened with the installed app (Chromium on a desktop) are imported.
  const queue = /** @type {any} */ (window).launchQueue;
  if (queue) {
    queue.setConsumer(async (/** @type {any} */ params) => {
      if (!params.files || !params.files.length) return;
      try {
        const files = await Promise.all(params.files.map((/** @type {any} */ handle) => handle.getFile()));
        const { importList } = await import('../io/importer.js');
        await importList(app, app.library ? app.library.folder : '', files);
        await app.library?.refresh();
      } catch (e) { app.reportError(tr('无法导入'), e); }
    });
  }

  if (!offlineSupported()) return;
  const sw = navigator.serviceWorker;
  // The first worker takes the page over without a reload; a later one means a new version.
  const hadController = !!sw.controller;
  offline = hadController;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    offline = true;
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
  /** @param {ServiceWorker|null} worker */
  const offer = worker => {
    if (!worker || !sw.controller) return;   // the very first install: nothing to replace
    toast(tr('Inkpad 有新版本'), { timeout: 60, action: { label: tr('重新载入'), fn: async () => {
      try { await app.editor?.session.save(); await app.flushSettings?.(); } catch { /* the reload goes ahead; autosave has what there is */ }
      worker.postMessage('skipWaiting');
    } } });
  };
  sw.register('sw.js').then(reg => {
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') offer(worker); });
    });
    // An installed app stays open for days: look for a new version whenever it comes back into view.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(e => console.error('service worker', e));
}
