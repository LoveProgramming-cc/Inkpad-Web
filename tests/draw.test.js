// What reaches the canvas context when things are drawn, without a canvas: the origin is
// subtracted in doubles before anything is handed over (PORTING.md R3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawStroke, drawShape, drawText, drawPaper, drawImage } from '../src/core/draw.js';
import { Stroke, Shape, Text, Image } from '../src/core/items.js';
import { Page } from '../src/core/page.js';
import { renderPage } from '../src/core/render.js';
import { css, parseCss } from '../src/core/color.js';
import * as ptext from '../src/core/ptext.js';

/** A context that remembers the numbers it was given. */
function recorder() {
  const calls = [];
  const state = {};
  const ctx = new Proxy({}, {
    get(_, name) {
      if (name in state) return state[name];
      return (...args) => { calls.push([name, ...args]); };
    },
    set(_, name, value) { state[name] = value; calls.push(['set ' + String(name), value]); return true; },
  });
  return { ctx, calls, state };
}
const numbers = calls => calls.filter(c => !String(c[0]).startsWith('set ')).flatMap(c => c.slice(1)).filter(v => typeof v === 'number');

test('colours round trip through css strings', () => {
  assert.equal(css([1, 0.5, 0], 0.4), 'rgba(255.00,127.50,0.00,0.4)');
  const c = parseCss(css([0.976, 0.965, 0.902], 0.25));
  assert.ok(Math.abs(c[0] - 0.976) < 1e-3 && c[3] === 0.25);
});

test('a stroke 5e7 away from the origin reaches the context as small numbers', () => {
  const pts = Array.from({ length: 40 }, (_, i) => [5e7 + i * 3.1, 5e7 - i * 1.7, (i % 5) / 5]);
  for (const tool of ['fountain', 'brush', 'ball', 'hl', 'tape']) {
    const s = new Stroke(tool, [0, 0, 0], 2, pts, 1, 0);
    const { ctx, calls } = recorder();
    drawStroke(ctx, { ox: 5e7 - 100, oy: 5e7 - 200, perPixel: 0.5 }, s);
    const n = numbers(calls);
    assert.ok(n.length > 40, tool);
    assert.ok(n.every(v => Math.abs(v) < 1000), tool + ': ' + n.filter(v => Math.abs(v) >= 1000).slice(0, 3));
  }
});

test('far away, a stroke is simplified; printing never simplifies', () => {
  const pts = Array.from({ length: 200 }, (_, i) => [i * 0.1, i * 0.05, 0.5]);
  const s = new Stroke('fountain', [0, 0, 0], 1, pts);
  const far = recorder(), near = recorder(), pdf = recorder();
  drawStroke(far.ctx, { ox: 0, oy: 0, perPixel: 3 }, s);
  drawStroke(near.ctx, { ox: 0, oy: 0, perPixel: 1 }, s);
  drawStroke(pdf.ctx, { ox: 0, oy: 0, perPixel: 3, printing: true }, s);
  assert.ok(far.calls.length < 60);
  assert.ok(near.calls.length > 600);
  assert.ok(pdf.calls.length > 600);
  assert.ok(far.calls.some(c => c[0] === 'set lineWidth' && c[1] >= 2.7), 'never thinner than a hairline');
});

test('a highlighter multiplies on light paper and not on dark', () => {
  const s = new Stroke('hl', [1, 0.9, 0.3], 12, [[0, 0, 0.5], [50, 0, 0.5]]);
  const light = recorder(), dark = recorder();
  drawStroke(light.ctx, { ox: 0, oy: 0, perPixel: 1, onDark: false }, s);
  drawStroke(dark.ctx, { ox: 0, oy: 0, perPixel: 1, onDark: true }, s);
  assert.ok(light.calls.some(c => c[0] === 'set globalCompositeOperation' && c[1] === 'multiply'));
  assert.ok(!dark.calls.some(c => c[0] === 'set globalCompositeOperation'));
  assert.equal(light.calls.at(-1)[0], 'restore');
});

test('a lifted tape is faint', () => {
  const s = new Stroke('tape', [0.9, 0.8, 0.3], 16, [[0, 0, 0.5], [50, 0, 0.5]]);
  const closed = recorder(), open = recorder();
  drawStroke(closed.ctx, { ox: 0, oy: 0, perPixel: 1 }, s);
  s.open = true;
  drawStroke(open.ctx, { ox: 0, oy: 0, perPixel: 1 }, s);
  assert.equal(parseCss(closed.state.strokeStyle)[3], 1);
  assert.equal(parseCss(open.state.strokeStyle)[3], 0.16);
});

test('shapes, text and a sticky note', () => {
  const env = { ox: 1e8 - 50, oy: 1e8 - 60, perPixel: 1 };
  for (const kind of ['line', 'arrow', 'rect', 'ellipse']) {
    const { ctx, calls } = recorder();
    drawShape(ctx, env, new Shape(kind, 1e8, 1e8, 1e8 + 80, 1e8 + 30, [1, 0, 0], 2));
    assert.ok(numbers(calls).every(v => Math.abs(v) < 1000), kind);
    assert.ok(calls.some(c => c[0] === 'stroke'), kind);
  }
  const note = new Text(1e8, 1e8, 'note', 13, [0.1, 0.1, 0.1], 170, [1, 0.93, 0.55]);
  const { ctx, calls } = recorder();
  drawText(ctx, env, note);
  assert.equal(calls.filter(c => c[0] === 'fill').length, 2, 'the slip and its folded corner');
  assert.ok(calls.some(c => c[0] === 'fillText' && c[1] === 'note'));
  assert.ok(numbers(calls).every(v => Math.abs(v) < 1000));
});

test('a picture waits for its bitmap', () => {
  const im = new Image(10, 20, 30, 40, new Blob(['x']));
  const a = recorder();
  drawImage(a.ctx, { ox: 0, oy: 0, perPixel: 1 }, im);
  assert.equal(a.calls.length, 0);
  im.bitmap = { fake: true };
  const b = recorder();
  drawImage(b.ctx, { ox: 5, oy: 5, perPixel: 1 }, im);
  assert.deepEqual(b.calls[0], ['drawImage', im.bitmap, 5, 15, 30, 40]);
});

test('every paper draws without trouble on every colour, on pages and on a board', () => {
  const papers = ['blank', 'dots', 'ruled', 'wide', 'grid', 'cornell', 'legal', 'col2', 'col3', 'todo', 'weekly', 'staff', 'go'];
  for (const color of [[1, 1, 1], [0.976, 0.965, 0.902], [0.13, 0.13, 0.15]]) {
    for (const paper of papers) {
      const { ctx, calls } = recorder();
      drawPaper(ctx, { ox: 0, oy: 0, perPixel: 1 }, new Page({ paper, color }));
      assert.ok(numbers(calls).every(Number.isFinite), paper);
      assert.ok(calls.some(c => c[0] === 'fillRect'), paper);
    }
  }
  // a board far from the origin: the pattern is generated from page coordinates and reaches the context relative to the origin
  for (const paper of ['dots', 'ruled', 'grid', 'wide']) {
    const page = new Page({ w: 1e8, h: 1e8, paper, board: true });
    const { ctx, calls } = recorder();
    renderPage(ctx, Object.assign(page, { items: [new Stroke('ball', [0, 0, 0], 1, [[5e7, 5e7, 0.5], [5e7 + 30, 5e7 + 30, 0.5]])] }), { ox: 5e7 - 100, oy: 5e7 - 100, perPixel: 0.5 });
    const n = numbers(calls);
    assert.ok(n.length > 20 && n.every(v => Math.abs(v) < 2000), paper + ' ' + n.filter(v => Math.abs(v) >= 2000).slice(0, 3));
  }
});

test('far away, a board keeps only a thinned-out dot pattern and drops the rulings', () => {
  const page = new Page({ w: 1e8, h: 1e8, paper: 'dots', board: true });
  const near = recorder(), far = recorder();
  drawPaper(near.ctx, { ox: 5e7, oy: 5e7, perPixel: 1 }, page, [5e7, 5e7, 5e7 + 400, 5e7 + 400]);
  drawPaper(far.ctx, { ox: 5e7, oy: 5e7, perPixel: 10 }, page, [5e7, 5e7, 5e7 + 400, 5e7 + 400]);
  const rects = c => c.calls.filter(x => x[0] === 'rect').length;
  assert.ok(rects(far) < rects(near) / 8);
  const grid = new Page({ w: 1e8, h: 1e8, paper: 'grid', board: true });
  const g = recorder();
  drawPaper(g.ctx, { ox: 5e7, oy: 5e7, perPixel: 10 }, grid, [5e7, 5e7, 5e7 + 400, 5e7 + 400]);
  assert.ok(!g.calls.some(c => c[0] === 'lineTo'));
});

test('text lays out in lines: at newlines, between words, and inside a word too long for the line', () => {
  ptext.setMetrics({ width: (t, size) => [...t].length * size, lineHeight: size => size * 1.5, ascent: size => size });
  try {
    assert.deepEqual(ptext.layoutLines('ab\ncd', 10, 0), ['ab', 'cd']);
    assert.deepEqual(ptext.layoutLines('aaa bbb ccc', 10, 70), ['aaa bbb ', 'ccc']);
    assert.deepEqual(ptext.layoutLines('abcdefghij', 10, 40), ['abcd', 'efgh', 'ij']);
    assert.deepEqual(ptext.measure('aaa bbb ccc', 10, 70), [70, 30]);
    assert.deepEqual(ptext.measure('', 10, 70), [0, 15]);
  } finally { ptext.setMetrics(null); }
});
