import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { Md5, Sha256, Crc32, crc32, md5Hex, sha256Hex, md5Blob, sha256Blob, crc32Blob } from '../src/core/hash.js';

test('known vectors', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('matches node for many lengths, fed whole and in pieces', () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70001]) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = (i * 31 + 7) & 255;
    const buf = Buffer.from(data);
    assert.equal(new Md5().update(data).hex(), createHash('md5').update(buf).digest('hex'), 'md5 ' + n);
    assert.equal(new Sha256().update(data).hex(), createHash('sha256').update(buf).digest('hex'), 'sha ' + n);
    assert.equal(new Crc32().update(data).digest(), zlib.crc32(buf), 'crc ' + n);
    const m = new Md5(), s = new Sha256(), c = new Crc32();
    for (let i = 0; i < n; i += 37) {
      const piece = data.subarray(i, Math.min(n, i + 37));
      m.update(piece); s.update(piece); c.update(piece);
    }
    assert.equal(m.hex(), createHash('md5').update(buf).digest('hex'));
    assert.equal(s.hex(), createHash('sha256').update(buf).digest('hex'));
    assert.equal(c.digest(), zlib.crc32(buf));
  }
});

test('crc32 can continue from a previous value', () => {
  const a = new TextEncoder().encode('hello '), b = new TextEncoder().encode('world');
  assert.equal(crc32(b, crc32(a)), zlib.crc32(Buffer.from('hello world')));
});

test('blobs', async () => {
  const data = new Uint8Array(300000).map((_, i) => (i * 13) & 255);
  const blob = new Blob([data.subarray(0, 100000), data.subarray(100000)]);
  assert.equal(await md5Blob(blob), createHash('md5').update(data).digest('hex'));
  assert.equal(await sha256Blob(blob), createHash('sha256').update(data).digest('hex'));
  assert.equal(await crc32Blob(blob), zlib.crc32(data));
});
