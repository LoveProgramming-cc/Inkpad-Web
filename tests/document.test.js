import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, merge, notebookId, setNotebookId } from '../src/core/document.js';
import { Page } from '../src/core/page.js';
import { Stroke, Shape, Text, Image, itemId } from '../src/core/items.js';
import { PdfDoc } from '../src/core/pdfdoc.js';
import { setNow } from '../src/core/clock.js';
import { ZipReader } from '../src/core/zip.js';
import { packPoints, unpackPoints } from '../src/core/pack.js';
import { fixture, near, dumpDoc } from './helpers.js';

const PNG = new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf5000000401010000d1b6f4c00000000049454e44ae426082', 'hex'));
const here = new URL('.', import.meta.url).pathname;
const fx = name => new Blob([readFileSync(join(here, 'fixtures', name))]);
const black = [0, 0, 0];

function sampleDocument() {
  const doc = new Document({ w: 595, h: 842, paper: 'grid', color: [0.976, 0.965, 0.902] });
  const page = doc.pages[0];
  const tape = new Stroke('tape', [0.96, 0.82, 0.36], 16, [[50, 300, 0.5], [200, 300, 0.5]]);
  tape.open = true;
  doc.addItems(page, [
    new Stroke('fountain', [0.1, 0.2, 0.3], 1.6, [[10, 10, 0.2], [60, 40, 0.8], [120, 30, 0.5]], 1.2), tape,
    new Shape('arrow', 20, 100, 200, 180, [1, 0, 0], 2),
    new Text(40, 400, '你好 Inkpad', 18, black, 300),
    new Text(300, 400, 'note', 13, [0.16, 0.15, 0.12], 170, [1, 0.93, 0.55]),
    new Image(100, 500, 80, 60, new Blob([PNG]))]);
  const second = page.blankLike();
  second.bookmark = true;
  second.outline = '第二页';
  doc.do({ kind: 'pages', removed: [], added: [[1, second]] });
  doc.addItems(second, [new Stroke('hl', [1, 0.88, 0.3], 14, [[5, 5, 0.5], [100, 5, 0.5]], 1.0, 1)]);
  return doc;
}

test('packed points match the desktop app (A:testPackedPointsMatchDesktop)', () => {
  const pts = [[100.123, 200.456, 0.5], [101.005, 199.995, 0.73], [50.0, -12.345, 0.0], [50000000.25, 50000000.75, 1.0], [49999990.115, 50000003.125, 0.2]];
  const packed = 'HVpkO98HWUA730+Nlw5pQAAAgLABW7rXT+PLAgCi+q6gJbrcr6Al/+kP2gMz';
  assert.equal(packPoints(pts), packed);
  near(unpackPoints(packed), [[100.123, 200.456, 0.5019607843137255], [101.0, 200.0, 0.7294117647058823], [50.0, -12.34, 0.0],
    [50000000.25, 50000000.75, 1.0], [49999990.12, 50000003.12, 0.2]]);
  assert.equal(packPoints([]), '');
  assert.deepEqual(unpackPoints(''), []);
});

test('document round trip (A:testDocumentRoundTrip)', async () => {
  const doc = sampleDocument();
  doc.coverSpec = ['band', [0.17, 0.27, 0.45]];
  const blob = await Document.encode(await doc.snapshot());
  assert.equal((await notebookId(blob)).id, doc.id);
  const back = await Document.load(blob);
  assert.equal(back.id, doc.id);
  assert.equal(back.pages.length, 2);
  assert.deepEqual(back.pages.map(p => p.id), doc.pages.map(p => p.id));
  assert.equal(back.pages[0].paper, 'grid');
  assert.equal(back.pages[0].color[1], 0.965);
  assert.deepEqual(back.pages[0].items.map(i => i.id), doc.pages[0].items.map(i => i.id));
  assert.deepEqual(back.pages[0].items.map(i => i.kind), ['s', 's', 'h', 't', 't', 'i']);
  const s = back.pages[0].items[0];
  assert.equal(s.tool, 'fountain');
  assert.equal(s.sens, 1.2);
  assert.equal(s.pts.length, 3);
  assert.ok(Math.abs(s.pts[1][0] - 60) < 0.01);
  assert.ok(back.pages[0].items[1].open);
  assert.equal(back.pages[0].items[3].text, '你好 Inkpad');
  assert.deepEqual(back.pages[0].items[4].bg, [1, 0.93, 0.55]);
  assert.deepEqual(new Uint8Array(await back.pages[0].items[5].data.arrayBuffer()), PNG);
  assert.ok(back.pages[1].bookmark);
  assert.equal(back.pages[1].outline, '第二页');
  assert.equal(back.pages[1].items[0].dash, 1);
  assert.equal(back.coverSpec[0], 'band');
  const z = await ZipReader.open(blob);
  assert.deepEqual(z.names.slice(0, 1), ['document.json']);
  assert.ok(z.has('id') && z.has('cover.png') && z.has('img/0.png'));
  assert.equal(z.entry('img/0.png').method, 0);

  const renumbered = await setNotebookId(blob, 'feedfacefeedfacefeedfacefeedface');
  assert.equal((await notebookId(renumbered)).id, 'feedfacefeedfacefeedfacefeedface');
  const again = await Document.load(renumbered);
  assert.equal(again.id, 'feedfacefeedfacefeedfacefeedface');
  assert.equal(again.pages[0].items.length, 6);
});

test('undo leaves tombstones (A:testUndoLeavesTombstones)', () => {
  const doc = new Document();
  const page = doc.pages[0];
  const a = new Stroke('ball', black, 1, [[0, 0, 0.5], [5, 5, 0.5]]);
  const b = new Stroke('ball', black, 1, [[9, 0, 0.5], [5, 5, 0.5]]);
  doc.addItems(page, [a, b]);
  doc.removeItems(page, [a]);
  assert.equal(page.items.length, 1);
  assert.ok(page.gone.has(a.id));
  doc.undo();
  assert.deepEqual(page.items.map(i => i.id), [a.id, b.id]);
  assert.ok(!page.gone.has(a.id));
  doc.undo();
  assert.equal(page.items.length, 0);
  assert.ok(page.gone.has(a.id) && page.gone.has(b.id));
  doc.redo();
  assert.equal(page.items.length, 2);
  assert.ok(doc.canUndo && doc.canRedo);
});

test('events: a pure append is "added", anything else "dirty"', () => {
  const doc = new Document();
  const page = doc.pages[0];
  const log = [];
  const stop = doc.listen((kind, ...a) => log.push(kind));
  const s1 = new Stroke('ball', black, 1, [[0, 0, 0.5], [5, 5, 0.5]]);
  doc.addItems(page, [s1]);
  doc.removeItems(page, [s1]);
  doc.undo();
  stop();
  // undoing the removal of the only item puts it back at the end: a pure append again
  assert.deepEqual(log, ['added', 'state', 'dirty', 'state', 'added', 'state']);
  assert.equal(doc.undoStack.length, 1);
});

test('undo history is capped at 300', () => {
  const doc = new Document();
  for (let i = 0; i < 320; i++) doc.addItems(doc.pages[0], [new Shape('line', 0, 0, i, i, black, 1)]);
  assert.equal(doc.undoStack.length, 300);
});

test('merge item by item (A:testMergeItemByItem)', async () => {
  const doc = sampleDocument();
  const blob = await Document.encode(await doc.snapshot());
  const mine = await Document.load(blob), theirs = await Document.load(blob);
  const arrow = mine.pages[0].items[2];
  mine.removeItems(mine.pages[0], [arrow]);
  const myNew = new Stroke('ball', black, 1, [[1, 1, 0.5], [2, 2, 0.5]]);
  mine.addItems(mine.pages[0], [myNew]);
  const tape = theirs.pages[0].items[1];
  theirs.removeItems(theirs.pages[0], [tape]);
  const theirNew = new Stroke('ball', black, 1, [[3, 3, 0.5], [4, 4, 0.5]]);
  theirs.addItems(theirs.pages[0], [theirNew]);
  const extra = theirs.pages[0].blankLike();
  theirs.do({ kind: 'pages', removed: [], added: [[1, extra]] });
  const counts = merge(mine, theirs);
  assert.equal(counts[0], 1);
  assert.equal(counts[2], 1);
  assert.equal(counts[3], 1);
  assert.deepEqual(mine.pages.map(p => p.id), [doc.pages[0].id, extra.id, doc.pages[1].id]);
  const ids = new Set(mine.pages[0].items.map(i => i.id));
  assert.ok(ids.has(myNew.id) && ids.has(theirNew.id));
  assert.ok(!ids.has(arrow.id) && !ids.has(tape.id));
  assert.equal(mine.pages[0].items.length, 6);
  assert.equal(mine.undoStack.length, 0);
});

test('the same PDF is written once, however many pages use it', async () => {
  const doc = new Document();
  const a = await PdfDoc.fromBlob(new Blob(['%PDF-1.4 same']));
  const b = await PdfDoc.fromBlob(new Blob(['%PDF-1.4 same']));      // a second copy of the same file
  const c = await PdfDoc.fromBlob(new Blob(['%PDF-1.4 other']));
  doc.pages = [new Page({ pdf: a }), new Page({ pdf: b, pdfPage: 1 }), new Page({ pdf: c })];
  const snap = await doc.snapshot();
  assert.equal(snap.pdfs.length, 2);
  assert.deepEqual(JSON.parse(snap.json).pages.map(p => p.pdf), [0, 0, 1]);
  const back = await Document.load(await Document.encode(snap));
  assert.ok(back.pages[0].pdf === back.pages[1].pdf && back.pages[0].pdf !== back.pages[2].pdf);
  assert.equal(back.pages[1].pdfPage, 1);
});

test('a picture used twice is written once', async () => {
  const doc = new Document();
  const data = new Blob([PNG]);
  doc.addItems(doc.pages[0], [new Image(0, 0, 10, 10, data), new Image(20, 0, 10, 10, data), new Image(40, 0, 10, 10, new Blob([PNG]))]);
  const snap = await doc.snapshot();
  assert.equal(snap.images.length, 2);
  const back = await Document.load(await Document.encode(snap));
  assert.equal(back.pages[0].items[0].data, back.pages[0].items[1].data);
  // identical bytes stored twice come back as one
  assert.equal(back.pages[0].items[0].data, back.pages[0].items[2].data);
});

test('pages remember when their settings and order changed (stamp)', () => {
  let t = 1000;
  setNow(() => t);
  try {
    const doc = new Document();
    doc.pages.push(new Page());
    doc.stamp();
    const p = doc.pages[0];
    assert.equal(p.mt, 1000, 'a new page is stamped at its first look');
    assert.equal(doc.orderMt, 0, 'the first look at the order only records it');
    t = 2000;
    doc.stamp();
    assert.equal(p.mt, 1000, 'nothing changed, nothing stamped');
    p.paper = 'dots';
    doc.stamp();
    assert.equal(p.mt, 2000, 'a settings change is stamped, in seconds');
    t = 3000;
    doc.pages.push(new Page());
    doc.stamp();
    assert.equal(doc.orderMt, 0, 'adding a page is not a reordering');
    doc.pages.reverse();
    doc.stamp();
    assert.equal(doc.orderMt, 3000);
  } finally { setNow(null); }
});

test('what B wrote, JS reads the same (b-sample.inkpad)', async () => {
  const expected = fixture('b-sample.json');
  const doc = await Document.load(fx('b-sample.inkpad'));
  near(await dumpDoc(doc), expected);
  assert.equal(doc.pages[2].pdf, doc.pages[3].pdf, 'the same PDF twice is one object');
  assert.equal(doc.pages[3].rot, 3);
  assert.ok(doc.pages[4].board);
  assert.equal(doc.pages[0].gone.size, 1);
});

function viaPython(blob, name) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-'));
  const file = join(dir, name);
  return blob.arrayBuffer().then(buf => {
    writeFileSync(file, Buffer.from(buf));
    return JSON.parse(execFileSync('python3', ['-I', join(here, 'dump_doc.py'), file], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  });
}

test('what JS writes, B reads the same', async () => {
  const doc = await Document.load(fx('b-sample.inkpad'));
  // a few things only JS code will do to it
  doc.addItems(doc.pages[0], [new Text(1, 2, 'extra', 12, black, 0), new Shape('ellipse', 1, 2, 30, 40, [0, 0.5, 1], 1.5)]);
  doc.pages[1].outline = '改过';
  const blob = await Document.encode(await doc.snapshot());
  const seen = await viaPython(blob, 'js.inkpad');
  const mine = await dumpDoc(doc);
  near(mine, seen);
  assert.equal(seen.pages[1].outline, '改过');
  assert.equal(seen.pages[2].pdf_sha, seen.pages[3].pdf_sha);
  assert.equal(seen.pages[0].items.length, 9);
});

test('merging gives the result B gives', async () => {
  const want = fixture('merge-result.json');
  const mine = await Document.load(fx('merge-mine.inkpad')), theirs = await Document.load(fx('merge-theirs.inkpad'));
  const counts = merge(mine, theirs);
  assert.deepEqual(counts, want.counts);
  const got = await dumpDoc(mine);
  // items keep their order; compare the way B dumped them
  near(got, want.doc);
});
