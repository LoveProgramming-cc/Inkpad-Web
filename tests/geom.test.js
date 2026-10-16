import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../src/core/geom.js';
import { fixture, near } from './helpers.js';

const F = fixture('geom.json');
const items = F.items.map(s => ({ kind: s.kind, bbox: s.bbox, polyline: () => s.polyline, sample: () => s.sample }));

test('recognizeShape', () => {
  for (const [i, c] of F.shapes.entries()) near(g.recognizeShape(c.pts) ?? null, c.shape, 'shape ' + i);
  assert.ok(F.shapes.some(c => c.shape && c.shape[0] === 'rect'));
  assert.ok(F.shapes.some(c => c.shape && c.shape[0] === 'ellipse'));
  assert.ok(F.shapes.some(c => c.shape && c.shape[0] === 'line'));
  assert.ok(F.shapes.some(c => !c.shape));
});

test('isScribble', () => {
  for (const [i, c] of F.scribbles.entries()) assert.equal(g.isScribble(c.pts, true), c.is, 'scribble ' + i);   // loose: exactly B's rule
  assert.ok(F.scribbles.some(c => c.is) && F.scribbles.some(c => !c.is));
});

test('isScribble tells handwriting from a scratch-out by how much it turns as it travels', () => {
  const along = (/** @type {number[][]} */ p) => p.flatMap((q, i) => i === 0 ? [q] : Array.from({ length: 8 }, (_, k) => [p[i - 1][0] + (q[0] - p[i - 1][0]) * (k + 1) / 8, p[i - 1][1] + (q[1] - p[i - 1][1]) * (k + 1) / 8, 0.5]));
  // Cursive loops, a letter 15 tall every 12 to 14 across: writing, however long.
  const cursive = (/** @type {number} */ loops, /** @type {number} */ adv) => {
    const p = [];
    for (let t = 0; t <= loops * 2 * Math.PI; t += 0.15) p.push([100 + adv * t / (2 * Math.PI) - 6.75 * Math.sin(t), 100 - 7.5 * Math.cos(t), 0.5]);
    return p;
  };
  assert.equal(g.isScribble(cursive(3, 14)), false);
  assert.equal(g.isScribble(cursive(8, 12)), false);
  // Going round in one place, or to and fro over a word: scribbles.
  const circles = [];
  for (let t = 0; t <= 2.5 * 2 * Math.PI; t += 0.2) circles.push([100 + 12 * Math.cos(t) + t * 0.6, 100 + 12 * Math.sin(t), 0.5]);
  assert.equal(g.isScribble(circles), true);
  const zigzag = (/** @type {number} */ n, /** @type {number} */ w, /** @type {number} */ h) => along(Array.from({ length: n }, (_, i) => [100 + (i % 2) * w, 100 + i * h / n, 0.5]));
  assert.equal(g.isScribble(zigzag(6, 80, 20)), true);
  assert.equal(g.isScribble(zigzag(7, 120, 30)), true);
  assert.equal(g.isScribble(zigzag(13, 100, 12)), true);
  // Four passes, three reversals: enough for the loose rule (A and B), not for the strict one.
  assert.equal(g.isScribble(zigzag(5, 60, 40)), false);
  assert.equal(g.isScribble(zigzag(5, 60, 40), true), true);
});

test('scribbleTargets, lassoPick, rectPick pick the same items as B', () => {
  for (const [i, c] of F.scribble_targets.entries()) {
    assert.deepEqual(g.scribbleTargets(c.pts, items).map(it => items.indexOf(it)), c.hits, 'scribble target ' + i);
  }
  for (const [i, c] of F.lasso.entries()) {
    assert.deepEqual(g.lassoPick(c.poly, items).map(it => items.indexOf(it)), c.hits, 'lasso ' + i);
  }
  for (const [i, c] of F.rect.entries()) {
    assert.deepEqual(g.rectPick(c.box, items).map(it => items.indexOf(it)), c.hits, 'rect ' + i);
  }
  assert.ok(F.scribble_targets.some(c => c.hits.length) && F.lasso.some(c => c.hits.length));
});

test('eraseRuns', () => {
  let cut = 0;
  for (const [i, c] of F.erase.entries()) {
    const r = g.eraseRuns(c.pts, ...c.seg, c.r);
    near(r, c.out, 'erase ' + i);
    if (r) cut++;
  }
  assert.ok(cut > 5 && cut < F.erase.length);
});

test('convexHull, decimate, densify', () => {
  for (const [i, c] of F.hull.entries()) near(g.convexHull(c.pts), c.hull.map(p => [...p]), 'hull ' + i);
  for (const c of F.decimate) {
    const pts = Array.from({ length: c.n }, (_, i) => [i, 0, 0]);
    assert.deepEqual(g.decimate(pts, c.limit).map(p => p[0]), c.idx);
  }
  for (const [i, c] of F.densify.entries()) near(g.densify(c.pts, c.step), c.out, 'densify ' + i);
});

test('small helpers', () => {
  assert.deepEqual(g.union(null, [1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(g.union([0, 0, 1, 1], [2, -1, 3, 0]), [0, -1, 3, 1]);
  assert.ok(g.intersects([0, 0, 1, 1], [1, 1, 2, 2]));
  assert.ok(!g.intersects([0, 0, 1, 1], [1.1, 1, 2, 2]));
  assert.deepEqual(g.bboxOf([[1, 5], [3, 2]], 1), [0, 1, 4, 6]);
  assert.ok(g.inPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 5, 5));
  assert.ok(!g.inPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 15, 5));
  assert.ok(g.polylineHit([[0, 0], [10, 0]], 5, 1, 1.5));
  assert.ok(!g.polylineHit([[0, 0], [10, 0]], 5, 2, 1.5));
});
