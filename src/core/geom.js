// @ts-check
// Geometry helpers: hit testing, lasso picking and scribble-to-erase detection.
// Translated from B:geom.py. All coordinates are page points. Point sequences
// may carry extra fields (pressure); only indices 0 and 1 are read.
// Items are duck-typed: `kind`, `bbox`, `polyline()` and `sample()`.

/** @typedef {number[]} Pt */
/** @typedef {[number, number, number, number]} Box */

/** @param {Box|null} a @param {Box|null} b @returns {Box|null} */
export function union(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** @param {Box} a @param {Box} b */
export function intersects(a, b) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** @param {Pt[]} pts @param {number} [pad] @returns {Box} */
export function bboxOf(pts, pad = 0.0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** @template T @param {T[]} pts @param {number} limit @returns {T[]} */
export function decimate(pts, limit) {
  const n = pts.length;
  if (n <= limit) return pts;
  const step = n / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[n - 1]);
  return out;
}

export function dist2Seg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const d = dx * dx + dy * dy;
  if (d <= 1e-12) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * dx + (py - ay) * dy) / d;
  t = t < 0 ? 0.0 : t > 1 ? 1.0 : t;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

/** @param {Pt[]} pts */
export function polylineHit(pts, x, y, r) {
  const r2 = r * r;
  if (pts.length === 1) return (pts[0][0] - x) ** 2 + (pts[0][1] - y) ** 2 <= r2;
  let a = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (dist2Seg(x, y, a[0], a[1], b[0], b[1]) <= r2) return true;
    a = b;
  }
  return false;
}

/** @param {Pt[]} poly */
export function inPolygon(poly, x, y) {
  let inside = false;
  let ax = poly[poly.length - 1][0], ay = poly[poly.length - 1][1];
  for (const p of poly) {
    const bx = p[0], by = p[1];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    ax = bx; ay = by;
  }
  return inside;
}

/** @param {Pt[]} input @returns {Pt[]} */
export function convexHull(input) {
  const seen = new Set();
  /** @type {Pt[]} */
  let pts = [];
  for (const p of input) {
    const k = p[0] + ',' + p[1];
    if (!seen.has(k)) { seen.add(k); pts.push([p[0], p[1]]); }
  }
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (pts.length < 3) return pts;
  const half = (/** @type {Pt[]} */ seq) => {
    /** @type {Pt[]} */
    const out = [];
    for (const p of seq) {
      while (out.length >= 2 && (
        (out[out.length - 1][0] - out[out.length - 2][0]) * (p[1] - out[out.length - 2][1])
        - (out[out.length - 1][1] - out[out.length - 2][1]) * (p[0] - out[out.length - 2][0])
      ) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return half(pts).concat(half(pts.slice().reverse()));
}

export function segsCross(a, b, c, d) {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return (side(a, b, c) > 0) !== (side(a, b, d) > 0) && (side(c, d, a) > 0) !== (side(c, d, b) > 0);
}

// -- scribble to erase ------------------------------------------------------

const MIN_REVERSALS = 3;       // a scribble is at least four back-and-forth passes
const MIN_LENGTH_RATIO = 2.5;  // path length relative to its extent along the main axis
const MIN_TURNING = 3.75 * Math.PI;        // a scribble goes round twice, or to and fro five times, however small
const MIN_TURNING_PER_CELL = 3.5 * Math.PI; // and turns this much for every stroke-height it travels
const MIN_SWEEPS = 4.0;                   // or its path is this many times as long as it is wide and tall

/** True when a stroke looks like a quick back-and-forth scratch-out. `loose`: decide as A and B do,
 * by the reversals alone (the setting "loose scribble to erase"). @param {Pt[]} pts @param {boolean} [loose] */
export function isScribble(pts, loose = false) {
  const n = pts.length;
  if (n < 10) return false;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const t = pts.map(p => (p[0] - mx) * ux + (p[1] - my) * uy);
  let tmax = -Infinity, tmin = Infinity;
  for (const v of t) { if (v > tmax) tmax = v; if (v < tmin) tmin = v; }
  const extent = tmax - tmin;
  if (extent < 5.0) return false;
  let length = 0.0;
  let a = pts[0];
  for (let i = 1; i < n; i++) {
    const b = pts[i];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
    a = b;
  }
  if (length < MIN_LENGTH_RATIO * extent) return false;
  // Direction reversals along the main axis, with hysteresis so jitter is ignored.
  const h = Math.max(extent * 0.15, 1.5);
  let direction = 0;
  let ext = t[0];
  let reversals = 0;
  for (let i = 1; i < t.length; i++) {
    const v = t[i];
    if (direction === 0) {
      if (Math.abs(v - ext) >= h) {
        direction = v > ext ? 1 : -1;
        ext = v;
      }
    } else if (direction === 1) {
      if (v > ext) ext = v;
      else if (ext - v >= h) { reversals++; direction = -1; ext = v; }
    } else {
      if (v < ext) ext = v;
      else if (v - ext >= h) { reversals++; direction = 1; ext = v; }
    }
  }
  if (reversals < MIN_REVERSALS) return false;
  if (loose) return true;
  // How much the pen turns, against how far the stroke travels. Writing turns a lot too (a cursive
  // "tro" goes round more than twice) but moves on as it does, about a letter for every turn or
  // two; a scratch-out turns over and over in the same place. The travel is counted in cells as
  // wide as the stroke is tall, so a scribble over a short word and one over a long line are
  // judged alike. (Not in A or B: there the reversals above decided alone, and handwriting that
  // doubled back on itself was erased.)
  let minT = Infinity, maxT = -Infinity;
  for (const p of pts) {
    const v = -(p[0] - mx) * uy + (p[1] - my) * ux;
    if (v < minT) minT = v; if (v > maxT) maxT = v;
  }
  const height = Math.max(maxT - minT, extent * 0.15, 1.0);
  const cells = Math.max(1, extent / height);
  const turn = turning(pts, Math.max(extent * 0.03, 0.5));
  if (turn < MIN_TURNING) return false;
  // Going round in place, or sweeping to and fro over the same ground many times over.
  return turn / cells >= MIN_TURNING_PER_CELL || length / (extent + height) >= MIN_SWEEPS;
}

/** The total turning of a path, in radians, measured along it at even steps so that the
 * tremor of the hand does not count. @param {Pt[]} pts @param {number} step */
export function turning(pts, step) {
  /** @type {number[][]} */
  const even = [pts[0]];
  let left = step;
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let seg = Math.hypot(bx - ax, by - ay);
    while (seg >= left) {
      const k = left / seg;
      ax += (bx - ax) * k; ay += (by - ay) * k;
      even.push([ax, ay]);
      seg -= left;
      left = step;
    }
    left -= seg;
  }
  let total = 0, prev = null;
  for (let i = 1; i < even.length; i++) {
    const a = Math.atan2(even[i][1] - even[i - 1][1], even[i][0] - even[i - 1][0]);
    if (prev !== null) {
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += Math.abs(d);
    }
    prev = a;
  }
  return total;
}

/** Items a scribble covers: mostly inside its hull, or crossed repeatedly. */
export function scribbleTargets(pts, items) {
  const sc = decimate(pts, 150);
  const bb = bboxOf(sc);
  const hull = convexHull(sc);
  if (hull.length < 3) return [];
  const out = [];
  for (const it of items) {
    if ((it.kind !== 's' && it.kind !== 'h') || !intersects(it.bbox, bb)) continue;
    const pl = decimate(it.polyline(), 150);
    if (pl.length === 1) {
      if (inPolygon(hull, pl[0][0], pl[0][1])) out.push(it);
      continue;
    }
    let total = 0, inside = 0;
    let a = pl[0];
    for (let i = 1; i < pl.length; i++) {
      const b = pl[i];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-6;
      total += seg;
      if (inPolygon(hull, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) inside += seg;
      a = b;
    }
    const cover = inside / total;
    if (cover >= 0.35) out.push(it);
    else if (cover >= 0.08 && crossings(sc, pl, 4) >= 4) out.push(it);
  }
  return out;
}

function crossings(aPts, bPts, enough) {
  let count = 0;
  let a0 = aPts[0];
  for (let i = 1; i < aPts.length; i++) {
    const a1 = aPts[i];
    let b0 = bPts[0];
    for (let j = 1; j < bPts.length; j++) {
      const b1 = bPts[j];
      if (segsCross(a0, a1, b0, b1)) {
        count++;
        if (count >= enough) return count;
      }
      b0 = b1;
    }
    a0 = a1;
  }
  return count;
}

/** Whether any part of an item lies in a region given by its box and a point test. */
function touching(it, box, inside) {
  if (!intersects(it.bbox, box)) return false;
  const line = it.polyline();
  const pts = line && line.length > 1 ? densify(line, 3.0) : it.sample();
  return pts.some(p => inside(p[0], p[1]));
}

/** Items the lasso touches: having any part inside it selects the whole item. */
export function lassoPick(poly, items) {
  poly = decimate(poly, 120);
  if (poly.length < 3) return [];
  const bb = bboxOf(poly);
  const out = [];
  for (const it of items) {
    if (touching(it, bb, (x, y) => inPolygon(poly, x, y))) {
      out.push(it);
    } else if ((it.kind === 'i' || it.kind === 't') && intersects(it.bbox, bb)) {
      // Pictures and text boxes have an inside: a loop drawn over one counts too.
      const [x0, y0, x1, y1] = it.bbox;
      if (poly.some(p => x0 <= p[0] && p[0] <= x1 && y0 <= p[1] && p[1] <= y1)) out.push(it);
    }
  }
  return out;
}

export function rectPick(box, items) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'i' || it.kind === 't') {
      if (intersects(it.bbox, box)) out.push(it);
    } else if (touching(it, box, (x, y) => box[0] <= x && x <= box[2] && box[1] <= y && y <= box[3])) {
      out.push(it);
    }
  }
  return out;
}

// -- partial erasing --------------------------------------------------------

/** Insert interpolated samples so no segment is longer than step. @param {Pt[]} pts @returns {Pt[]} */
export function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    const a = out[out.length - 1];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d > step) {
      const n = Math.floor(d / step) + 1;
      for (let k = 1; k < n; k++) {
        const t = k / n;
        // Outlines of shapes, pictures and text are plain (x, y); ink has a pressure too.
        const m = Math.min(a.length, b.length);
        const q = new Array(m);
        for (let j = 0; j < m; j++) q[j] = a[j] + (b[j] - a[j]) * t;
        out.push(q);
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * Cut the part of a stroke within r of segment a-b out of it.
 *
 * Returns [surviving runs of points, bounding box of the part that changed],
 * or null when nothing was touched. Only the segments next to the eraser are
 * resampled, so the rest of the stroke keeps its exact shape.
 * @param {Pt[]} pts
 * @returns {[Pt[][], Box] | null}
 */
export function eraseRuns(pts, ax, ay, bx, by, r) {
  const r2 = r * r;
  const n = pts.length;
  const inside = pts.map(p => dist2Seg(p[0], p[1], ax, ay, bx, by) <= r2);
  const step = Math.max(r * 0.4, 0.3);
  const ea = [ax, ay], eb = [bx, by];
  /** @type {Pt[][]} */
  const runs = [];
  /** @type {Pt[]} */
  let run = [];
  let cut = inside[0];
  let lo = inside[0] ? 0 : n, hi = inside[0] ? 0 : -1;
  if (!inside[0]) run.push(pts[0]);
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!(inside[i - 1] || inside[i]
      || dist2Seg(ax, ay, a[0], a[1], b[0], b[1]) <= r2
      || dist2Seg(bx, by, a[0], a[1], b[0], b[1]) <= r2
      || segsCross(a, b, ea, eb))) {
      run.push(b);
      continue;
    }
    lo = Math.min(lo, i - 1); hi = Math.max(hi, i);
    const k = Math.max(1, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / step) + 1);
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      const q = j === k ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (dist2Seg(q[0], q[1], ax, ay, bx, by) <= r2) {
        cut = true;
        if (run.length) { runs.push(run); run = []; }
      } else {
        run.push(q);
      }
    }
  }
  if (!cut) return null;
  if (run.length) runs.push(run);
  return [runs, bboxOf(pts.slice(Math.max(0, lo - 2), hi + 3))];
}

// -- hold to snap to a shape ------------------------------------------------

/**
 * Classify a freehand stroke as ['line' | 'rect' | 'ellipse', x0, y0, x1, y1], or null.
 * @param {Pt[]} pts
 */
export function recognizeShape(pts) {
  const n = pts.length;
  if (n < 6) return null;
  let length = 0.0;
  let a = pts[0];
  for (let i = 1; i < n; i++) {
    const b = pts[i];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
    a = b;
  }
  const first = pts[0], last = pts[n - 1];
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (length < 8) return null;
  if (chord > 0.88 * length) return ['line', first[0], first[1], last[0], last[1]];
  if (chord > 0.25 * length) return null;  // neither straight nor closed
  const [x0, y0, x1, y1] = bboxOf(pts);
  const w = x1 - x0, h = y1 - y0;
  if (Math.min(w, h) < 4) return null;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = w / 2, ry = h / 2;
  let eErr = 0, rErr = 0;
  for (const p of pts) {
    eErr += Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1);
    rErr += Math.min(p[0] - x0, x1 - p[0], p[1] - y0, y1 - p[1]) / Math.min(w, h);
  }
  eErr /= n; rErr /= n;
  if (rErr < 0.07 && rErr < eErr) return ['rect', x0, y0, x1, y1];
  if (eErr < 0.16) return ['ellipse', x0, y0, x1, y1];
  return null;
}
