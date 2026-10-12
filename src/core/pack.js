// @ts-check
// Stroke point packing (B:model.py `pack_points` / `unpack_points`) and base64 helpers.
//
// Byte stream = float64LE(x0) + float64LE(y0), then for every point (the first included)
// zigzag-varint(dx) + zigzag-varint(dy) + one pressure byte. The steps are between
// neighbouring points in hundredths of a point; the first point's step is 0.
// Whiteboard coordinates times 100 exceed 2^31, so no 32-bit bit operations here.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Uint8Array(128).fill(255);
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  const n = bytes.length;
  const parts = [];
  let chunk = '';
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  if (n - i === 1) {
    const v = bytes[i] << 16;
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] + '==';
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '=';
  }
  parts.push(chunk);
  return parts.join('');
}

/** @param {string} text @returns {Uint8Array} */
export function base64ToBytes(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '=' || text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
  const out = new Uint8Array(Math.floor(end * 3 / 4));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? B64_REV[c] : 255;
    if (v === 255) continue;  // ignore whitespace and anything else, like Python's b64decode
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** Python's round(): halves go to the even neighbour, so the bytes match B's exactly. @param {number} x */
export function pyRound(x) {
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
  return Math.round(x);
}

/** @param {number} n @param {number[]} out */
function zig(n, out) {
  n = n >= 0 ? 2 * n : -2 * n - 1;
  for (;;) {
    const b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) out.push(b | 0x80);
    else { out.push(b); return; }
  }
}

/**
 * @param {ArrayLike<number>[]} pts  points [x, y, pressure]
 * @returns {string}
 */
export function packPoints(pts) {
  if (!pts || pts.length === 0) return '';
  const out = [];
  const head = new Uint8Array(16);
  const dv = new DataView(head.buffer);
  dv.setFloat64(0, pts[0][0], true);
  dv.setFloat64(8, pts[0][1], true);
  for (let i = 0; i < 16; i++) out.push(head[i]);
  let px = pyRound(pts[0][0] * 100), py = pyRound(pts[0][1] * 100);
  for (const p of pts) {
    const cx = pyRound(p[0] * 100), cy = pyRound(p[1] * 100);
    zig(cx - px, out);
    zig(cy - py, out);
    out.push(Math.max(0, Math.min(255, pyRound(p[2] * 255))));
    px = cx; py = cy;
  }
  return bytesToBase64(Uint8Array.from(out));
}

/** @param {string} text @returns {number[][]} points [x, y, pressure] */
export function unpackPoints(text) {
  const data = base64ToBytes(text);
  if (data.length === 0) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const x0 = dv.getFloat64(0, true), y0 = dv.getFloat64(8, true);
  let px = pyRound(x0 * 100), py = pyRound(y0 * 100);
  const pts = [];
  let i = 16;
  const n = data.length;
  while (i < n) {
    const step = [0, 0];
    for (let k = 0; k < 2; k++) {
      let value = 0, mul = 1;
      for (;;) {
        if (i >= n) throw new Error('truncated stroke data');
        const c = data[i++];
        value += (c & 0x7f) * mul;
        mul *= 128;
        if (!(c & 0x80)) break;
      }
      step[k] = value % 2 === 1 ? -(value + 1) / 2 : value / 2;
    }
    px += step[0]; py += step[1];
    if (i >= n) throw new Error('truncated stroke data');
    pts.push([px / 100, py / 100, data[i] / 255]);
    i++;
  }
  if (pts.length) pts[0] = [x0, y0, pts[0][2]];
  return pts;
}
