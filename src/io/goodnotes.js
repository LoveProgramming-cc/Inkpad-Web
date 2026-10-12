// @ts-check
// Reading and writing Goodnotes documents (.goodnotes). Translated from B:goodnotes.py; the format
// is not published, what is here was worked out from files. A document is a zip archive:
//
//   index.events.pb       a log of length-prefixed protobuf records describing the document:
//                         its title, its page templates (a PDF attachment, a page of it, and the
//                         size the template is laid out at) and its pages (which template, and a
//                         sort key that gives the page order)
//   index.notes.pb        page id -> the file with that page's content
//   notes/<id>            length-prefixed protobuf records, a header and a body per element; a
//                         later body for the same element replaces the earlier one, and one
//                         marked as deleted removes it
//   attachments/<id>      the PDFs that the pages are drawn on (paper templates included)
//
// A stroke's geometry is an Apple-LZ4 compressed "tpl" block: a type string followed by the values
// it describes. Three layouts occur: a constant-width path of quadratic curves, a variable-width
// path (curves whose control and end points each carry a radius), and a third one that lists points
// with radii. Only the centre line and the width are read; the cached outline that follows is ignored.
//
// What is imported: pages in order, their PDF backgrounds, pen strokes with colour and width, text
// boxes and notes (plain text), pictures and straight connectors. Anything else is skipped and counted.
import { Document } from '../core/document.js';
import { Image, Shape, Stroke, Text } from '../core/items.js';
import { Page, BOARD_SIZE } from '../core/page.js';
import { PdfDoc } from '../core/pdfdoc.js';
import { ZipReader, ZipWriter } from '../core/zip.js';
import { tr } from '../core/i18n.js';
import { toPng } from '../platform/image.js';
import { uuid } from '../core/uuid.js';

// Goodnotes lays a template out larger than its PDF page; this is the factor when there is no PDF to measure it against.
const FALLBACK_SCALE = 6 / 11;
// The number stored with each point of a pressure-sensitive stroke is not the line's half width:
// measured against the outlines Goodnotes caches next to it, the line is about 1.42 times that number wide.
const PEN_WIDTH = 1.42;
const IMAGE_LIMIT = 2400;   // pixels along the longer side of an imported picture
const TAU = 2 * Math.PI;

export class GoodnotesError extends Error {}

// -- protobuf, as much of it as is needed --------------------------------------------------------------------

/** @param {Uint8Array} b @param {number} i @returns {[number, number]} */
function varint(b, i) {
  let value = 0, mul = 1;
  for (;;) {
    const c = b[i++];
    if (c === undefined) throw new Error('truncated message');
    value += (c & 0x7f) * mul;
    mul *= 128;
    if (!(c & 0x80)) return [value, i];
  }
}

/** (field number, wire type, value) for each field of a message. @param {Uint8Array} b @returns {[number, number, any][]} */
function fields(b) {
  const out = [];
  let i = 0;
  const n = b.length;
  while (i < n) {
    let key;
    [key, i] = varint(b, i);
    const number = Math.floor(key / 8), wire = key % 8;
    let value;
    if (wire === 0) [value, i] = varint(b, i);
    else if (wire === 1) { value = b.subarray(i, i + 8); i += 8; }
    else if (wire === 2) { let size; [size, i] = varint(b, i); value = b.subarray(i, i + size); i += size; }
    else if (wire === 5) { value = b.subarray(i, i + 4); i += 4; }
    else throw new Error('wire type ' + wire);
    if (i > n) throw new Error('truncated message');
    out.push([number, wire, value]);
  }
  return out;
}

/** A message as {field number: [values]}. @param {Uint8Array} b @returns {Record<number, any[]>} */
function message(b) {
  /** @type {Record<number, any[]>} */
  const out = {};
  for (const [number, , value] of fields(b)) (out[number] ??= []).push(value);
  return out;
}

/** @param {Uint8Array} b @returns {Uint8Array[]} */
function records(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let size;
    [size, i] = varint(b, i);
    out.push(b.subarray(i, i + size));
    i += size;
  }
  return out;
}

/** @param {Record<number, any[]>|undefined} m @param {number} number @param {any} [def] */
function first(m, number, def) {
  const v = m && m[number];
  return v && v.length ? v[0] : def;
}

const dec = new TextDecoder('utf-8');
/** @param {any} v */
const text = v => (v instanceof Uint8Array ? dec.decode(v) : '');
const f32 = (/** @type {Uint8Array} */ b) => new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);

/** A point, size or colour: float fields 1..n. A component that is zero is simply left out of the
 * file, so the values have to be placed by field number, not by position. @param {Uint8Array|undefined} value @param {number} n */
function vec(value, n) {
  const out = new Array(n).fill(0.0);
  for (const [number, wire, v] of fields(value || new Uint8Array(0))) if (wire === 5 && number >= 1 && number <= n) out[number - 1] = f32(v);
  return out;
}

// -- Apple's LZ4 framing -------------------------------------------------------------------------------------

/** @param {Uint8Array} src */
function lz4Block(src) {
  /** @type {number[]} */
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const token = src[i++];
    let literal = token >> 4;
    if (literal === 15) for (;;) { const c = src[i++]; literal += c; if (c !== 255) break; }
    for (let k = 0; k < literal; k++) out.push(src[i + k]);
    i += literal;
    if (i >= n) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let length = token & 15;
    if (length === 15) for (;;) { const c = src[i++]; length += c; if (c !== 255) break; }
    length += 4;
    const start = out.length - offset;
    for (let k = 0; k < length; k++) out.push(out[start + k]);   // the match may overlap what it produces
  }
  return Uint8Array.from(out);
}

/** Blocks tagged bv41 (LZ4) or bv4- (stored), ended by bv4$. @param {Uint8Array} b */
function decompress(b) {
  /** @type {Uint8Array[]} */
  const parts = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  while (i + 4 <= b.length) {
    const magic = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    i += 4;
    if (magic === 'bv41') {
      const size = dv.getUint32(i + 4, true);
      i += 8;
      parts.push(lz4Block(b.subarray(i, i + size)));
      i += size;
    } else if (magic === 'bv4-') {
      const size = dv.getUint32(i, true);
      i += 4;
      parts.push(b.subarray(i, i + size));
      i += size;
    } else if (magic === 'bv4$') break;
    else throw new Error('not an LZ4 stream');
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// -- "tpl" blocks ----------------------------------------------------------------------------------------------

/** The type string as a tree: v u f are scalars, A(..) an array, S(..) a struct. @returns {[any[], number]} */
function signature(sig, i = 0) {
  const out = [];
  while (i < sig.length && sig[i] !== ')') {
    const c = sig[i];
    if (c === 'A' || c === 'S') {
      let inner;
      [inner, i] = signature(sig, i + 2);
      out.push([c, inner]);
      i += 1;
    } else { out.push(c); i += 1; }
  }
  return [out, i];
}

/** @param {any[]} types @param {DataView} d @param {number} i @returns {[any[], number]} */
function readTpl(types, d, i) {
  const values = [];
  for (const t of types) {
    if (t === 'v') { values.push(d.getUint16(i, true)); i += 2; }
    else if (t === 'u' || t === 'f') { values.push(d.getFloat32(i, true)); i += 4; }
    else if (t[0] === 'A') {
      const count = d.getUint32(i, true);
      i += 4;
      const inner = t[1];
      if (inner.length === 1 && inner[0] === 'v') { const a = []; for (let k = 0; k < count; k++) a.push(d.getUint16(i + 2 * k, true)); values.push(a); i += 2 * count; }
      else if (inner.length === 1 && (inner[0] === 'u' || inner[0] === 'f')) { const a = []; for (let k = 0; k < count; k++) a.push(d.getFloat32(i + 4 * k, true)); values.push(a); i += 4 * count; }
      else {
        const items = [];
        for (let k = 0; k < count; k++) { let item; [item, i] = readTpl(inner, d, i); items.push(item); }
        values.push(items);
      }
    } else {
      let item;
      [item, i] = readTpl(t[1], d, i);
      values.push(item);
    }
  }
  return [values, i];
}

/** @param {Uint8Array} raw @returns {[string, any[]]} */
function tpl(raw) {
  if (!(raw[0] === 0x74 && raw[1] === 0x70 && raw[2] === 0x6c && raw[3] === 0)) throw new Error('not a tpl block');   // "tpl\0"
  let end = 8;
  while (raw[end] !== 0) end++;
  const sig = String.fromCharCode(...raw.subarray(8, end));
  const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return [sig, readTpl(signature(sig)[0], d, end + 1)[0]];
}

// -- strokes -------------------------------------------------------------------------------------------------------

/** Add the middle and the end of a quadratic curve to a polyline of [x, y, width]. @param {number[][]} points @param {number[]} p0 @param {number[]} c @param {number[]} p1 */
function quad(points, p0, c, p1) {
  points.push(p0.map((a, k) => 0.25 * a + 0.5 * c[k] + 0.25 * p1[k]));
  points.push(p1);
}

/** A width factor, or 1 where the file holds something that is not one. @param {number} k */
const factor = k => (k > 0.05 && k < 8 ? k : 1.0);

/** A stroke's centre lines as [[tool hint, [[x, y, width], ...]], ...]; width is a diameter. @param {Uint8Array} raw @returns {[string, number[][]][]} */
function paths(raw) {
  const [sig, v] = tpl(raw);
  /** @type {[string, number[][]][]} */
  let out = [];
  if (sig.startsWith('vuA(v)A(S(uu))A(S(uuuu))')) {
    // Constant width: op 0 starts at the next point, op 1 is a curve (control, end).
    const [width, ops, moves, curves] = [v[1], v[2], v[3], v[4]];
    let mi = 0, ci = 0;
    /** @type {number[][]|null} */ let current = null;
    for (const op of ops) {
      if (op === 0 && mi < moves.length) {
        const [x, y] = moves[mi][0]; mi++;
        current = [[x, y, width]];
        out.push(['ball', current]);
      } else if (op === 1 && ci < curves.length && current) {
        const [cx, cy, x, y] = curves[ci][0]; ci++;
        quad(current, current[current.length - 1], [cx, cy, width], [x, y, width]);
      }
    }
  } else if (sig.startsWith('vA(v)A(u)A(u)')) {
    // Variable width: op 4 starts at (x, y, radius, ...), op 5 is a curve whose control and end point each carry a radius.
    const [ops, moves, curves] = [v[1], v[2], v[3]];
    let mi = 0, ci = 0;
    /** @type {number[][]|null} */ let current = null;
    for (const op of ops) {
      if (op === 4 && mi + 4 <= moves.length) {
        const [x, y, r] = moves.slice(mi, mi + 3); mi += 4;
        current = [[x, y, PEN_WIDTH * r]];
        out.push(['fountain', current]);
      } else if (op === 5 && ci + 9 <= curves.length && current) {
        const [cx, cy, cr, x, y, r] = curves.slice(ci, ci + 6); ci += 9;
        quad(current, current[current.length - 1], [cx, cy, PEN_WIDTH * cr], [x, y, PEN_WIDTH * r]);
      }
    }
  } else if (sig.startsWith('vuA(v)A(u)A(u)')) {
    // A brush stroke, in up to two stretches that share the two arrays. It starts with a taper of
    // overlapping dabs: op 2 is a dab's centre (x, y, size) and op 3 its extent, which adds nothing
    // to the centre line. It may go on at a constant width, op 0 (x, y) and op 1 (control, end), or
    // as a broad nib with a size at every point: op 6 (x, y, size, ..) and op 7 (control, end, their sizes, three more numbers).
    let [base, ops, points, curves] = [v[1], v[2], v[3], v[4]];
    // Compared with Goodnotes' own rendering, a dab's size is the width of the line there, and the constant
    // width is the pen's nominal size, which is PEN_WIDTH times what is drawn. A nib is a slanted edge about
    // three quarters of its size long: the line is as wide as the edge is across the direction of travel, and
    // never thinner than six tenths of it. Where the file gives the edge, each point gets its own width below.
    const k = 1.0;
    let nib = 0.74;
    if (base > 0) base /= PEN_WIDTH;
    /** @type {number[]|null} */ let edge = null;
    if (v.length > 10 && Array.isArray(v[10]) && v[10].length >= 7 && v[10][3] > 0) {
      edge = [v[10][4], v[10][5]];
      nib = Math.min(1.0, 2 * Math.hypot(edge[0], edge[1]) / v[10][3]) || 0.74;
    }
    /** @type {number[][][]} */ const broad = [];   // the paths drawn with the nib
    let pi = 0, ci = 0;
    /** @type {number[][]|null} */ let current = null;
    /** @type {number[]|null} */ let tail = null;   // where the last dab reaches to, used when nothing follows the taper
    const to = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w) => {
      if (current === null) { current = [[x, y, w]]; out.push(['fountain', current]); }
      else if (Math.abs(current[current.length - 1][0] - x) + Math.abs(current[current.length - 1][1] - y) > 0.01) current.push([x, y, w]);
    };
    for (const op of ops) {
      if (op === 2 && pi + 3 <= points.length) {
        const [x, y, r] = points.slice(pi, pi + 3); pi += 3;
        to(x, y, k * r);
      } else if (op === 3 && ci + 6 <= curves.length) {
        tail = [curves[ci + 2], curves[ci + 3], k * curves[ci + 5]];
        ci += 6;
      } else if (op === 0 && pi + 2 <= points.length) {
        const [x, y] = points.slice(pi, pi + 2); pi += 2;
        to(x, y, base > 0 ? base : (current ? /** @type {number[][]} */ (current)[/** @type {number[][]} */ (current).length - 1][2] : 1.0));
        tail = null;
      } else if (op === 1 && ci + 4 <= curves.length && current) {
        const [cx, cy, x, y] = curves.slice(ci, ci + 4); ci += 4;
        const cur = /** @type {number[][]} */ (current);
        const w = base > 0 ? base : cur[cur.length - 1][2];
        quad(cur, cur[cur.length - 1], [cx, cy, w], [x, y, w]);
      } else if (op === 6 && pi + 4 <= points.length) {
        const [x, y, r] = points.slice(pi, pi + 3); pi += 4;
        if (nib < 1 && current) { const cur = /** @type {number[][]} */ (current); cur.splice(0, cur.length, ...cur.map(([px, py, w]) => [px, py, nib * w])); }   // the taper before it is in the same unit
        to(x, y, nib * r);
        if (!broad.some(b => b === current)) broad.push(/** @type {number[][]} */ (current));
        tail = null;
      } else if (op === 7 && ci + 9 <= curves.length && current) {
        const [cx, cy, x, y, cr, r] = curves.slice(ci, ci + 6); ci += 9;
        const cur = /** @type {number[][]} */ (current);
        quad(cur, cur[cur.length - 1], [cx, cy, nib * cr], [x, y, nib * r]);
      } else throw new Error(`unknown op ${op} in a brush stroke`);
    }
    if (tail !== null && current) to(tail[0], tail[1], tail[2]);
    if (current && /** @type {number[][]} */ (current).length === 1) { const c0 = /** @type {number[][]} */ (current)[0]; /** @type {number[][]} */ (current).push([c0[0] + 0.01, c0[1], c0[2]]); }
    if (edge && Math.hypot(edge[0], edge[1]) > 0) {
      const len = Math.hypot(edge[0], edge[1]);
      const ex = edge[0] / len, ey = edge[1] / len;
      for (const pts of broad) {
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const d = Math.hypot(dx, dy);
          const across = d > 0 ? Math.abs(ex * dy - ey * dx) / d : 1.0;
          pts[i] = [pts[i][0], pts[i][1], pts[i][2] * Math.max(0.6, across)];
        }
      }
    }
  } else if (sig.startsWith('vuA(v)A(S(uuuuu))A(S(uuuuuuuuuuu))')) {
    // A base width, and points that each carry a factor for it: op 0 starts at (x, y, factor, ..), op 1 is a
    // curve (.., control with its factor, end with its factor).
    const [width, ops, moves, curves] = [v[1], v[2], v[3], v[4]];
    let mi = 0, ci = 0;
    /** @type {number[][]|null} */ let current = null;
    for (const op of ops) {
      if (op === 0 && mi < moves.length) {
        const [x, y, k] = moves[mi][0].slice(0, 3); mi++;
        current = [[x, y, width * factor(k)]];
        out.push(['fountain', current]);
      } else if (op === 1 && ci < curves.length && current) {
        const c = curves[ci][0]; ci++;
        quad(current, current[current.length - 1], [c[1], c[2], width * factor(c[3])], [c[6], c[7], width * factor(c[8])]);
      }
    }
  } else throw new Error('unknown stroke layout ' + sig);
  for (const [, pts] of out) {
    if (pts.some(([x, y, w]) => !(Math.abs(x) < 1e7 && Math.abs(y) < 1e7 && w >= 0 && w < 400))) throw new Error('stroke read as nonsense');   // better none than a blot over the page
  }
  return out.filter(([, pts]) => pts.length);
}

/** The outline of a recognised shape, which is stored as its geometry instead of as a drawn path: a polyline, a curve, a rectangle or an ellipse.
 * @param {Uint8Array} shape @returns {[string, number[][]][]} */
function shapePaths(shape) {
  const m = message(shape);
  const width = vec(shape, 15)[14] || 2.0;
  /** @type {number[][]} */ let pts = [];
  let corners = false;
  if (1 in m) {
    pts = (message(m[1][0])[1] || []).map(/** @param {Uint8Array} p */ p => vec(p, 2));
    if (pts.length === 1) pts = [pts[0], pts[0]];
    corners = true;
  } else if (2 in m) {
    // The middle point is taken to be the curve's control point; the file does not say.
    const g = message(m[2][0]);
    const [a, c, b] = [1, 2, 3].map(k => vec(first(g, k), 2));
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push(a.map((p, k) => (1 - t) ** 2 * p + 2 * t * (1 - t) * c[k] + t * t * b[k]));
    }
  } else if (3 in m) {
    const g = message(m[3][0]);
    const [cx, cy] = vec(first(g, 1), 2), [w, h] = vec(first(g, 2), 2);
    pts = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]];
    corners = true;
  } else if (4 in m) {
    const g = message(m[4][0]);
    const [cx, cy] = vec(first(g, 1), 2), [rx, ry] = vec(first(g, 2), 2);
    const turn = vec(m[4][0], 3)[2];
    const cos = Math.cos(turn), sin = Math.sin(turn);
    for (let i = 0; i <= 48; i++) {
      const a = i * TAU / 48;
      const x = rx * Math.cos(a), y = ry * Math.sin(a);
      pts.push([cx + x * cos - y * sin, cy + x * sin + y * cos]);
    }
  }
  if (corners) {
    // Inkpad rounds a stroke through its points; a point given twice stays a sharp corner.
    const mid = pts.slice(1, -1).flatMap(p => [p, p]);
    pts = [...pts.slice(0, 1), ...mid, ...pts.slice(-1)];
  }
  const dashed = 1 in message(first(m, 5, new Uint8Array(0)));
  return pts.length > 1 ? [[dashed ? 'dash' : 'ball', pts.map(([x, y]) => [x, y, width])]] : [];
}

/** An element's bounding box [x0, y0, x1, y1], from its origin and size. @param {Record<number, any[]>} body */
function frame(body) {
  const f = message(first(body, 2, new Uint8Array(0)));
  const [x, y] = vec(first(f, 1), 2), [w, h] = vec(first(f, 2), 2);
  return [x - 4, y - 4, x + w + 4, y + h + 4];
}

/** Inkpad strokes for one stroke element. `within` drops paths outside a box: a formula's parts include
 * helper strokes in a coordinate system of their own. @param {Record<number, any[]>} body @param {number} scale */
function strokes(body, scale, dataField = 2, colorField = 4, within = null) {
  const data = first(body, dataField);
  if (!data || !data.length) return [];
  const rgba = vec(first(body, colorField), 4);
  const color = rgba.slice(0, 3).map(c => Math.max(0.0, Math.min(1.0, c)));
  const alpha = rgba[3];
  const [dx, dy] = vec(first(body, 6), 2);   // where the stroke was moved to after it was drawn
  const marker = !!first(body, 5);           // a highlighter: drawn in full colour, blended under the text
  /** @type {Stroke[]} */ const out = [];
  let ps = paths(decompress(data));
  if (!ps.length && first(body, 9)) ps = shapePaths(first(body, 9));
  for (const [tool, pts0] of ps) {
    if (within && !pts0.every(([x, y]) => within[0] <= x && x <= within[2] && within[1] <= y && y <= within[3])) continue;
    const pts = pts0.map(([x, y, w]) => [(x + dx) * scale, (y + dy) * scale, w * scale]);
    const widths = pts.map(p => p[2]);
    const mean = Math.max(0.2, widths.reduce((a, b) => a + b, 0) / widths.length);
    if (marker || alpha < 0.9) out.push(new Stroke('hl', color, mean, pts.map(([x, y]) => [x, y, 0.5])));
    else if (tool === 'fountain' && Math.max(...widths) - Math.min(...widths) > 0.02) {
      // Inkpad's fountain pen draws width * (0.4 + 1.2 * pressure): turn each width back into the pressure that gives it.
      out.push(new Stroke('fountain', color, mean, pts.map(([x, y, w]) => [x, y, Math.max(0.0, Math.min(1.0, (w / mean - 0.4) / 1.2))]), 1.0));
    } else out.push(new Stroke('ball', color, mean, pts.map(([x, y]) => [x, y, 0.5]), 1.0, tool === 'dash' ? 1 : 0));
  }
  return out;
}

/** The plain text of a compressed rich-text block. @param {Uint8Array} packed */
function runs(packed) {
  const t = (message(decompress(packed))[1] || []).map(/** @param {Uint8Array} run */ run => text(first(message(run), 1, new Uint8Array(0)))).join('');
  return t.replace(/^\n+|\n+$/g, '');
}

/** A text box as plain text; its styling is not read. @param {Record<number, any[]>} body @param {number} scale */
function textBox(body, scale) {
  const content = message(first(body, 32, new Uint8Array(0)));
  const packed = first(message(first(content, 1, new Uint8Array(0))), 2);
  const t = packed ? runs(packed) : '';
  if (!t.trim()) return null;
  const [x, y] = vec(first(message(first(body, 20, new Uint8Array(0))), 1), 2);
  const layout = message(first(body, 21, new Uint8Array(0)));
  const width = 2 in layout ? vec(first(layout, 2), 1)[0] : vec(first(content, 2), 1)[0];
  const style = message(first(message(first(content, 5, new Uint8Array(0))), 1, new Uint8Array(0)));
  const f = first(style, 40);
  const font = f ? f32(f) : 18.0;
  const pad = 10 * scale;   // the box's inner margin
  return new Text(x * scale + pad, y * scale + pad, t, Math.max(6.0, font * scale), [0.1, 0.1, 0.1], Math.max(60.0, (width || 400.0) * scale - 2 * pad));
}

/** A comment or sticky note: its text on a slip of its colour. @param {Record<number, any[]>} body @param {number} scale */
function sticky(body, scale) {
  const packed = first(message(first(message(first(body, 31, new Uint8Array(0))), 1, new Uint8Array(0))), 2);
  const t = packed ? runs(packed) : '';
  if (!t.trim()) return null;
  const [x, y] = vec(first(message(first(body, 20, new Uint8Array(0))), 1), 2);
  const color = vec(first(body, 30), 3).map(c => Math.max(0.0, Math.min(1.0, c)));
  const layout = message(first(body, 21, new Uint8Array(0)));
  const width = 2 in layout ? vec(first(layout, 2), 1)[0] * scale : 0.0;
  return new Text(x * scale + 8, y * scale + 8, t, 11.0, [0.15, 0.15, 0.15], Math.max(160.0, width - 16), color);
}

/** The text of an RTF fragment, without its formatting. @param {string} rtf */
function unrtf(rtf) {
  /** @type {string[]} */ const out = [];
  let i = 0, depth = 0, skip = null;
  const SKIP = ['{\\fonttbl', '{\\colortbl', '{\\*', '{\\stylesheet', '{\\info'];
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') {
      depth++;
      if (skip === null && SKIP.some(s => rtf.startsWith(s, i))) skip = depth;
      i++;
    } else if (c === '}') {
      if (skip === depth) skip = null;
      depth--;
      i++;
    } else if (c === '\\') {
      const j = i + 1;
      if (rtf[j] === "'") {   // \'hh: a byte in the document's code page
        if (skip === null) { const n = parseInt(rtf.slice(j + 1, j + 3), 16); if (!Number.isNaN(n)) out.push(new TextDecoder('windows-1252').decode(Uint8Array.of(n))); }
        i = j + 3;
      } else if (j < rtf.length && !/[A-Za-z]/.test(rtf[j])) {   // an escaped character, or a line break
        if (skip === null) out.push(rtf[j] === '\n' ? '\n' : rtf[j]);
        i = j + 1;
      } else {
        let k = j;
        while (k < rtf.length && /[A-Za-z]/.test(rtf[k])) k++;
        const word = rtf.slice(j, k);
        let m = k;
        while (m < rtf.length && (/[0-9]/.test(rtf[m]) || rtf[m] === '-')) m++;
        if (skip === null) {
          if (word === 'par' || word === 'line') out.push('\n');
          else if (word === 'tab') out.push('\t');
          else if (word === 'u' && m > k) {
            out.push(String.fromCharCode(((Number(rtf.slice(k, m)) % 65536) + 65536) % 65536));
            if (rtf[m] === ' ') m++;
            if (m < rtf.length && !'\\{}'.includes(rtf[m])) m++;   // the fallback character
            i = m;
            continue;
          }
        }
        i = rtf[m] === ' ' ? m + 1 : m;
      }
    } else {
      if (skip === null && c !== '\r' && c !== '\n') out.push(c);
      i++;
    }
  }
  return out.join('').trim();
}

/** An older kind of text box, stored as RTF with its frame. @param {Record<number, any[]>} body @param {number} scale */
function rtfBox(body, scale) {
  const t = unrtf(text(first(body, 6, new Uint8Array(0))));
  if (!t) return null;
  const f = message(first(body, 3) || first(body, 2, new Uint8Array(0)));
  const [x, y] = vec(first(f, 1), 2);
  const w = vec(first(f, 2), 2)[0];
  return new Text(x * scale, y * scale, t, 11.0, [0.1, 0.1, 0.1], Math.max(60.0, w * scale));
}

/** A straight connector between two points. @param {Record<number, any[]>} body @param {number} scale */
function line(body, scale) {
  const geometry = message(first(body, 20, new Uint8Array(0)));
  const [x0, y0] = vec(first(geometry, 2), 2);
  const [x1, y1] = vec(first(message(first(geometry, 3, new Uint8Array(0))), 1), 2);
  const style = message(first(body, 32, new Uint8Array(0)));
  const width = vec(first(body, 32), 1)[0] || 2.0;
  const color = vec(first(message(first(style, 3, new Uint8Array(0))), 1), 3).map(c => Math.max(0.0, Math.min(1.0, c)));
  return new Shape('line', x0 * scale, y0 * scale, x1 * scale, y1 * scale, color, Math.max(0.3, width * scale));
}

// -- the document ------------------------------------------------------------------------------------------------------

/** A picture placed on the page: its frame and the attachment that holds the file. */
async function image(body, scale, z, attachments, names) {
  const name = attachments[text(first(body, 4, new Uint8Array(0)))];
  if (!names.has(name)) return null;
  const f = message(first(body, 2, new Uint8Array(0)));
  const [x, y] = vec(first(f, 1), 2), [w, h] = vec(first(f, 2), 2);
  let png = null;
  if (w > 0 && h > 0) { try { png = (await toPng(await z.blobOf(name), IMAGE_LIMIT)).png; } catch { png = null; } }
  return png ? new Image(x * scale, y * scale, w * scale, h * scale, png) : null;
}

/** @param {[number, Record<number, any[]>]} element */
function made(element) {
  try {
    const stamp = first(element[1], element[0] === 1 ? 5 : 7, new Uint8Array(0));
    const number = stamp instanceof Uint8Array ? first(message(first(message(stamp), 1, new Uint8Array(0))), 1, 0) : 0;
    return typeof number === 'number' ? number : 0;
  } catch { return 0; }
}

/** A page's content is stored under its own id with the last byte one higher. @param {string} pageId */
function notesId(pageId) {
  const n = parseInt(pageId.slice(-2), 16);
  return Number.isNaN(n) ? pageId : pageId.slice(0, -2) + (((n + 1) & 0xff).toString(16).toUpperCase().padStart(2, '0'));
}

/**
 * Read a .goodnotes file; returns the document, its title and what was read.
 * @param {Blob} blob @returns {Promise<{doc: Document, title: string, stats: {strokes: number, texts: number, shapes: number, formulas: number, images: number, skipped: number}}>}
 */
export async function loadGoodnotes(blob) {
  /** @type {ZipReader} */ let z;
  try { z = await ZipReader.open(blob); } catch { throw new GoodnotesError(tr('不是 Goodnotes 文档')); }
  const names = new Set(z.names);
  if (!names.has('index.events.pb') || !names.has('index.notes.pb')) throw new GoodnotesError(tr('不是 Goodnotes 文档'));
  /** @type {string|null} */ let title = null;
  /** @type {Record<string, [string, number, number[]|null]>} */ const templates = {};   // id -> [attachment id, PDF page number from 1, [width, height]]
  /** @type {Record<string, [string|null, string]>} */ const pages = {};   // id -> [template id, sort key]
  for (const record of records(await z.bytes('index.events.pb'))) {
    for (const [number, wire, value] of fields(record)) {
      if (wire !== 2 || number === 1) continue;
      let m;
      try { m = message(value); } catch { continue; }
      if (number === 30) title = text(first(message(first(m, 2, new Uint8Array(0))), 1, new Uint8Array(0))) || title;
      else if (number === 2) {
        const size = vec(first(m, 8), 2);
        templates[text(first(m, 2))] = [text(first(m, 4, new Uint8Array(0))), first(m, 5, 1), size[0] > 0 && size[1] > 0 ? size : null];
      } else if (number === 54) {
        const page = (pages[text(first(m, 2))] ??= [null, '']);
        const template = text(first(message(first(m, 3, new Uint8Array(0))), 1, new Uint8Array(0)));
        const key = text(first(message(first(m, 4, new Uint8Array(0))), 1, new Uint8Array(0)));
        page[0] = template || page[0]; page[1] = key || page[1];
      } else if (number === 55) {
        // A page that was moved gets a new sort key.
        const key = text(first(message(first(m, 3, new Uint8Array(0))), 1, new Uint8Array(0)));
        const page = pages[text(first(m, 2))];
        if (page && key) page[1] = key;
      }
    }
  }
  /** @type {Record<string, string>} */ const files = {};
  for (const record of records(await z.bytes('index.notes.pb'))) { const m = message(record); files[text(first(m, 1))] = text(first(m, 2)); }
  /** @type {Record<string, string>} */ const attachments = {};
  if (names.has('index.attachments.pb')) for (const record of records(await z.bytes('index.attachments.pb'))) { const m = message(record); attachments[text(first(m, 1))] = text(first(m, 2)); }

  /** @type {Map<string, PdfDoc|null>} */ const pdfs = new Map();
  const pdfFor = async (/** @type {string} */ attachment) => {
    if (!pdfs.has(attachment)) {
      pdfs.set(attachment, null);
      const name = attachments[attachment];
      if (names.has(name)) {
        const data = await z.blobOf(name);
        if (new TextDecoder().decode(new Uint8Array(await data.slice(0, 5).arrayBuffer())) === '%PDF-') {
          try { const p = await PdfDoc.fromBlob(data); await p.nPages(); pdfs.set(attachment, p); } catch { /* not readable */ }
        }
      }
    }
    return /** @type {PdfDoc|null} */ (pdfs.get(attachment));
  };

  const doc = new Document();
  doc.pages = [];
  const stats = { strokes: 0, texts: 0, shapes: 0, formulas: 0, images: 0, skipped: 0 };
  const order = Object.entries(pages).sort((a, b) => (a[1][1] < b[1][1] ? -1 : a[1][1] > b[1][1] ? 1 : 0));
  for (const [pageId, [template]] of order) {
    const [attachment, number, size] = templates[/** @type {string} */ (template)] ?? ['', 1, null];
    const pdf = attachment ? await pdfFor(attachment) : null;
    /** @type {Page} */ let page;
    let scale;
    if (pdf && number >= 1 && number <= await pdf.nPages()) {
      const [w, h] = await pdf.pageSize(number - 1);
      page = new Page({ w, h, pdf, pdfPage: number - 1 });
      scale = size && size[0] > 0 ? w / size[0] : FALLBACK_SCALE;
    } else if (size) {
      scale = FALLBACK_SCALE;
      page = new Page({ w: size[0] * scale, h: size[1] * scale });
    } else {
      // No template and no size: a whiteboard, which has no edges in Inkpad either.
      scale = FALLBACK_SCALE;
      page = new Page({ w: BOARD_SIZE[0], h: BOARD_SIZE[1], paper: 'dots', board: true });
    }
    const name = files[notesId(pageId)] || files[pageId];
    /** @type {Map<string, [number, Record<number, any[]>]>} */ const elements = new Map();   // element id -> [kind, body]; a later record replaces an earlier one
    if (name && names.has(name)) {
      for (const record of records(await z.bytes(name))) {
        let number, body;
        try {
          const fs = fields(record);
          let wire, value;
          [number, wire, value] = fs[0];
          if (wire !== 2 || (number === 1 && fs.length > 1)) continue;   // the header that precedes each element
          body = message(value);
          if (number === 1 && !(first(body, 1) instanceof Uint8Array)) continue;
        } catch { continue; }
        elements.set(text(first(body, 1, new Uint8Array(0))), [number, body]);
      }
    }
    // Elements are numbered as they were made; later ones lie on top of earlier ones.
    for (const [kind, body] of [...elements.values()].sort((a, b) => made(a) - made(b))) {
      if (first(body, 14)) continue;   // erased or removed
      try {
        if (kind === 7) { const s = strokes(body, scale); page.items.push(...s); stats.strokes += s.length; }
        else if (kind === 21 || kind === 20 || kind === 8) {
          const t = (kind === 21 ? textBox : kind === 20 ? sticky : rtfBox)(body, scale);
          if (t) { page.items.push(t); stats.texts++; }
        } else if (kind === 11) {
          // Handwriting that Goodnotes shows typeset as a formula. Inkpad cannot typeset, so the handwriting it was made from is kept instead.
          if (first(body, 6)) continue;   // a conversion that was undone: its handwriting is on the page as strokes
          for (const part of body[11] || []) { const s = strokes(message(part), scale, 1, 2, /** @type {any} */ (frame(body))); page.items.push(...s); stats.strokes += s.length; }
          stats.formulas++;
        } else if (kind === 1) {
          if (Math.max(...vec(first(message(first(body, 2, new Uint8Array(0))), 2), 2)) < 1) continue;   // a speck too small to see, which Goodnotes leaves as a marker
          const im = await image(body, scale, z, attachments, names);
          if (im) { page.items.push(im); stats.images++; } else stats.skipped++;
        } else if (kind === 9) { /* a region marked for some tool; it shows nothing on the page */ }
        else if (kind === 22) { page.items.push(line(body, scale)); stats.shapes++; }
        else stats.skipped++;
      } catch { stats.skipped++; }
    }
    doc.pages.push(page);
  }
  // Inkpad treats a document as either pages or whiteboards, going by its first page.
  if (doc.pages.some(p => p.board) && !doc.pages.every(p => p.board)) doc.pages = doc.pages.filter(p => p.board === doc.pages[0].board);
  if (!doc.pages.length) throw new GoodnotesError(tr('这个 Goodnotes 文档里没有可以读取的页面'));
  doc.rev = 1;   // not on disk yet
  return { doc, title: title || 'Goodnotes', stats };
}

// -- writing --------------------------------------------------------------------------------------------------------------
//
// Experimental. The records below copy the shape of what Goodnotes itself writes, but the meaning of
// several of their fields (the counters and hashes that look like sync clocks) is a guess, and no
// Goodnotes app was available to open the result. What is certain is only that loadGoodnotes reads it back.

/** @param {number|bigint} n @returns {number[]} */
function encVarint(n) {
  let v = BigInt(n);
  const out = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) out.push(b | 0x80); else { out.push(b); return out; }
  }
}

/** A float32 field's value: a number that is to be written as a float, not an int. */
class F32 { /** @param {number} v */ constructor(v) { this.v = v; } }
const fl = (/** @type {number} */ v) => new F32(v);

/** @param {Uint8Array[]|number[]} a */
function cat(...a) {
  const parts = /** @type {Uint8Array[]} */ (a);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** One field: an int is a varint, a float a float32, bytes or a string length-delimited. @param {number} number @param {number|bigint|boolean|F32|string|Uint8Array} value */
function f(number, value) {
  if (typeof value === 'boolean') value = value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint') return Uint8Array.from([...encVarint(number << 3), ...encVarint(value)]);
  if (value instanceof F32) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value.v, true); return cat(Uint8Array.from(encVarint((number << 3) | 5)), b); }
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return cat(Uint8Array.from([...encVarint((number << 3) | 2), ...encVarint(bytes.length)]), bytes);
}

/** @param {number} number @param {number} value */
function f64(number, value) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, true);
  return cat(Uint8Array.from(encVarint((number << 3) | 1)), b);
}

/** @param {Uint8Array} m */
const record = m => cat(Uint8Array.from(encVarint(m.length)), m);
const rnd32 = () => crypto.getRandomValues(new Uint32Array(1))[0];
const stamp = (counter = 1) => cat(f(1, counter), f(2, rnd32()));
const newId = () => uuid().toUpperCase();

/** A constant-width path in the simplest of the three layouts, stored uncompressed. @param {number[][]} points @param {number} width */
function packStroke(points, width) {
  const ops = [0, ...new Array(points.length - 1).fill(1)];
  const sig = new TextEncoder().encode('vuA(v)A(S(uu))A(S(uuuu))vA(f)\0');
  /** @type {number[]} */ const data = [];
  const u16 = (/** @type {number} */ v) => data.push(v & 255, v >> 8);
  const u32 = (/** @type {number} */ v) => data.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const flt = (/** @type {number} */ v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); data.push(...b); };
  u16(2); flt(width);
  u32(ops.length); ops.forEach(u16);
  u32(1); flt(points[0][0]); flt(points[0][1]);
  u32(points.length - 1);
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    // A straight piece as a curve whose control point is its middle.
    flt((x0 + x1) / 2); flt((y0 + y1) / 2); flt(x1); flt(y1);
  }
  u16(1); u32(0);
  const head = new Uint8Array(8);
  const hv = new DataView(head.buffer);
  hv.setUint8(0, 0x74); hv.setUint8(1, 0x70); hv.setUint8(2, 0x6c); hv.setUint8(3, 0);
  hv.setUint32(4, 8 + sig.length + data.length, true);
  const raw = cat(head, sig, Uint8Array.from(data));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, raw.length, true);
  return cat(new TextEncoder().encode('bv4-'), size, raw, new TextEncoder().encode('bv4$'));
}

/**
 * Write an Inkpad document as a .goodnotes file (experimental, see above). Each page's paper, PDF,
 * pictures, shapes and text go into one background PDF; pen and highlighter strokes are written as
 * strokes, at their average width. @param {Document} doc @param {string} title @returns {Promise<Blob>}
 */
export async function saveGoodnotes(doc, title) {
  const { buildPdf } = await import('./exportpdf.js');
  const { getExportFont } = await import('./exportfont.js');
  const { vfs } = await import('../core/storage.js');
  const { pageBox } = await import('../core/page.js');
  const now = Date.now() / 1000;
  const device = BigInt(rnd32()) << 30n | BigInt(rnd32() >>> 2);
  let clock = Math.trunc(now * 1000);
  const tick = () => ++clock;
  const docId = newId(), attachment = newId();
  const up = 1 / FALLBACK_SCALE;   // Goodnotes lays pages out this much larger than their PDF

  // The background of every page, without its strokes, as one PDF.
  const font = await getExportFont(vfs());
  const { blob: pdfBlob } = await buildPdf(doc, { font, itemFilter: it => it.kind !== 's' });
  const pdf = new Uint8Array(await pdfBlob.arrayBuffer());
  const boxes = doc.pages.map(page => {
    const [x0, y0, x1, y1] = pageBox(page);
    const k = Math.min(1.0, 14400 / Math.max(x1 - x0, y1 - y0));
    return [x0, y0, k, (x1 - x0) * k, (y1 - y0) * k];
  });

  /** @type {Uint8Array[]} */
  const events = [record(cat(f(1, docId), f(30, cat(
    f(1, docId), f(2, cat(f(1, title), f(2, stamp()))), f(6, cat(f(1, 'P'), f(2, stamp()))),
    f(9, 'en_US'), f64(10, now * 1000), f(11, newId()), f(13, device), f(14, tick()),
    f(17, new Uint8Array(0)), f(18, new Uint8Array(0)), f(19, f(2, stamp())), f(20, 24)))))];
  events.push(record(cat(f(1, attachment), f(6, cat(
    f(1, attachment), f(2, attachment), f(5, pdf.length), f(6, docId), f64(10, now * 1000),
    f(11, newId()), f(12, cat(f(1, 1), f(2, 1))), f(14, device), f(15, tick()), f(16, 24))))));

  /** @type {Uint8Array[]} */ const notesIndex = [];
  /** @type {Record<string, Uint8Array>} */ const files = {};
  for (const [n, page] of doc.pages.entries()) {
    const [bx, by, k, pw, ph] = boxes[n];
    const template = newId();
    let pageId = newId();
    pageId = pageId.slice(0, -2) + (parseInt(pageId.slice(-2), 16) & 0xfe).toString(16).toUpperCase().padStart(2, '0');   // so that +1 does not wrap
    events.push(record(cat(f(1, template), f(2, cat(
      f(1, docId), f(2, template), f(4, attachment), f(5, n + 1), f(6, 1),
      f(8, cat(f(1, fl(pw * up)), f(2, fl(ph * up)))), f64(10, now * 1000), f(11, newId()),
      f(12, f(2, stamp())), f(13, f(2, stamp())), f(15, device), f(16, tick()),
      f(17, cat(f(1, 1), f(2, stamp()))), f(19, f(2, stamp())), f(21, 24))))));
    events.push(record(cat(f(1, pageId), f(54, cat(
      f(1, docId), f(2, pageId), f(3, cat(f(1, template), f(2, stamp()))),
      f(4, cat(f(1, 'P' + String(n).padStart(6, '0')), f(2, stamp()))), f64(10, now * 1000), f(11, newId()),
      f(13, device), f(14, tick()), f(15, 24))))));
    /** @type {Uint8Array[]} */ const body = [];
    let counter = 1000000;
    for (const it of page.items) {
      if (it.kind !== 's' || it.pts.length < 1) continue;
      const pts = it.pts.map(/** @param {number[]} p */ p => [(p[0] - bx) * k * up, (p[1] - by) * k * up]);
      if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
      const width = it.pts.reduce(/** @param {number} s @param {number[]} p */ (s, p) => s + it.wAt(p[2]), 0) / it.pts.length * k * up;
      const sid = newId();
      const st = stamp(2);
      counter++;
      body.push(record(cat(f(1, sid), f(2, st), f(6, sid), f(8, device), f(9, counter), f(14, 5381), f(16, 24))));
      const [r, g, b] = it.color;
      const color = cat(f(1, fl(r)), f(2, fl(g)), f(3, fl(b)), f(4, fl(it.tool === 'hl' ? 0.5 : 1.0)));
      body.push(record(f(7, cat(f(1, sid), f(2, packStroke(pts, width)), f(4, color), f(6, new Uint8Array(0)),
        f(7, f(1, stamp(pts.length))), f(9, new Uint8Array(0)), f(15, st), f(20, new Uint8Array(0)), f(21, 24)))));
    }
    const nid = notesId(pageId);
    files['notes/' + nid] = cat(...body);
    notesIndex.push(record(cat(f(1, nid), f(2, 'notes/' + nid))));
  }
  const z = new ZipWriter();
  await z.add('document.info.pb', new Uint8Array(0));
  await z.add('schema.pb', f(1, 25));
  await z.add('index.events.pb', cat(...events));
  await z.add('index.notes.pb', cat(...notesIndex));
  await z.add('index.search.pb', new Uint8Array(0));
  await z.add('index.attachments.pb', record(cat(f(1, attachment), f(2, 'attachments/' + attachment))));
  await z.add('attachments/' + attachment, pdf);
  for (const [name, data] of Object.entries(files)) await z.add(name, data);
  try { await z.add('thumbnail.jpg', await coverJpeg(doc)); } catch { /* optional */ }
  return z.finish();
}

/** @param {Document} doc */
async function coverJpeg(doc) {
  const png = await doc.cover();
  const bitmap = await createImageBitmap(png);
  const c = document.createElement('canvas');
  c.width = bitmap.width; c.height = bitmap.height;
  /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(bitmap, 0, 0);
  return new Promise(res => c.toBlob(b => res(/** @type {Blob} */ (b)), 'image/jpeg', 0.85));
}

export { GoodnotesError as default };
