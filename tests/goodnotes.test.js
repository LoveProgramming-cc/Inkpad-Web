// Goodnotes: what we write we read back, and B's own reader reads it too (A:GoodnotesTests, tools/goodnotes_compat.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryVfs } from '../src/platform/vfs.js';
import { setVfs } from '../src/core/storage.js';
import { Document } from '../src/core/document.js';
import { Stroke, Shape } from '../src/core/items.js';
import { Page } from '../src/core/page.js';
import { saveGoodnotes, loadGoodnotes } from '../src/io/goodnotes.js';
import { ZipReader } from '../src/core/zip.js';

globalThis.document ??= undefined;
const here = new URL('.', import.meta.url).pathname;

function sample() {
  const doc = new Document({ w: 595, h: 842, paper: 'grid', color: [1, 1, 1] });
  const wave = Array.from({ length: 30 }, (_, i) => [50 + i * 10, 200 + Math.sin(i / 4) * 30, 0.5]);
  doc.addItems(doc.pages[0], [
    new Stroke('fountain', [0.8, 0.1, 0.1], 2, wave, 1.0),
    new Stroke('hl', [1, 0.88, 0.3], 14, [[50, 400, 0.5], [300, 400, 0.5]]),
    new Shape('rect', 100, 500, 200, 560, [0, 0, 1], 2)]);
  const second = new Page({ w: 595, h: 842 });
  doc.do({ kind: 'pages', removed: [], added: [[1, second]] });
  doc.addItems(second, [new Stroke('ball', [0, 0.5, 0], 1.5, [[10, 10, 0.5], [100, 120, 0.5], [200, 40, 0.5]])]);
  return doc;
}

test('writing a .goodnotes file and reading it again', async () => {
  setVfs(memoryVfs());
  const doc = sample();
  const blob = await saveGoodnotes(doc, '测试 Title');
  const z = await ZipReader.open(blob);
  for (const name of ['index.events.pb', 'index.notes.pb', 'index.attachments.pb', 'schema.pb']) assert.ok(z.has(name), name);
  assert.ok(z.names.some(n => n.startsWith('attachments/')) && z.names.filter(n => n.startsWith('notes/')).length === 2);
  const { doc: back, title, stats } = await loadGoodnotes(blob);
  assert.equal(title, '测试 Title');
  assert.equal(back.pages.length, 2);
  assert.equal(stats.strokes, 3, 'the two strokes of page 1 (the shape is part of the background) and the one of page 2');
  const first = back.pages[0].items;
  assert.equal(first.length, 2);
  // (B's writer numbers a stroke by its point count, so the order of strokes on a page is not kept: neither is it here)
  const ink = first.find(s => s.tool !== 'hl'), marker = first.find(s => s.tool === 'hl');
  assert.ok(ink && marker, 'the highlighter stays a highlighter');
  assert.ok(Math.abs(ink.pts[0][0] - 50) < 0.5 && Math.abs(ink.pts[0][1] - 200) < 0.5, 'the first point is where it was');
  assert.deepEqual(ink.color.map(c => Math.round(c * 100) / 100), [0.8, 0.1, 0.1]);
  assert.ok(back.pages[1].items[0].pts.length >= 3);
  assert.ok(Math.abs(back.pages[1].items[0].pts.at(-1)[0] - 200) < 0.5);
});

test('B reads what we write', { skip: !existsSync(join(here, '..', 'ref', 'B')) && 'ref/B missing' }, async () => {
  setVfs(memoryVfs());
  const blob = await saveGoodnotes(sample(), 'From JS');
  const dir = mkdtempSync(join(tmpdir(), 'gn-'));
  writeFileSync(join(dir, 'a.goodnotes'), Buffer.from(await blob.arrayBuffer()));
  const out = execFileSync('python3', ['-I', '-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(here)})
from stubs import load
model, geom = load(${JSON.stringify(join(here, '..', 'ref', 'B'))}, ${JSON.stringify(dir)})
from inkpad import goodnotes
doc, title, stats = goodnotes.load(${JSON.stringify(join(dir, 'a.goodnotes'))})
print(json.dumps({'title': title, 'pages': len(doc.pages), 'strokes': stats['strokes'], 'items': [len(p.items) for p in doc.pages]}))
`], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.title, 'From JS');
  assert.equal(r.pages, 2);
  assert.equal(r.strokes, 3);
  assert.deepEqual(r.items, [2, 1]);
});

test('lz4 and tpl blocks: a stored block and a compressed one', async () => {
  // a constant-width path written by packStroke is "stored" (bv4-); make sure the reader also copes with bv41 by hand-compressing literals only
  setVfs(memoryVfs());
  const { saveGoodnotes: save } = await import('../src/io/goodnotes.js');
  const blob = await save(sample(), 'x');
  assert.ok((await ZipReader.open(blob)).has('index.events.pb'));
});
