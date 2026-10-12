// @ts-check
// Streaming MD5, SHA-256 and CRC-32. WebCrypto has no MD5 and its digest() cannot be fed in
// pieces, and notebooks may hold hundreds of megabytes, so these are written out here.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** @param {Uint8Array} bytes */
export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

/** Common buffering for the 64-byte block hashes. */
class BlockHash {
  /** @param {boolean} bigEndianLength */
  constructor(bigEndianLength) {
    this.buf = new Uint8Array(64);
    this.fill = 0;
    this.total = 0;
    this.bigEndianLength = bigEndianLength;
    this.done = false;
  }

  /** @param {Uint8Array} data @returns {this} */
  update(data) {
    if (this.done) throw new Error('hash already finished');
    this.total += data.length;
    let i = 0;
    const n = data.length;
    if (this.fill > 0) {
      const take = Math.min(64 - this.fill, n);
      this.buf.set(data.subarray(0, take), this.fill);
      this.fill += take;
      i = take;
      if (this.fill === 64) { this._block(this.buf, 0); this.fill = 0; }
    }
    for (; i + 64 <= n; i += 64) this._block(data, i);
    if (i < n) { this.buf.set(data.subarray(i), 0); this.fill = n - i; }
    return this;
  }

  /** @returns {Uint8Array} */
  digest() {
    if (!this.done) {
      const bits = this.total * 8;
      const lo = bits >>> 0;
      const hi = Math.floor(bits / 4294967296) >>> 0;
      const padLen = (this.fill < 56 ? 56 : 120) - this.fill;
      const pad = new Uint8Array(padLen + 8);
      pad[0] = 0x80;
      const dv = new DataView(pad.buffer);
      if (this.bigEndianLength) { dv.setUint32(padLen, hi); dv.setUint32(padLen + 4, lo); }
      else { dv.setUint32(padLen, lo, true); dv.setUint32(padLen + 4, hi, true); }
      const total = this.total;
      this.update(pad);
      this.total = total;
      this.done = true;
    }
    return this._out();
  }

  hex() { return toHex(this.digest()); }

  /** @param {Uint8Array} _b @param {number} _o */
  _block(_b, _o) { throw new Error('abstract'); }
  _out() { throw new Error('abstract'); }
}

// -- MD5 --------------------------------------------------------------------

const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

export class Md5 extends BlockHash {
  constructor() {
    super(false);
    this.h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
    this.w = new Uint32Array(16);
  }

  _block(b, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = o + i * 4;
      w[i] = b[j] | (b[j + 1] << 8) | (b[j + 2] << 16) | (b[j + 3] << 24);
    }
    let a = this.h[0], bb = this.h[1], c = this.h[2], d = this.h[3];
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
      else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
      f = (f + a + MD5_K[i] + w[g]) | 0;
      a = d; d = c; c = bb;
      const s = MD5_S[(i >> 4) * 4 + (i & 3)];
      bb = (bb + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    this.h[0] += a; this.h[1] += bb; this.h[2] += c; this.h[3] += d;
  }

  _out() {
    const out = new Uint8Array(16);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) dv.setUint32(i * 4, this.h[i], true);
    return out;
  }
}

// -- SHA-256 ----------------------------------------------------------------

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 extends BlockHash {
  constructor() {
    super(true);
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Uint32Array(64);
  }

  _block(b, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = o + i * 4;
      w[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b2, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b2; b2 = a; a = (t1 + t2) | 0;
    }
    const hh = this.h;
    hh[0] += a; hh[1] += b2; hh[2] += c; hh[3] += d; hh[4] += e; hh[5] += f; hh[6] += g; hh[7] += h;
  }

  _out() {
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, this.h[i]);
    return out;
  }
}

// -- CRC-32 -----------------------------------------------------------------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  CRC_TABLE[n] = c;
}

export class Crc32 {
  constructor() { this.value = 0xffffffff; }
  /** @param {Uint8Array} data @returns {this} */
  update(data) {
    let c = this.value;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
    this.value = c;
    return this;
  }
  /** @returns {number} unsigned 32-bit */
  digest() { return (this.value ^ 0xffffffff) >>> 0; }
}

/** One-shot CRC-32 of bytes (like zlib.crc32). @param {Uint8Array} data */
export function crc32(data, prev = 0) {
  const c = new Crc32();
  c.value = (prev ^ 0xffffffff) >>> 0;
  c.value |= 0;
  return c.update(data).digest();
}

/** @param {Uint8Array|string} data */
function bytesOf(data) { return typeof data === 'string' ? new TextEncoder().encode(data) : data; }

/** @param {Uint8Array|string} data */
export function md5Hex(data) { return new Md5().update(bytesOf(data)).hex(); }
/** @param {Uint8Array|string} data */
export function sha256Hex(data) { return new Sha256().update(bytesOf(data)).hex(); }

/**
 * Feed a Blob through any number of hashers without holding it in memory.
 * @param {Blob} blob
 * @param {{update(d: Uint8Array): any}[]} hashers
 */
export async function feedBlob(blob, hashers) {
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const h of hashers) h.update(value);
  }
}

/** @param {Blob} blob @returns {Promise<string>} */
export async function md5Blob(blob) { const h = new Md5(); await feedBlob(blob, [h]); return h.hex(); }
/** @param {Blob} blob @returns {Promise<string>} */
export async function sha256Blob(blob) { const h = new Sha256(); await feedBlob(blob, [h]); return h.hex(); }
/** @param {Blob} blob @returns {Promise<number>} */
export async function crc32Blob(blob) { const h = new Crc32(); await feedBlob(blob, [h]); return h.digest(); }
