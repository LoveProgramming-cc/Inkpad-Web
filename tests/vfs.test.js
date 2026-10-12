import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryVfs } from '../src/platform/vfs.js';
import { Changed, Exists, NotFound } from '../src/core/errors.js';
import { setNow } from '../src/core/clock.js';
import { basename, dirname, splitext, join, within } from '../src/core/path.js';

const b = text => new Blob([text]);
const text = async blob => new TextDecoder().decode(await blob.arrayBuffer());

test('path helpers behave like os.path', () => {
  assert.equal(dirname('a/b/c.inkpad'), 'a/b');
  assert.equal(dirname('c.inkpad'), '');
  assert.equal(basename('a/b/c.inkpad'), 'c.inkpad');
  assert.deepEqual(splitext('c.inkpad'), ['c', '.inkpad']);
  assert.deepEqual(splitext('a.b.inkpad'), ['a.b', '.inkpad']);
  assert.deepEqual(splitext('.hidden'), ['.hidden', '']);
  assert.deepEqual(splitext('noext'), ['noext', '']);
  assert.equal(join('', 'a', '', 'b'), 'a/b');
  assert.ok(within('a/b', 'a') && within('a', 'a') && within('a', '') && !within('ab', 'a'));
});

test('write, read, list, stat; folders appear by themselves', async () => {
  const v = memoryVfs();
  setNow(() => 100);
  const sign = await v.write('数学/代数/笔记.inkpad', b('hello'));
  setNow(null);
  assert.match(sign, /^\d+\/5$/);
  assert.equal(await text(await v.read('数学/代数/笔记.inkpad')), 'hello');
  assert.deepEqual((await v.list('')).map(e => [e.name, e.isDir]), [['数学', true]]);
  assert.deepEqual((await v.list('数学')).map(e => [e.name, e.isDir]), [['代数', true]]);
  const st = await v.stat('数学/代数/笔记.inkpad');
  assert.equal(st.size, 5);
  assert.equal(st.mtime, 100);
  assert.equal(st.sign, sign);
  assert.equal((await v.stat('nope')), null);
  assert.equal((await v.stat('')).isDir, true);
  await assert.rejects(v.read('nope'), NotFound);
});

test('write with expect is a compare-and-set', async () => {
  const v = memoryVfs();
  const s1 = await v.write('a.inkpad', b('1'));
  const s2 = await v.write('a.inkpad', b('22'), { expect: s1 });
  assert.notEqual(s1, s2);
  await assert.rejects(v.write('a.inkpad', b('333'), { expect: s1 }), Changed);
  assert.equal(await text(await v.read('a.inkpad')), '22');
  // the same size and time are not enough: the rev differs
  const s3 = await v.write('a.inkpad', b('22'));
  assert.notEqual(s3, s2);
  await assert.rejects(v.write('new.inkpad', b('x'), { expect: '1/1' }), Changed, 'expecting a file that is not there');
});

test('two writers racing on one sign: exactly one wins', async () => {
  const v = memoryVfs();
  const s = await v.write('a.inkpad', b('0'));
  const results = await Promise.allSettled([v.write('a.inkpad', b('A'), { expect: s }), v.write('a.inkpad', b('B'), { expect: s })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
});

test('move keeps rev and mtime; folders move with everything inside', async () => {
  const v = memoryVfs();
  setNow(() => 50);
  const sign = await v.write('x/a.inkpad', b('A'));
  await v.write('x/sub/b.inkpad', b('B'));
  setNow(() => 80);
  await v.move('x/a.inkpad', 'y/z/a2.inkpad');
  setNow(null);
  const st = await v.stat('y/z/a2.inkpad');
  assert.equal(st.sign, sign);
  assert.equal(st.mtime, 50);
  assert.equal(await v.exists('x/a.inkpad'), false);
  assert.equal((await v.stat('x')).mtime, 80, 'the folder it left is touched');
  await v.move('x', 'moved');
  assert.deepEqual((await v.walk('moved')).files.map(f => f.path), ['moved/sub/b.inkpad']);
  assert.deepEqual((await v.walk('moved')).dirs.map(f => f.path), ['moved/sub']);
  assert.equal(await v.exists('x'), false);
  await assert.rejects(v.move('moved', 'moved/sub/deeper'), /into itself/);
  await assert.rejects(v.move('nope', 'q'), NotFound);
  await v.write('t.inkpad', b('T'));
  await assert.rejects(v.move('y/z/a2.inkpad', 't.inkpad'), Exists);
  await v.move('y/z/a2.inkpad', 't.inkpad', { overwrite: true });
  assert.equal(await text(await v.read('t.inkpad')), 'A');
});

test('remove deletes files and trees; rmdir only empty folders', async () => {
  const v = memoryVfs();
  await v.write('d/a', b('1'));
  await v.write('d/e/b', b('2'));
  await v.write('keep', b('3'));
  await assert.rejects(v.rmdir('d'), /not empty/);
  await v.remove('d');
  assert.deepEqual((await v.walk('')).files.map(f => f.path), ['keep']);
  assert.deepEqual((await v.walk('')).dirs, []);
  await v.remove('d');   // already gone: fine
  await v.mkdir('p/q');
  assert.deepEqual((await v.walk('')).dirs.map(d => d.path), ['p', 'p/q']);
  await v.rmdir('p/q');
  assert.equal(await v.exists('p/q'), false);
});

test('a parent folder is touched when something is added to it', async () => {
  const v = memoryVfs();
  setNow(() => 10);
  await v.write('f/a', b('1'));
  setNow(() => 20);
  await v.write('f/a', b('2'));    // replaced, not added
  assert.equal((await v.stat('f')).mtime, 10);
  await v.write('f/b', b('3'));    // added
  assert.equal((await v.stat('f')).mtime, 20);
  setNow(null);
});

test('annotate caches an id only for the revision it was worked out from', async () => {
  const v = memoryVfs();
  await v.write('a', b('1'));
  const st = await v.stat('a');
  await v.write('a', b('2'));
  await v.annotate('a', st.rev, { id: 'stale' });
  assert.equal((await v.stat('a')).id, undefined);
  const now = await v.stat('a');
  await v.annotate('a', now.rev, { id: 'good' });
  assert.equal((await v.stat('a')).id, 'good');
  assert.equal((await v.stat('a')).sign, now.sign, 'annotating does not change the sign');
});

test('kv values and change notices', async () => {
  const v = memoryVfs();
  assert.equal(await v.kvGet('x', 7), 7);
  await v.kvSet('x', { a: [1, 2] });
  assert.deepEqual(await v.kvGet('x'), { a: [1, 2] });
  await v.kvDelete('x');
  assert.equal(await v.kvGet('x'), undefined);
  const seen = [];
  v.onChange(p => seen.push(p));
  await v.write('f/a', b('1'));
  await v.move('f/a', 'f/b');
  await v.remove('f');
  assert.deepEqual(seen, [['f/a'], ['f/a', 'f/b'], ['f']]);
});
