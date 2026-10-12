import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipReader, ZipWriter } from '../src/core/zip.js';
import { crc32 } from '../src/core/hash.js';

const py = (script, ...args) => execFileSync('python3', ['-I', '-c', script, ...args], { encoding: 'utf8' });

test('round trip: stored and deflated, unicode names, raw copy', async () => {
  const w = new ZipWriter();
  const big = new TextEncoder().encode('hello world '.repeat(500));
  const bin = Uint8Array.from({ length: 5000 }, (_, i) => (i * 2654435761) >>> 24);
  await w.add('document.json', big);
  await w.add('id', 'abc123', { compress: false });
  await w.add('pdf/0.pdf', new Blob([bin]), { compress: false });
  await w.add('笔记/名字.txt', '你好');
  await w.add('empty', new Uint8Array(0));
  const blob = w.finish();
  const r = await ZipReader.open(blob);
  assert.deepEqual(r.names, ['document.json', 'id', 'pdf/0.pdf', '笔记/名字.txt', 'empty']);
  assert.equal(r.entry('document.json').method, 8);
  assert.equal(r.entry('id').method, 0);
  assert.equal(r.entry('empty').size, 0);
  assert.deepEqual(await r.bytes('document.json'), big);
  assert.equal(await r.text('id'), 'abc123');
  assert.deepEqual(await r.bytes('pdf/0.pdf'), bin);
  assert.equal(await r.text('笔记/名字.txt'), '你好');
  for (const e of r.entries) assert.ok(await r.crcOk(e), e.name);
  // copy entries without recompressing
  const w2 = new ZipWriter();
  for (const e of r.entries) w2.addRaw(e.name, { method: e.method, crc: e.crc, size: e.size, raw: await r.raw(e) });
  const r2 = await ZipReader.open(w2.finish());
  assert.deepEqual(await r2.bytes('document.json'), big);
  assert.equal(r2.entry('document.json').compSize, r.entry('document.json').compSize);
});

test('Python zipfile accepts what we write', async () => {
  const w = new ZipWriter();
  await w.add('document.json', '{"a":1}'.repeat(100));
  await w.add('img/0.png', Uint8Array.from({ length: 300 }, (_, i) => i & 255), { compress: false });
  await w.add('名.txt', 'x');
  w.addDir('folder');
  const dir = mkdtempSync(join(tmpdir(), 'zt-'));
  writeFileSync(join(dir, 'a.zip'), Buffer.from(await w.finish().arrayBuffer()));
  const out = py('import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(z.testzip())\nprint(sorted(z.namelist()))', join(dir, 'a.zip'));
  assert.match(out, /^None\n/);
  assert.match(out, /名\.txt/);
});

test('we read what Python writes, including forced zip64 local headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zt-'));
  const file = join(dir, 'p.zip');
  py(`
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('document.json', '{"x": 1}' * 50)
    z.writestr(zipfile.ZipInfo('id'), 'deadbeef')
    z.writestr('名字/é.txt', 'héllo')
    with z.open(zipfile.ZipInfo('pdf/0.pdf'), 'w', force_zip64=True) as f:
        f.write(bytes(range(256)) * 20)
`, file);
  const blob = new Blob([readFileSync(file)]);
  const r = await ZipReader.open(blob);
  assert.deepEqual(r.names, ['document.json', 'id', '名字/é.txt', 'pdf/0.pdf']);
  assert.equal(await r.text('id'), 'deadbeef');
  assert.equal(await r.text('document.json'), '{"x": 1}'.repeat(50));
  assert.equal(await r.text('名字/é.txt'), 'héllo');
  const pdf = await r.bytes('pdf/0.pdf');
  assert.equal(pdf.length, 5120);
  assert.equal(crc32(pdf), r.entry('pdf/0.pdf').crc);
  for (const e of r.entries) assert.ok(await r.crcOk(e), e.name);
});
