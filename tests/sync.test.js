// A:InkpadTests/SyncTests.swift, test by test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryVfs } from '../src/platform/vfs.js';
import { Store } from '../src/library/store.js';
import { Document, merge } from '../src/core/document.js';
import { Page } from '../src/core/page.js';
import { Stroke } from '../src/core/items.js';
import { ZipReader } from '../src/core/zip.js';
import { notebookIdOf } from '../src/core/notebook.js';
import { Changed } from '../src/core/errors.js';
import { sync, scan, cloudDeleted, cloudRestore, cloudFolderOf, parseFolder, emptySummary, config, DriveError, INDEX_NAME } from '../src/sync/sync.js';
import { stripped } from '../src/sync/blobs.js';
import { Cloud, FakeDrive, Wrapped } from './fakedrive.js';
import { sampleDocument } from './helpers.js';

const tpl = { w: 595, h: 842, paper: 'blank', color: [1, 1, 1] };
const black = [0, 0, 0];

async function device() {
  const vfs = memoryVfs();
  return { vfs, store: await Store.open(vfs) };
}
const books = async dev => [...(await scan(dev.vfs)).notebooks.keys()].sort();
const text = async blob => new TextDecoder().decode(await blob.arrayBuffer());
const load = async (dev, path) => {
  const f = await dev.vfs.readFile(path);
  return Document.load(f.blob, { path, sign: f.sign, vfs: dev.vfs });
};
const shape = async (dev, path) => (await load(dev, path)).pages.map(p => p.items.length);
async function addStroke(dev, path, x) {
  const doc = await load(dev, path);
  const stroke = new Stroke('ball', black, 1, [[x, 0, 0.5], [x, 50, 0.5]]);
  doc.addItems(doc.pages[0], [stroke]);
  await doc.save();
  return stroke.id;
}
const syncOf = (dev, cloud, opts) => sync(dev.vfs, new FakeDrive(cloud), opts);
const index = async cloud => JSON.parse(await cloud.named(INDEX_NAME)[0][1].data.text());

async function saveSample(dev, path) {
  const doc = sampleDocument();
  doc.store = dev.vfs;
  await doc.save(path);
}

test('two devices (A:testTwoDevices)', async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const folder = await a.store.newFolder('', '课程');
  const note = await a.store.newNotebook(folder, tpl, '数学');
  await a.store.newFolder('', '空文件夹');

  let s = await syncOf(a, cloud);
  assert.equal(s.up, 1);
  s = await syncOf(b, cloud);
  assert.equal(s.down, 1);
  assert.deepEqual(await books(b), ['课程/数学.inkpad']);
  assert.ok(await b.vfs.exists('空文件夹'));
  // Nothing to do when nothing changed.
  assert.deepEqual(await syncOf(a, cloud), emptySummary());
  assert.deepEqual(await syncOf(b, cloud), emptySummary());

  // An edit on one side travels to the other.
  const noteB = '课程/数学.inkpad';
  const first = await addStroke(b, noteB, 10);
  s = await syncOf(b, cloud);
  assert.equal(s.up, 1);
  s = await syncOf(a, cloud);
  assert.equal(s.down, 1);
  assert.deepEqual((await load(a, note)).pages[0].items.map(i => i.id), [first]);

  // Edits on both sides are merged item by item.
  const mine = await addStroke(a, note, 20), theirs = await addStroke(b, noteB, 30);
  s = await syncOf(a, cloud);
  assert.equal(s.up, 1);
  s = await syncOf(b, cloud);
  assert.equal(s.merged, 1);
  assert.equal(s.conflicts, 0);
  assert.deepEqual(new Set((await load(b, noteB)).pages[0].items.map(i => i.id)), new Set([first, mine, theirs]));
  s = await syncOf(a, cloud);
  assert.equal(s.down, 1);
  assert.deepEqual(new Set((await load(a, note)).pages[0].items.map(i => i.id)), new Set([first, mine, theirs]));
  assert.deepEqual(await books(a), ['课程/数学.inkpad']);

  // A rename is a changed path on the same id, not a new notebook.
  await b.store.rename(noteB, '高等数学');
  s = await syncOf(b, cloud);
  assert.equal(s.moved, 1);
  assert.equal(s.up, 0);
  s = await syncOf(a, cloud);
  assert.equal(s.moved, 1);
  assert.deepEqual(await books(a), ['课程/高等数学.inkpad']);

  // A deletion reaches the other device as a move to its trash.
  await a.store.trash('课程/高等数学.inkpad');
  await syncOf(a, cloud);
  await syncOf(b, cloud);
  assert.deepEqual(await books(b), []);
  assert.deepEqual((await b.store.trashed()).map(e => e.name), ['高等数学']);

  // Restoring it brings it back on both (to the top level: this device never knew its folder).
  await b.store.restore((await b.store.trashed())[0].path);
  await syncOf(b, cloud);
  await syncOf(a, cloud);
  assert.deepEqual(await books(a), ['高等数学.inkpad']);
  assert.equal((await a.store.trashed()).length, 0);

  // A removed empty folder goes away on the other side as well.
  await a.vfs.remove('空文件夹');
  await syncOf(a, cloud);
  await syncOf(b, cloud);
  assert.equal(await b.vfs.exists('空文件夹'), false);

  // Favourites travel with the newer library metadata.
  await a.store.toggleFavorite('高等数学.inkpad');
  await syncOf(a, cloud);
  s = await syncOf(b, cloud);
  assert.ok(s.meta);
  await b.store.reloadMeta();
  assert.deepEqual((await b.store.favorites()).map(e => e.name), ['高等数学']);
});

test('archive and cloud restore (A:testArchiveAndCloudRestore)', async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const folder = await a.store.newFolder('', '课程');
  await a.store.setFolderStyle(folder, { color: [0.98, 0.82, 0.38], icon: 'book' });
  await a.store.newNotebook(folder, tpl, '数学');
  const loose = await a.store.newNotebook('', tpl, '散页');
  await a.store.newFolder(folder, '空');

  // The whole library into one zip, and out again somewhere else.
  const { blob, count } = await a.store.exportArchive('');
  assert.equal(count, 2);
  assert.equal(await b.store.importArchive(blob, ''), 2);
  assert.deepEqual(await books(b), ['散页.inkpad', '课程/数学.inkpad']);
  assert.ok(await b.vfs.exists('课程/空'));
  assert.equal(b.store.folderStyle('课程').icon, 'book');
  assert.equal(await b.store.importArchive(blob, ''), 2, 'importing again never overwrites');
  assert.equal((await books(b)).length, 4);

  // Deleted for good here, the file stays on Drive and can be fetched back.
  await syncOf(a, cloud);
  const id = await notebookIdOf(a.vfs, loose);
  await a.store.trash(loose);
  await a.store.delete((await a.store.trashed())[0].path);
  assert.deepEqual((await a.store.archived()).map(e => e.name.replace(/^\d{8}-\d{6} /, '')), ['散页']);
  await syncOf(a, cloud);
  const gone = await cloudDeleted(a.vfs, new FakeDrive(cloud));
  assert.deepEqual(gone.map(g => g.id), [id]);
  assert.equal(gone[0].path, '散页.inkpad');
  const n = await cloudRestore(a.vfs, new FakeDrive(cloud), [id]);
  assert.equal(n, 1);
  assert.deepEqual(await books(a), ['散页.inkpad', '课程/数学.inkpad']);
  assert.deepEqual(await cloudDeleted(a.vfs, new FakeDrive(cloud)), []);
  const s = await syncOf(a, cloud);
  assert.equal(s.up + s.down + s.removed, 0, 'restored on both sides: nothing left to do');

  // And the copy kept on the device comes back to where it was.
  await a.store.unarchive((await a.store.archived())[0].path);
  assert.deepEqual(await books(a), ['散页 2.inkpad', '散页.inkpad', '课程/数学.inkpad']);
});

test("a notebook's file deleted on Drive itself is sent again (A:testFileGoneFromDriveIsSentAgain)", async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const note = await a.store.newNotebook('', tpl, '数学');
  await syncOf(a, cloud);
  await syncOf(b, cloud);
  const idx = await index(cloud);
  const nid = await notebookIdOf(a.vfs, note);
  cloud.files.delete(idx.items[nid].file);

  // A quick sync goes by the index and does not look; a thorough one finds out.
  assert.deepEqual(await syncOf(b, cloud), emptySummary());
  const s = await syncOf(b, cloud, { thorough: true });
  assert.equal(s.up, 1);
  assert.equal(s.removed, 0, 'not taken for a deletion');
  assert.deepEqual(await books(b), ['数学.inkpad']);
  const s2 = await syncOf(a, cloud);
  assert.equal(s2.up + s2.removed, 0);
  assert.deepEqual(await books(a), ['数学.inkpad']);
});

test('a sync that is cut off has written down how far it got (A:testCheckpoint)', async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  for (const name of ['一', '二', '三']) await a.store.newNotebook('', tpl, name);
  const was = config.checkpoint;
  config.checkpoint = 0;
  try {
    const inner = new FakeDrive(cloud);
    const failing = new Wrapped(inner);
    failing.before = async m => { if (m === 'upload' && inner.uploads === 2) throw new DriveError('the connection dropped'); };
    await assert.rejects(sync(a.vfs, failing), /connection dropped/);
  } finally { config.checkpoint = was; }
  const idx = await index(cloud);
  assert.equal(Object.keys(idx.items).length, 2, 'the two that went up are in the index already');
  const other = await syncOf(b, cloud);
  assert.equal(other.down, 2);
  const rest = new FakeDrive(cloud);
  const s = await sync(a.vfs, rest);
  assert.equal(rest.uploads, 1, 'only what was left');
  assert.equal(s.up, 1);
});

test('changing the folder starts the comparison from nothing (A:testChangingTheFolder)', async () => {
  const cloud = new Cloud();
  const a = await device();
  await a.store.newNotebook('', tpl, '数学');
  await syncOf(a, cloud);
  assert.equal(await cloudFolderOf(a.vfs), 'root');
  const s = await syncOf(a, cloud, { folder: 'folder2' });
  assert.equal(await cloudFolderOf(a.vfs), 'folder2');
  assert.equal(s.removed, 0);
  assert.deepEqual(await books(a), ['数学.inkpad']);
  await assert.rejects(syncOf(a, cloud, { folder: 'missing' }), DriveError, 'a folder that is not there cannot be synced with');
  assert.deepEqual(await books(a), ['数学.inkpad']);

  assert.equal(parseFolder(' https://drive.google.com/drive/folders/1AbC-d_9?usp=sharing '), '1AbC-d_9');
  assert.equal(parseFolder('https://drive.google.com/open?id=xyz123&x=1'), 'xyz123');
  assert.equal(parseFolder('1AbC'), '1AbC');
  assert.equal(parseFolder(''), '');
  assert.throws(() => parseFolder('my folder!'), DriveError);
});

test('moves can be undone (A:testMovesCanBeUndone)', async () => {
  const a = await device();
  const folder = await a.store.newFolder('', '课程');
  const inner = await a.store.newFolder(folder, '作业');
  const note = await a.store.newNotebook('', tpl, '数学');
  await assert.rejects(a.store.move(folder, inner), 'a folder cannot go inside itself');
  await a.store.newNotebook(folder, tpl, '数学');
  const moved = await a.store.move(note, folder);
  assert.equal(moved, '课程/数学 2.inkpad');
  const back = await a.store.move(moved, '', '数学.inkpad');   // taken back, it has the name it had
  assert.equal(back, note);
  assert.deepEqual(await a.store.folders(), ['', '课程', '课程/作业']);
});

test('a copy gets its own id (A:testCopyGetsItsOwnID)', async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const note = await a.store.newNotebook('', tpl, '原件');
  await syncOf(a, cloud);
  await a.vfs.write('拷贝.inkpad', await a.vfs.read(note));    // a copy made outside the app
  const s = await syncOf(a, cloud);
  assert.equal(s.up, 1);
  assert.notEqual(await notebookIdOf(a.vfs, note), await notebookIdOf(a.vfs, '拷贝.inkpad'));
  await syncOf(b, cloud);
  assert.deepEqual(await books(b), ['原件.inkpad', '拷贝.inkpad']);
});

async function addPage(dev, path, x) {
  const doc = await load(dev, path);
  const page = new Page();
  doc.do({ kind: 'pages', removed: [], added: [[doc.pages.length, page]] });
  doc.addItems(page, [new Stroke('ball', black, 1, [[x, 0, 0.5], [x, 50, 0.5]])]);
  doc.addItems(doc.pages[0], [new Stroke('ball', black, 1, [[x + 1, 0, 0.5], [x + 1, 50, 0.5]])]);
  await doc.save();
}

test('overlapping syncs lose nothing (A:testOverlappingSyncsLoseNothing)', async () => {
  for (const moment of ['index', 'md5']) {
    const cloud = new Cloud();
    const a = await device(), b = await device();
    const mine = await a.store.newNotebook('', tpl, '同一本');
    await sync(a.vfs, new FakeDrive(cloud));
    await sync(b.vfs, new FakeDrive(cloud));
    const theirs = '同一本.inkpad';
    await addPage(a, mine, 10);
    await addPage(b, theirs, 20);

    const slow = new FakeDrive(cloud);
    const other = async () => { await sync(b.vfs, new FakeDrive(cloud)); };
    if (moment === 'index') slow.afterIndex = other; else slow.afterMD5 = other;
    await sync(a.vfs, slow);
    for (let i = 0; i < 3; i++) {
      await sync(a.vfs, new FakeDrive(cloud));
      await sync(b.vfs, new FakeDrive(cloud));
    }
    assert.deepEqual(await shape(a, mine), [2, 1, 1], moment);
    assert.deepEqual(await shape(b, theirs), [2, 1, 1], moment);
    assert.deepEqual(await sync(a.vfs, new FakeDrive(cloud)), emptySummary(), moment);
  }
});

test('the editor never writes over what a sync put in the file (A:testSaveAfterTheFileChanged)', async () => {
  const a = await device();
  const note = await a.store.newNotebook('', tpl, '打开着');
  const open = await load(a, note);
  const sign = open.sign;
  await addStroke(a, note, 5);   // what a sync brings
  assert.notEqual((await a.vfs.stat(note)).sign, sign);
  open.addItems(open.pages[0], [new Stroke('ball', black, 1, [[9, 0, 0.5], [9, 50, 0.5]])]);
  await assert.rejects(a.vfs.write(note, await Document.encode(await open.snapshot()), { expect: sign }), Changed);
  merge(open, await load(a, note));
  await a.vfs.write(note, await Document.encode(await open.snapshot()), { expect: (await a.vfs.stat(note)).sign });
  assert.deepEqual(await shape(a, note), [2]);
  // ...and Document.save, without being told what to expect, folds the other version in by itself
  const again = await load(a, note);
  await addStroke(a, note, 6);
  again.addItems(again.pages[0], [new Stroke('ball', black, 1, [[8, 0, 0.5], [8, 50, 0.5]])]);
  await again.save();
  assert.deepEqual(await shape(a, note), [4]);
});

test('the open notebook is synced by itself (A:testSyncOfOneNotebook)', async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const note = await a.store.newNotebook('', tpl, '打开着');
  const other = await a.store.newNotebook('', tpl, '别的');
  await syncOf(a, cloud);
  await syncOf(b, cloud);
  const theirs = '打开着.inkpad';
  await addStroke(a, note, 1);
  await addStroke(a, other, 2);
  await addStroke(b, theirs, 3);

  let s = await syncOf(a, cloud, { only: [note] });
  assert.equal(s.up, 1);
  s = await syncOf(b, cloud, { only: [theirs] });
  assert.equal(s.merged, 1);
  assert.deepEqual(await shape(b, theirs), [2]);
  assert.deepEqual(await shape(b, '别的.inkpad'), [0]);
  s = await syncOf(a, cloud, { only: [note] });
  assert.deepEqual(await shape(a, note), [2]);
  const before = await cloud.named(INDEX_NAME)[0][1].data.text();
  s = await syncOf(a, cloud, { only: [note] });
  assert.deepEqual(s, emptySummary());
  assert.equal(await cloud.named(INDEX_NAME)[0][1].data.text(), before);
  // The rest goes with the next sync of the whole library.
  s = await syncOf(a, cloud);
  assert.equal(s.up, 1);
  s = await syncOf(b, cloud);
  assert.deepEqual(await shape(b, '别的.inkpad'), [1]);
});

test('large parts are uploaded once (A:testLargePartsAreUploadedOnce)', async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const was = config.blobMin;
  config.blobMin = 16;
  try {
    await saveSample(a, '带图.inkpad');
    await saveSample(a, '同一张图.inkpad');
    const picture = await (await ZipReader.open(await a.vfs.read('带图.inkpad'))).bytes('img/0.png');
    await syncOf(a, cloud);
    const blobs = cloud.startingWith('blob-');
    assert.equal(blobs.length, 1, 'the same picture in two notebooks is one file');
    assert.deepEqual(new Uint8Array(await blobs[0][1].data.arrayBuffer()), picture);
    const uploaded = cloud.named('带图.inkpad')[0][1].data;
    assert.equal((await ZipReader.open(uploaded)).has('img/0.png'), false);

    await syncOf(b, cloud);
    const theirs = '带图.inkpad';
    assert.deepEqual(await (await ZipReader.open(await b.vfs.read(theirs))).bytes('img/0.png'), picture);
    assert.equal((await load(b, theirs)).pages[0].items.length, (await load(a, '带图.inkpad')).pages[0].items.length);

    // Writing on both sides: merged, and the picture is neither sent nor fetched again.
    const count = cloud.files.size;
    await addStroke(a, '带图.inkpad', 500);
    await addStroke(b, theirs, 510);
    const driveA = new FakeDrive(cloud), driveB = new FakeDrive(cloud);
    await sync(a.vfs, driveA);
    const s = await sync(b.vfs, driveB);
    assert.equal(s.merged, 1);
    await sync(a.vfs, driveA);
    assert.equal(cloud.files.size, count);
    assert.equal(driveA.uploads + driveB.uploads, 2);
    assert.equal(driveA.downloads + driveB.downloads, 2);
    assert.deepEqual(await (await ZipReader.open(await a.vfs.read('带图.inkpad'))).bytes('img/0.png'), picture);
    assert.equal((await load(a, '带图.inkpad')).pages[0].items.length, (await load(b, theirs)).pages[0].items.length);
    assert.deepEqual(await syncOf(a, cloud), emptySummary());
  } finally { config.blobMin = was; }
});

test('order, paper and PDFs survive a merge (A:testOrderPaperAndPDFsSurviveAMerge)', async () => {
  const { PdfDoc } = await import('../src/core/pdfdoc.js');
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const pdf = await PdfDoc.fromBlob(new Blob(['%PDF-1.4 a textbook, or a page of one']));
  const note = '课本.inkpad';
  const made = new Document();
  made.store = a.vfs;
  made.pages = [new Page({ w: 300, h: 400, pdf, pdfPage: 0 })];
  made.do({ kind: 'pages', removed: [], added: [[1, new Page()], [2, new Page()]] });
  await made.save(note);
  await syncOf(a, cloud);
  await syncOf(b, cloud);
  const theirs = note;

  const doc = await load(a, note);
  const ids = doc.pages.map(p => p.id);
  const first = doc.pages[0];
  doc.do({ kind: 'pages', removed: [[0, first]], added: [[2, first]] });
  doc.do({ kind: 'template', page: doc.pages[0], old: doc.pages[0].template(), new: { w: 595, h: 842, paper: 'grid', color: [1, 1, 1] } });
  doc.do({ kind: 'pages', removed: [], added: [[3, new Page({ w: 300, h: 400, pdf, pdfPage: 1 })]] });
  await doc.save();
  assert.deepEqual((await ZipReader.open(await a.vfs.read(note))).names.filter(n => n.startsWith('pdf/')), ['pdf/0.pdf'], 'the same PDF is kept once');
  await addStroke(b, theirs, 77);   // on the PDF page, which is first over there

  await syncOf(a, cloud);
  const s = await syncOf(b, cloud);
  assert.equal(s.merged, 1);
  await syncOf(a, cloud);
  for (const [dev, path] of [[a, note], [b, theirs]]) {
    const now = await load(dev, path);
    assert.deepEqual(now.pages.map(p => p.id).slice(0, 3), [ids[1], ids[2], ids[0]], path);
    assert.equal(now.pages.length, 4);
    assert.equal(now.pages[0].paper, 'grid');
    assert.equal(now.pages[2].items.length, 1, 'what was written while the page was being moved');
    assert.ok(now.pages[2].pdf);
    assert.ok(now.pages[2].pdf === now.pages[3].pdf);
  }
});

test('a notebook without its pictures is mended (A:testNotebookWithoutItsPicturesIsMended)', async () => {
  const cloud = new Cloud();
  const a = await device(), b = await device();
  const was = config.blobMin;
  config.blobMin = 16;
  try {
    await saveSample(a, '带图.inkpad');
    const picture = await (await ZipReader.open(await a.vfs.read('带图.inkpad'))).bytes('img/0.png');
    await syncOf(a, cloud);
    await syncOf(b, cloud);
    const theirs = '带图.inkpad';
    // What is on Drive for it is the notebook without the picture; put that in its place.
    const uploaded = cloud.named('带图.inkpad')[0][1].data;
    await b.vfs.write(theirs, uploaded);
    assert.ok(await stripped(await b.vfs.read(theirs)));

    const s = await syncOf(b, cloud);
    assert.equal(s.mended, 1);
    assert.ok(!(await stripped(await b.vfs.read(theirs))));
    assert.deepEqual(await (await ZipReader.open(await b.vfs.read(theirs))).bytes('img/0.png'), picture);
    assert.ok(!(await stripped(await a.vfs.read('带图.inkpad'))));
    const cloudNow = cloud.named('带图.inkpad')[0][1].data;

    // With the picture gone from the cloud too it cannot be mended: it is left alone, the sync
    // says so, and what is in the cloud is not replaced by it.
    await b.vfs.write(theirs, cloudNow);
    for (const [id] of cloud.startingWith('blob-')) cloud.files.delete(id);
    await assert.rejects(syncOf(b, cloud, { thorough: true }), e => e instanceof DriveError && e.message.includes('带图'));
    assert.equal(cloud.named('带图.inkpad')[0][1].data, cloudNow);
    // The device that has it whole (and sent it) puts the picture back when it next looks at
    // Drive, and then the other is mended.
    await syncOf(a, cloud);
    await syncOf(a, cloud, { thorough: true });
    assert.equal(cloud.startingWith('blob-sha256-').length, 1);
    const again = await syncOf(b, cloud);
    assert.equal(again.mended, 1);
    assert.deepEqual(await (await ZipReader.open(await b.vfs.read(theirs))).bytes('img/0.png'), picture);
  } finally { config.blobMin = was; }
});

test('a quick sync with nothing to do reads the index and no more (A:testQuickSyncIsOneRequest)', async () => {
  const cloud = new Cloud();
  const a = await device();
  const note = await a.store.newNotebook('', tpl, '一');
  await a.store.newNotebook('', tpl, '二');
  await syncOf(a, cloud);
  let drive = new Wrapped(new FakeDrive(cloud));
  let s = await sync(a.vfs, drive);
  assert.deepEqual(s, emptySummary());
  assert.deepEqual(drive.calls, ['getJSON']);
  // Writing in one sends that one: the index is read, the notebook uploaded, the index read again and written.
  await addStroke(a, note, 1);
  drive = new Wrapped(new FakeDrive(cloud));
  s = await sync(a.vfs, drive);
  assert.equal(s.up, 1);
  assert.deepEqual(drive.calls, ['getJSON', 'upload', 'getJSON', 'putJSON']);
  drive = new Wrapped(new FakeDrive(cloud));
  await sync(a.vfs, drive, { thorough: true });
  assert.deepEqual(drive.calls, ['alive', 'children', 'getJSON']);
});

test('a skipped notebook is left alone (A:testSkippedNotebookIsLeftAlone)', async () => {
  const cloud = new Cloud();
  const a = await device();
  const note = await a.store.newNotebook('', tpl, '编辑中');
  const s = await syncOf(a, cloud, { skip: [note] });
  assert.equal(s.up, 0);
  const again = await syncOf(a, cloud);
  assert.equal(again.up, 1);
});
