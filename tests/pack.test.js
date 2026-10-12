import test from 'node:test';
import assert from 'node:assert/strict';
import { packPoints, unpackPoints, bytesToBase64, base64ToBytes } from '../src/core/pack.js';
import { fixture, near } from './helpers.js';

test('packPoints is identical to B and unpackPoints reads what B wrote', () => {
  for (const [i, c] of fixture('pack.json').entries()) {
    assert.equal(packPoints(c.pts), c.q, 'case ' + i);
    near(unpackPoints(c.q), c.back, 'case ' + i);
  }
});

test('whiteboard coordinates survive the trip to hundredths', () => {
  const pts = [[5e7, 5e7, 0.5], [5e7 + 0.37, 5e7 - 12.55, 0.6]];
  const back = unpackPoints(packPoints(pts));
  assert.equal(back[0][0], 5e7);
  assert.ok(Math.abs(back[1][0] - (5e7 + 0.37)) < 0.006);
  assert.ok(Math.abs(back[1][1] - (5e7 - 12.55)) < 0.006);
});

test('base64 matches node for every length', () => {
  for (let n = 0; n < 40; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.equal(bytesToBase64(b), Buffer.from(b).toString('base64'));
    assert.deepEqual(base64ToBytes(Buffer.from(b).toString('base64')), b);
  }
  const big = Uint8Array.from({ length: 100000 }, (_, i) => (i * 7) & 255);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'));
});
