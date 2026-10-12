// The same cross-implementation test A runs (CompatTests.swift + tools/compat.py): this code and
// B's own gdrive.sync() sync through one folder acting as the Drive. Skipped when B or Python
// is not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryVfs } from '../src/platform/vfs.js';
import { Store } from '../src/library/store.js';
import { Document } from '../src/core/document.js';
import { COVER_COLORS, BOARD_SIZE } from '../src/core/page.js';
import { Stroke } from '../src/core/items.js';
import { sync, scan, config } from '../src/sync/sync.js';
import { DirDrive } from './dirdrive.js';
import { sampleDocument } from './helpers.js';

const here = new URL('.', import.meta.url).pathname;
const B = join(here, '..', 'ref', 'B'), COMPAT = join(here, '..', 'ref', 'A', 'tools', 'compat.py');
const ready = existsSync(B) && existsSync(COMPAT);

test('syncs with the desktop app\'s own Python code', { skip: !ready && 'ref/A or ref/B missing' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'compat-'));
  const was = config.blobMin;
  config.blobMin = 16;    // small enough for the sample's picture to travel as a file of its own, as a large PDF does
  try {
    const vfs = memoryVfs();
    const store = await Store.open(vfs);
    const cloud = join(base, 'cloud');
    const notes = '课程/笔记.inkpad';

    // Stage 1: make a library and sync it up.
    await store.newFolder('', '课程');
    const doc = sampleDocument();
    doc.store = vfs;
    doc.coverSpec = ['label', COVER_COLORS[3]];
    await doc.save(notes);
    await store.newNotebook('', { w: BOARD_SIZE[0], h: BOARD_SIZE[1], paper: 'dots', color: [1, 1, 1], board: true }, '白板');
    await store.newNotebook('', { w: 595, h: 842, paper: 'blank', color: [1, 1, 1] }, '将被删除');
    await store.toggleFavorite(notes);
    let s = await sync(vfs, new DirDrive(cloud));
    assert.equal(s.up, 3);
    writeFileSync(join(base, 'ios-items.txt'), doc.pages[0].items.map(i => i.id).join('\n'));

    // The desktop side (B's own code) syncs, reads what we wrote, edits, renames, deletes, makes one.
    const out = execFileSync('python3', ['-I', COMPAT, B, base], { encoding: 'utf8', cwd: join(here, '..') });
    assert.match(out, /desktop side ok/);

    // Stage 2: the desktop side added a stroke to the notebook, renamed the board, deleted one
    // notebook and made one of its own. Meanwhile this side writes in the notebook too.
    const mine = new Stroke('ball', [0, 0, 0], 1.2, [[300, 700, 0.5], [400, 720, 0.5]]);
    const file = await vfs.readFile(notes);
    const edit = await Document.load(file.blob, { path: notes, sign: file.sign, vfs });
    edit.addItems(edit.pages[0], [mine]);
    await edit.save();
    s = await sync(vfs, new DirDrive(cloud));
    assert.equal(s.merged, 1, 'edited on both sides: merged item by item');
    assert.equal(s.conflicts, 0);
    assert.deepEqual([...(await scan(vfs)).notebooks.keys()].sort(), ['桌面新建.inkpad', '画板.inkpad', '课程/笔记.inkpad']);
    assert.deepEqual((await store.trashed()).map(e => e.name), ['将被删除']);

    const merged = await Document.load(await vfs.read(notes));
    const ids = merged.pages[0].items.map(i => i.id);
    const original = readFileSync(join(base, 'ios-items.txt'), 'utf8').split('\n');
    const theirs = readFileSync(join(base, 'desktop-item.txt'), 'utf8').trim();
    // The desktop removed the arrow (the third item) as well.
    assert.deepEqual(new Set(ids), new Set([...original.filter((_, i) => i !== 2), mine.id, theirs]));
    const added = merged.pages[0].items.find(i => i.id === theirs);
    assert.equal(added.tool, 'brush');
    assert.equal(added.pts.length, 3);
    assert.ok(Math.abs(added.pts[1][0] - 150.5) < 0.01);
    assert.equal(merged.pages.length, 3, 'the page the desktop added');
    assert.equal(merged.pages[2].paper, 'grid');
    // the picture came back to the notebook from its file of its own
    assert.ok(merged.pages[0].items.some(i => i.kind === 'i'));

    const made = await Document.load(await vfs.read('桌面新建.inkpad'));
    assert.equal(made.pages[0].paper, 'cornell');
    assert.equal(made.pages[0].items[0].text, '来自桌面');
    assert.equal(made.pages[0].items.at(-1).shape, 'ellipse');

    await store.reloadMeta();
    assert.deepEqual(new Set((await store.favorites()).map(e => e.name)), new Set(['笔记', '桌面新建']));
    // And nothing more to do afterwards.
    const again = await sync(vfs, new DirDrive(cloud));
    assert.equal(again.up + again.down + again.merged + again.moved, 0);
  } finally { config.blobMin = was; }
});
