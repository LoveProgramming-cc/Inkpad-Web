// The installable app: the manifest names files that exist, and the service worker's list of
// files is the one tools/build_sw.mjs would write now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { swState } from '../tools/build_sw.mjs';

const at = (/** @type {string} */ p) => new URL('../' + p, import.meta.url);

test('sw.js lists the files as they are now', async () => {
  const { current, wanted } = await swState();
  assert.equal(current, wanted, 'run: node tools/build_sw.mjs');
});

test('every precached file exists', async () => {
  const sw = await readFile(at('sw.js'), 'utf8');
  const files = JSON.parse(/const FILES = (\[[\s\S]*?\]);/.exec(sw)[1]);
  assert.ok(files.length > 60);
  for (const f of files) if (f !== './') assert.ok((await stat(at(f))).isFile(), f);
  for (const must of ['./', 'index.html', 'oauth.html', 'src/main.js', 'src/editor/editorview.js', 'src/vendor/pdfjs/pdf.worker.min.mjs']) assert.ok(files.includes(must), must);
});

test('the manifest is sound', async () => {
  const m = JSON.parse(await readFile(at('manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');   // relative: the site lives in a folder on GitHub Pages
  for (const icon of m.icons) assert.ok((await stat(at(icon.src))).isFile(), icon.src);
  assert.ok(m.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'));
});
