import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function fixture(name) {
  return JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
}

/** Deep comparison; numbers may differ by a relative 1e-9 (Python and JS print floats alike, but sum them alike only mostly). */
export function near(actual, expected, path = '$') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path + ' should be a number');
    const tol = 1e-9 * Math.max(1, Math.abs(expected));
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: ${actual} != ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path + ' should be an array');
    assert.equal(actual.length, expected.length, path + ' length');
    expected.forEach((v, i) => near(actual[i], v, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    for (const k of Object.keys(expected)) near(actual[k], expected[k], `${path}.${k}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

import { sha256Blob } from '../src/core/hash.js';

/** The same description of a document that tests/dump_doc.py gives of B's. */
export async function dumpDoc(doc) {
  const pages = [];
  for (const page of doc.pages) {
    const items = [];
    for (const it of page.items) {
      const d = { kind: it.kind, id: it.id, bbox: [...it.bbox] };
      if (it.kind === 's') Object.assign(d, { tool: it.tool, color: it.color, width: it.width, sens: it.sens, dash: it.dash, open: !!it.open, pts: it.pts });
      else if (it.kind === 'h') Object.assign(d, { shape: it.shape, r: [it.x0, it.y0, it.x1, it.y1], color: it.color, width: it.width });
      else if (it.kind === 't') Object.assign(d, { x: it.x, y: it.y, text: it.text, size: it.size, color: it.color, wrap: it.wrap, bg: it.bg || null });
      else Object.assign(d, { r: [it.x, it.y, it.w, it.h], sha: await sha256Blob(it.data) });
      items.push(d);
    }
    pages.push({
      id: page.id, w: page.w, h: page.h, paper: page.paper, color: page.color, board: !!page.board,
      bookmark: !!page.bookmark, outline: page.outline, rot: page.rot, mt: page.mt, gone: [...page.gone].sort(), items,
      pdf: page.pdf ? page.pdf.key : null, pdf_sha: page.pdf ? await page.pdf.sha256() : null, pdf_page: page.pdfPage,
    });
  }
  return { id: doc.id, gone_pages: [...doc.gonePages].sort(), order_mt: doc.orderMt, cover: doc.coverSpec, pages };
}

import { Document } from '../src/core/document.js';
import { Stroke, Shape, Text, Image } from '../src/core/items.js';

export const PNG = new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf5000000401010000d1b6f4c00000000049454e44ae426082', 'hex'));

/** A:ModelTests.sampleDocument: every kind of item, a second page, a picture. */
export function sampleDocument() {
  const black = [0, 0, 0];
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
