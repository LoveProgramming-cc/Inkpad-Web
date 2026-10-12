// @ts-check
// A minimal zip reader and writer on Blobs: stored and deflated entries, no zip64 files.
// Translated from A:Model/Zip.swift. Reads whatever Python's zipfile writes, including the
// zip64 local headers that B's `_fatten` produces (sizes are always taken from the central
// directory, never from the local header). Nothing here reads a whole archive into memory:
// entries are cut out with Blob.slice().
import { Crc32, feedBlob } from './hash.js';

export class ZipError extends Error {}

/**
 * @typedef {object} ZipEntry
 * @property {string} name
 * @property {number} flags
 * @property {number} method   0 stored, 8 deflate
 * @property {number} crc
 * @property {number} compSize
 * @property {number} size
 * @property {number} offset   of the local header
 */

const LIMIT = 0xffffffff;

/** @param {Blob} blob @returns {Promise<Blob>} */
export async function inflate(blob) {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
}

/** @param {Blob} blob @returns {Promise<Blob>} */
export async function deflate(blob) {
  return new Response(blob.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob();
}

/** @param {Blob} blob */
async function bytesOf(blob) { return new Uint8Array(await blob.arrayBuffer()); }

export class ZipReader {
  /** @param {Blob} blob @param {ZipEntry[]} entries */
  constructor(blob, entries) {
    this.blob = blob;
    this.entries = entries;
    /** @type {Map<string, number>} */
    this.index = new Map();
    entries.forEach((e, i) => this.index.set(e.name, i));  // a later entry of the same name wins
  }

  /** @param {Blob} blob @returns {Promise<ZipReader>} */
  static async open(blob) {
    const n = blob.size;
    if (n < 22) throw new ZipError('not a zip file');
    const tailStart = Math.max(0, n - 22 - 65535);
    const tail = await bytesOf(blob.slice(tailStart, n));
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError('not a zip file');
    const t = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const count = t.getUint16(eocd + 10, true);
    const cdSize = t.getUint32(eocd + 12, true);
    const cdOffset = t.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === LIMIT || cdOffset === LIMIT) throw new ZipError('zip64 archives are not supported');
    if (cdOffset + cdSize > n) throw new ZipError('damaged zip directory');
    const cd = await bytesOf(blob.slice(cdOffset, cdOffset + cdSize));
    const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const dec = new TextDecoder('utf-8');
    /** @type {ZipEntry[]} */
    const entries = [];
    let o = 0;
    for (let k = 0; k < count; k++) {
      if (o + 46 > cd.length || dv.getUint32(o, true) !== 0x02014b50) throw new ZipError('damaged zip directory');
      const nameLen = dv.getUint16(o + 28, true), extraLen = dv.getUint16(o + 30, true), commentLen = dv.getUint16(o + 32, true);
      if (o + 46 + nameLen + extraLen > cd.length) throw new ZipError('damaged zip directory');
      let compSize = dv.getUint32(o + 20, true), size = dv.getUint32(o + 24, true), offset = dv.getUint32(o + 42, true);
      if (compSize === LIMIT || size === LIMIT || offset === LIMIT) {
        // Fields that do not fit in 32 bits live in the zip64 extra block, in this order.
        let e = o + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
          const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
          if (id === 1) {
            let p = e + 4;
            const u64 = () => { const v = Number(dv.getBigUint64(p, true)); p += 8; return v; };
            if (size === LIMIT) size = u64();
            if (compSize === LIMIT) compSize = u64();
            if (offset === LIMIT) offset = u64();
            break;
          }
          e += 4 + len;
        }
      }
      const name = dec.decode(cd.subarray(o + 46, o + 46 + nameLen));
      entries.push({
        name, flags: dv.getUint16(o + 8, true), method: dv.getUint16(o + 10, true),
        crc: dv.getUint32(o + 16, true), compSize, size, offset,
      });
      o += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipReader(blob, entries);
  }

  get names() { return this.entries.map(e => e.name); }
  /** @param {string} name */
  has(name) { return this.index.has(name); }
  /** @param {string} name @returns {ZipEntry|undefined} */
  entry(name) { const i = this.index.get(name); return i === undefined ? undefined : this.entries[i]; }

  /** Where the entry's data starts in the file. @param {ZipEntry} e */
  async dataStart(e) {
    const head = await bytesOf(this.blob.slice(e.offset, e.offset + 30));
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new ZipError('damaged zip entry');
    const start = e.offset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    if (start + e.compSize > this.blob.size) throw new ZipError('damaged zip entry');
    return start;
  }

  /** The entry's bytes as they are in the file (still compressed). @param {ZipEntry} e */
  async raw(e) {
    const s = await this.dataStart(e);
    return this.blob.slice(s, s + e.compSize);
  }

  /** The entry's contents. Stored entries come back as a slice, so large ones are never copied.
   * @param {string} name @returns {Promise<Blob>} */
  async blobOf(name) {
    const e = this.entry(name);
    if (!e) throw new ZipError('missing ' + name);
    const raw = await this.raw(e);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new ZipError('unsupported compression');
    let out;
    try { out = e.size === 0 ? new Blob([]) : await inflate(raw); } catch { throw new ZipError('damaged zip data'); }
    if (out.size !== e.size) throw new ZipError('damaged zip data');
    return out;
  }

  /** @param {string} name @returns {Promise<Uint8Array>} */
  async bytes(name) { return bytesOf(await this.blobOf(name)); }
  /** @param {string} name @returns {Promise<string>} */
  async text(name) { return new TextDecoder('utf-8').decode(await this.bytes(name)); }

  /** Checks one entry's CRC against its data (what Python's testzip does). @param {ZipEntry} e */
  async crcOk(e) {
    const c = new Crc32();
    await feedBlob(await this.blobOf(e.name), [c]);
    return c.digest() === e.crc;
  }
}

function dosStamp(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

export class ZipWriter {
  /** @param {Date} [now] the time stamped on every entry */
  constructor(now = new Date()) {
    /** @type {(Blob|Uint8Array)[]} */
    this.parts = [];
    /** @type {Uint8Array[]} */
    this.central = [];
    this.offset = 0;
    this.count = 0;
    this.stamp = dosStamp(now);
  }

  /**
   * Adds an entry, deflated when that makes it smaller. Pass compress: false to store it.
   * @param {string} name
   * @param {Uint8Array|Blob|string} data
   */
  async add(name, data, { compress = true } = {}) {
    const blob = typeof data === 'string' ? new Blob([data]) : data instanceof Blob ? data : new Blob([data]);
    const crc = new Crc32();
    await feedBlob(blob, [crc]);
    if (compress && blob.size > 32) {
      const packed = await deflate(blob);
      if (packed.size < blob.size) return this.addRaw(name, { method: 8, crc: crc.digest(), size: blob.size, raw: packed });
    }
    return this.addRaw(name, { method: 0, crc: crc.digest(), size: blob.size, raw: blob });
  }

  /**
   * Adds an entry whose bytes are already in their stored form (copied from another zip).
   * @param {string} name
   * @param {{method: number, crc: number, size: number, raw: Blob|Uint8Array}} e
   */
  addRaw(name, { method, crc, size, raw }) {
    const rawSize = raw instanceof Blob ? raw.size : raw.length;
    if (rawSize >= LIMIT || size >= LIMIT || this.offset >= LIMIT) throw new ZipError('file too large');
    const nameBytes = new TextEncoder().encode(name);
    let flags = 0;
    for (const b of nameBytes) if (b > 127) { flags = 0x800; break; }
    const local = new Uint8Array(30 + nameBytes.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, flags, true); l.setUint16(8, method, true);
    l.setUint16(10, this.stamp.time, true); l.setUint16(12, this.stamp.date, true);
    l.setUint32(14, crc, true); l.setUint32(18, rawSize, true); l.setUint32(22, size, true);
    l.setUint16(26, nameBytes.length, true); l.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const cen = new Uint8Array(46 + nameBytes.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x031e, true); c.setUint16(6, 20, true);
    c.setUint16(8, flags, true); c.setUint16(10, method, true);
    c.setUint16(12, this.stamp.time, true); c.setUint16(14, this.stamp.date, true);
    c.setUint32(16, crc, true); c.setUint32(20, rawSize, true); c.setUint32(24, size, true);
    c.setUint16(28, nameBytes.length, true);  // extra, comment, disk, internal attrs: all zero
    c.setUint32(38, (0o100644 << 16) >>> 0, true); c.setUint32(42, this.offset, true);
    cen.set(nameBytes, 46);
    this.parts.push(local, raw);
    this.central.push(cen);
    this.offset += local.length + rawSize;
    this.count++;
  }

  /** A directory entry (name ends with "/"), as the library archive wants. @param {string} name */
  addDir(name) {
    this.addRaw(name.endsWith('/') ? name : name + '/', { method: 0, crc: 0, size: 0, raw: new Uint8Array(0) });
  }

  /** @returns {Blob} */
  finish() {
    let cdSize = 0;
    for (const c of this.central) cdSize += c.length;
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.count, true); e.setUint16(10, this.count, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, this.offset, true);
    if (this.count > 0xfffe || this.offset + cdSize >= LIMIT) throw new ZipError('file too large');
    return new Blob([...this.parts, ...this.central, end], { type: 'application/zip' });
  }
}
