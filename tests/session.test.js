import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryVfs } from '../src/platform/vfs.js';
import { Store } from '../src/library/store.js';
import { setVfs } from '../src/core/storage.js';
import { Document } from '../src/core/document.js';
import { Stroke } from '../src/core/items.js';
import { EditorSession } from '../src/editor/session.js';

globalThis.window ??= globalThis;
const tpl = { w: 595, h: 842, paper: 'blank', color: [1, 1, 1] };
const stroke = x => new Stroke('ball', [0, 0, 0], 1, [[x, 0, 0.5], [x, 50, 0.5]]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open() {
  const vfs = memoryVfs();
  setVfs(vfs);
  const store = await Store.open(vfs);
  const path = await store.newNotebook('', tpl, 'n');
  const f = await vfs.readFile(path);
  const doc = await Document.load(f.blob, { path, sign: f.sign, vfs });
  return { vfs, path, doc };
}
const items = async (vfs, path) => (await Document.load(await vfs.read(path))).pages[0].items.length;

test('a change is written a moment later, and not before', async () => {
  const { vfs, path, doc } = await open();
  const s = new EditorSession(doc, { vfs });
  doc.addItems(doc.pages[0], [stroke(1)]);
  assert.ok(doc.modified);
  await sleep(300);
  assert.equal(await items(vfs, path), 0, 'not yet');
  await sleep(1400);
  assert.equal(await items(vfs, path), 1);
  assert.ok(!doc.modified);
  await s.close();
});

test('a write waits while something is being done on the canvas', async () => {
  const { vfs, path, doc } = await open();
  let busy = true;
  const s = new EditorSession(doc, { vfs, busy: () => busy });
  doc.addItems(doc.pages[0], [stroke(1)]);
  await sleep(1900);
  assert.equal(await items(vfs, path), 0);
  busy = false;
  await sleep(600);
  assert.equal(await items(vfs, path), 1);
  await s.close();
});

test('what a sync put in the file is folded in, not written over', async () => {
  const { vfs, path, doc } = await open();
  const s = new EditorSession(doc, { vfs });
  // another writer (a sync) adds a stroke to the file
  const f = await vfs.readFile(path);
  const other = await Document.load(f.blob, { path, sign: f.sign, vfs });
  other.addItems(other.pages[0], [stroke(50)]);
  await other.save();
  doc.addItems(doc.pages[0], [stroke(1)]);
  await s.save();
  assert.equal(await items(vfs, path), 2, 'both strokes are in the file');
  assert.equal(doc.pages[0].items.length, 2);
  await s.close();
});

test('closing writes what is left', async () => {
  const { vfs, path, doc } = await open();
  const s = new EditorSession(doc, { vfs });
  doc.addItems(doc.pages[0], [stroke(1), stroke(2)]);
  await s.close();
  assert.equal(await items(vfs, path), 2);
});

test('a write that finds the file changed in between writes nothing, then tries again', async () => {
  const { vfs, path, doc } = await open();
  const s = new EditorSession(doc, { vfs });
  const realWrite = vfs.write.bind(vfs);
  let sneaked = false;
  vfs.write = async (p, blob, o) => {
    if (!sneaked) {   // something writes the file just before ours gets in
      sneaked = true;
      const f = await vfs.readFile(path);
      const other = await Document.load(f.blob, { path, sign: f.sign, vfs });
      other.addItems(other.pages[0], [stroke(50)]);
      await realWrite(path, await Document.encode(await other.snapshot()));
    }
    return realWrite(p, blob, o);
  };
  doc.addItems(doc.pages[0], [stroke(1)]);
  await s.save();
  await sleep(700);
  assert.equal(await items(vfs, path), 2);
  await s.close();
});
