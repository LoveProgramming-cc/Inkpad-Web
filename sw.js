// The service worker: Inkpad opens and works without a network once it has been visited.
// Everything the app is made of is fetched when a version installs and kept in a cache named
// after that version, so the modules in use always belong together. The list below is written
// by tools/build_sw.mjs (tests/pwa.test.js fails when it is out of date).

/* precache:begin */
const VERSION = '001f6ca1e7d0';
const FILES = [
 "./",
 "css/base.css",
 "css/controls.css",
 "css/dialogs.css",
 "css/editor.css",
 "css/library.css",
 "css/tokens.css",
 "icons/icon-180.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "index.html",
 "manifest.webmanifest",
 "oauth.html",
 "src/core/clock.js",
 "src/core/color.js",
 "src/core/document.js",
 "src/core/draw.js",
 "src/core/errors.js",
 "src/core/find.js",
 "src/core/geom.js",
 "src/core/hash.js",
 "src/core/i18n.js",
 "src/core/icons.js",
 "src/core/items.js",
 "src/core/notebook.js",
 "src/core/pack.js",
 "src/core/page.js",
 "src/core/path.js",
 "src/core/pdfdoc.js",
 "src/core/ptext.js",
 "src/core/render.js",
 "src/core/settings.js",
 "src/core/storage.js",
 "src/core/uuid.js",
 "src/core/zip.js",
 "src/data/en.json",
 "src/data/icons.js",
 "src/data/ja.json",
 "src/data/web.json",
 "src/editor/canvas.js",
 "src/editor/editorview.js",
 "src/editor/input.js",
 "src/editor/minimap.js",
 "src/editor/pageops.js",
 "src/editor/pdfqueue.js",
 "src/editor/session.js",
 "src/editor/sidebar.js",
 "src/editor/tools.js",
 "src/io/exporter.js",
 "src/io/exportfont.js",
 "src/io/exportpdf.js",
 "src/io/goodnotes.js",
 "src/io/importer.js",
 "src/io/pdfctx.js",
 "src/library/folderart.js",
 "src/library/libraryview.js",
 "src/library/store.js",
 "src/main.js",
 "src/platform/canvas.js",
 "src/platform/files.js",
 "src/platform/image.js",
 "src/platform/pwa.js",
 "src/platform/vfs.js",
 "src/sync/blobs.js",
 "src/sync/cloudmenu.js",
 "src/sync/drive.js",
 "src/sync/errors.js",
 "src/sync/googleauth.js",
 "src/sync/oauth-return.js",
 "src/sync/scheduler.js",
 "src/sync/sync.js",
 "src/ui/controls.js",
 "src/ui/coverpicker.js",
 "src/ui/dialog.js",
 "src/ui/dom.js",
 "src/ui/folderpicker.js",
 "src/ui/paperdialog.js",
 "src/ui/popover.js",
 "src/ui/prefs.js",
 "src/ui/storage.js",
 "src/ui/toast.js",
 "src/ui/ui.js",
 "src/vendor/fontkit/fontkit.umd.min.js",
 "src/vendor/pdf-lib/pdf-lib.esm.min.js",
 "src/vendor/pdfjs/pdf.min.mjs",
 "src/vendor/pdfjs/pdf.worker.min.mjs"
];
/* precache:end */

const CACHE = 'inkpad-' + VERSION;
const RUNTIME = 'inkpad-runtime';   // what pdf.js asks for as it meets it: character maps, standard fonts
const scope = self.registration.scope;
const keyOf = (/** @type {string} */ path) => new URL(path, scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Past the HTTP cache: a version is what the server has now, not what was fetched ten minutes ago.
    await Promise.all(FILES.map(async path => {
      const res = await fetch(new Request(keyOf(path), { cache: 'reload' }));
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      await cache.put(keyOf(path), res);
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('inkpad-') && name !== CACHE && name !== RUNTIME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// The page asks a waiting version to take over when the user agrees to reload.
self.addEventListener('message', event => { if (event.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.href.startsWith(scope)) return;   // Google's servers and the like: not ours to answer
  event.respondWith((async () => {
    // Without the query: oauth.html comes back from Google with one, and it is the same page.
    let key = url.origin + url.pathname;
    if (key.endsWith('/index.html')) key = key.slice(0, -'index.html'.length);
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) return hit;
    const runtime = await caches.open(RUNTIME);
    const kept = await runtime.match(key);
    if (kept) return kept;
    try {
      const res = await fetch(req);
      if (res.ok && url.pathname.includes('/src/vendor/')) runtime.put(key, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (req.mode === 'navigate') { const home = await cache.match(scope); if (home) return home; }
      throw err;
    }
  })());
});
