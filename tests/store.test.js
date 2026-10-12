import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/library/store.js';
import { memoryVfs } from '../src/platform/vfs.js';
import { setVfs } from '../src/core/storage.js';
import { Document, notebookId } from '../src/core/document.js';
import { Stroke } from '../src/core/items.js';
import { ZipReader } from '../src/core/zip.js';
import { loadSettings, saveSettings, DEFAULTS } from '../src/core/settings.js';

const tpl = { w: 595, h: 842, paper: 'blank', color: [1, 1, 1] };

async function fresh() {
  const vfs = memoryVfs();
  setVfs(vfs);
  return { vfs, store: await Store.open(vfs) };
}
const names = async (store, folder = '') => (await store.entries(folder)).map(e => e.name).sort();

test('new notebooks get free names and show up in their folder', async () => {
  const { store } = await fresh();
  const a = await store.newNotebook('', tpl, '笔记');
  const b = await store.newNotebook('', tpl, '笔记');
  assert.deepEqual([a, b], ['笔记.inkpad', '笔记 2.inkpad']);
  const folder = await store.newFolder('', '数学');
  assert.equal(folder, '数学');
  assert.equal(await store.newFolder('', '数学'), '数学 2');
  assert.deepEqual(await names(store), ['数学', '数学 2', '笔记', '笔记 2']);
  assert.deepEqual(await store.folders(), ['', '数学', '数学 2']);
});

test('hidden things are not in the library', async () => {
  const { store, vfs } = await fresh();
  await vfs.write('.sync/x.inkpad', new Blob(['x']));
  await vfs.write('other.txt', new Blob(['x']));
  await store.newNotebook('', tpl, 'a');
  assert.deepEqual(await names(store), ['a']);
  assert.deepEqual(await store.folders(), ['']);
  assert.equal((await store.find('x')).length, 0);
});

test('rename keeps favourites and folder styles pointing at the item (and what is inside it)', async () => {
  const { store } = await fresh();
  const dir = await store.newFolder('', 'A');
  const nb = await store.newNotebook(dir, tpl, 'n');
  await store.toggleFavorite(nb);
  await store.setFolderStyle(dir, { color: [1, 0, 0], icon: 'book' });
  const now = await store.rename(dir, ' B/C ');
  assert.equal(now, 'B-C');
  assert.deepEqual(store.meta.favorites, ['B-C/n.inkpad']);
  assert.deepEqual(store.folderStyle('B-C'), { color: [1, 0, 0], icon: 'book' });
  assert.deepEqual(store.folderStyle('A'), { color: store.folderStyle('zzz').color, icon: '' });
  assert.equal(await store.rename('B-C', 'B-C'), 'B-C', 'same name: nothing to do');
  assert.equal(await store.rename('B-C', '  '), 'B-C', 'empty name: nothing to do');
  assert.deepEqual((await store.favorites()).map(e => e.path), ['B-C/n.inkpad']);
});

test('moving: into a folder, back under the old name, never into itself (A:testMovesCanBeUndone)', async () => {
  const { store } = await fresh();
  const a = await store.newNotebook('', tpl, 'x');
  const dir = await store.newFolder('', 'D');
  await store.newNotebook(dir, tpl, 'x');
  const moved = await store.move(a, dir);
  assert.equal(moved, 'D/x 2.inkpad', 'the name was taken');
  const back = await store.move(moved, '', 'x.inkpad');
  assert.equal(back, 'x.inkpad', 'undo gives the old name back');
  assert.equal(await store.move(back, ''), back);
  await assert.rejects(store.move(dir, dir), /自己里面/);
  const inner = await store.newFolder(dir, 'inner');
  await assert.rejects(store.move(dir, inner), /自己里面/);
});

test('trash, restore, delete for good, bring back', async () => {
  const { store, vfs } = await fresh();
  const dir = await store.newFolder('', 'D');
  const nb = await store.newNotebook(dir, tpl, 'n');
  await store.toggleFavorite(nb);
  await store.trash(nb);
  assert.deepEqual(store.meta.favorites, []);
  assert.deepEqual((await store.trashed()).map(e => e.name), ['n']);
  assert.equal(store.meta.trashed['n.inkpad'], 'D');
  await store.restore('.trash/n.inkpad');
  assert.ok(await vfs.exists('D/n.inkpad'));
  await store.trash('D/n.inkpad');
  await store.delete('.trash/n.inkpad');
  assert.deepEqual(await store.trashed(), []);
  const kept = (await store.archived())[0];
  assert.match(kept.path, /^\.deleted\/\d{8}-\d{6} n\.inkpad$/);
  assert.equal(store.archivedOrigin(kept.path), 'D');
  assert.ok(await store.cacheSize() > 0);
  await vfs.remove('D');                                  // the folder it came from is gone too
  const again = await store.unarchive(kept.path);
  assert.equal(again, 'D/n.inkpad');
  await store.trash(again);
  await store.delete('.trash/n.inkpad');
  await store.clearCache();
  assert.equal(await store.cacheSize(), 0);
  assert.deepEqual(await store.archived(), []);
  await assert.rejects(store.delete('D'), /only trashed/);
});

test('a restored item whose folder is gone goes to the root', async () => {
  const { store, vfs } = await fresh();
  const dir = await store.newFolder('', 'D');
  await store.trash(await store.newNotebook(dir, tpl, 'n'));
  await vfs.remove('D');
  await store.restore('.trash/n.inkpad');
  assert.ok(await vfs.exists('n.inkpad'));
});

test('a copy is a notebook of its own, with a new id (A:testCopyGetsItsOwnID)', async () => {
  const { store, vfs } = await fresh();
  const dir = await store.newFolder('', 'D');
  const nb = await store.newNotebook(dir, tpl, 'n');
  const doc = await Document.load(await vfs.read(nb), { path: nb });
  doc.addItems(doc.pages[0], [new Stroke('ball', [0, 0, 0], 1, [[1, 1, 0.5], [2, 2, 0.5]])]);
  await doc.save();
  await store.setFolderStyle(dir, { icon: 'star' });
  const copy = await store.duplicate(nb);
  assert.equal(copy, 'D/n 副本.inkpad');
  const idA = await store.notebookId(nb), idB = await store.notebookId(copy);
  assert.notEqual(idA, idB);
  assert.equal((await Document.load(await vfs.read(copy))).pages[0].items.length, 1);
  assert.equal((await Document.load(await vfs.read(copy))).id, idB, 'document.json carries the new id too');
  const dirCopy = await store.duplicate(dir);
  assert.equal(dirCopy, 'D 副本');
  assert.equal(store.folderStyle(dirCopy).icon, 'star');
  const ids = await Promise.all((await vfs.list(dirCopy)).map(e => store.notebookId(e.path)));
  assert.equal(ids.length, 2);
  assert.ok(!ids.includes(idA) && !ids.includes(idB));
});

test('archives: export everything, import it into another library', async () => {
  const { store } = await fresh();
  const dir = await store.newFolder('', 'D');
  await store.newNotebook(dir, tpl, 'one');
  await store.newNotebook('', tpl, 'two');
  await store.setFolderStyle(dir, { color: [0.1, 0.2, 0.3], icon: 'book' });
  const { blob, count } = await store.exportArchive('');
  assert.equal(count, 2);
  const z = await ZipReader.open(blob);
  assert.deepEqual(z.names.sort(), ['D/', 'D/one.inkpad', 'inkpad-library.json', 'two.inkpad']);
  assert.ok(z.entries.every(e => e.method === 0), 'all stored');
  assert.deepEqual(JSON.parse(await z.text('inkpad-library.json')), { app: 'Inkpad', folders: { D: { color: [0.1, 0.2, 0.3], icon: 'book' } } });

  const other = await fresh();
  await other.store.newNotebook('', tpl, 'two');                      // already there: never overwritten
  assert.equal(await other.store.importArchive(blob, ''), 2);
  assert.deepEqual(await names(other.store), ['D', 'two', 'two 2']);
  assert.deepEqual(await names(other.store, 'D'), ['one']);
  assert.deepEqual(other.store.folderStyle('D'), { color: [0.1, 0.2, 0.3], icon: 'book' });

  const some = await store.exportPaths(['D', 'two.inkpad']);
  assert.equal(some.count, 2);
  const names2 = (await ZipReader.open(some.blob)).names.sort();
  assert.deepEqual(names2, ['D/', 'D/one.inkpad', 'inkpad-library.json', 'two.inkpad']);
});

test('importing refuses paths that climb out or hide', async () => {
  const { store, vfs } = await fresh();
  const { ZipWriter } = await import('../src/core/zip.js');
  const nb = await vfs.read(await store.newNotebook('', tpl, 'ok'));
  const w = new ZipWriter();
  await w.add('../evil.inkpad', nb, { compress: false });
  await w.add('.hidden/x.inkpad', nb, { compress: false });
  await w.add('/abs.inkpad', nb, { compress: false });
  await w.add('fine/ok.inkpad', nb, { compress: false });
  const into = await fresh();
  assert.equal(await into.store.importArchive(w.finish(), ''), 1);
  assert.deepEqual(await names(into.store), ['fine']);
});

test('search finds notebooks and folders anywhere by name', async () => {
  const { store } = await fresh();
  const dir = await store.newFolder('', 'Maths');
  await store.newNotebook(dir, tpl, 'Algebra');
  await store.newNotebook('', tpl, 'Biology');
  assert.deepEqual((await store.find('a')).map(e => e.name).sort(), ['Algebra', 'Maths']);
  assert.deepEqual((await store.find('alg')).map(e => e.path), ['Maths/Algebra.inkpad']);
});

test('the id and cover of a notebook are cached on the file record', async () => {
  const { store, vfs } = await fresh();
  const nb = await store.newNotebook('', tpl, 'n');
  assert.ok((await vfs.stat(nb)).id, 'saving remembers the id');
  assert.ok((await vfs.stat(nb)).cover, 'and the cover');
  // a file that came in without that (a download): worked out on first use
  await vfs.write('dl.inkpad', await vfs.read(nb));
  assert.equal((await vfs.stat('dl.inkpad')).id, undefined);
  const id = await store.notebookId('dl.inkpad');
  assert.equal(id, (await notebookId(await vfs.read(nb))).id);
  assert.equal((await vfs.stat('dl.inkpad')).id, id);
  const cover = await store.cover('dl.inkpad');
  assert.ok(cover.size > 0);
  assert.equal((await vfs.stat('dl.inkpad')).cover.size, cover.size);
});

test('meta survives a reopen; settings load over the defaults', async () => {
  const { store, vfs } = await fresh();
  const nb = await store.newNotebook('', tpl, 'n');
  await store.toggleFavorite(nb);
  const again = await Store.open(vfs);
  assert.deepEqual(again.meta.favorites, [nb]);
  assert.ok(again.meta.ts > 1e9);
  assert.deepEqual(await loadSettings(vfs), DEFAULTS);
  await saveSettings(vfs, { sort: 'name', pen_color: 'wrong type', nonsense: 1, pens: { ball: { sens: 70 }, laser: {} } });
  const s = await loadSettings(vfs);
  assert.equal(s.sort, 'name');
  assert.equal(s.pen_color, 4, 'a value of the wrong type is ignored');
  assert.equal(s.nonsense, undefined);
  assert.equal(s.pens.ball.sens, 70);
  assert.deepEqual(s.pens.ball.widths, [0.7, 1.2, 2.0]);
  assert.equal(s.pens.laser, undefined);
});
