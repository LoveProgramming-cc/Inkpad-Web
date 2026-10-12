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
  for (const [i, c] of F.scribbles.entries()) assert.equal(g.isScribble(c.pts), c.is, 'scribble ' + i);
  assert.ok(F.scribbles.some(c => c.is) && F.scribbles.some(c => !c.is));
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
