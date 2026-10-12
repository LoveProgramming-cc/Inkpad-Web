// @ts-check
// A notebook's large PDFs and pictures are not part of the file that is uploaded for it. They
// never change, and they are nearly all of a large notebook's size, so each is kept on Drive
// once, as a file of its own named after its SHA-256, and the notebook's file lists them.
// Translated from B:gdrive.py `_slim` / `_fatten` / `_stripped` and A:Sync.swift. Everything
// works on Blob slices: nothing here reads a whole notebook into memory (PORTING.md 7.7).
import { ZipReader, ZipWriter } from '../core/zip.js';
import { sha256Blob } from '../core/hash.js';
import { tr, trf } from '../core/i18n.js';
import { DriveError } from './errors.js';

export const config = {
  blobMin: 32 * 1024,           // a PDF or picture at least this big is kept on Drive as a file of its own
  checkpoint: 10.0,             // seconds of transfers after which a sync notes, in the index, how far it has got
  thoroughEvery: 6 * 3600.0,    // seconds after which a sync checks the index against Drive unasked
};

export const BLOBS = 'blobs.json';   // in an uploaded notebook: {name in the zip: name of the file on Drive}
export const FORMAT = 3;             // of the index. 2: notebooks are uploaded without their blobs; 3: blobs named by SHA-256
export const SHA = 'blob-sha256-';

/** @param {import('../core/zip.js').ZipEntry} e */
export function isBlob(e) {
  return (e.name.startsWith('pdf/') || e.name.startsWith('img/')) && e.size >= config.blobMin;
}

// Before, in index format 2, a blob's name was the zip's CRC-32 and the size, which is not
// enough to say that two files are the same. Notebooks uploaded then still list those names,
// and are read; whatever is uploaded now uses the new ones.
/** @param {import('../core/zip.js').ZipEntry} e */
export function oldName(e) {
  return 'blob-' + e.crc.toString(16).padStart(8, '0') + '-' + e.size;
}

/** @param {Blob} blob */
export async function shaName(blob) {
  return SHA + await sha256Blob(blob);
}

/** What was found of one blob in a notebook the last time: [CRC, size, name of the blob].
 * @param {Record<string, any>|undefined|null} seen @param {import('../core/zip.js').ZipEntry} e @returns {string|null} */
function named(seen, e) {
  const was = seen?.[e.name];
  if (Array.isArray(was) && was.length === 3 && was[0] === e.crc && was[1] === e.size) return was[2];
  return null;
}

/**
 * The notebook as it is uploaded: without its large PDFs and pictures, and with a list of them
 * instead. Those for which `have(name)` is false come back in `parts`, to be uploaded first.
 * Returns the file's sign, the slim notebook, those parts, and what to pass as `seen` the next time.
 *
 * `seen` is what was found in this notebook the last time: {name in the zip: [CRC, size, name of
 * the blob]}. A PDF that is still in the same place with the same CRC and size is the one that
 * was there then, and is not read through again to name it; so sending a line written in a
 * 200 MB book does not mean reading the book.
 *
 * @param {Blob} blob @param {string} sign the sign the file had when `blob` was read
 * @param {{seen?: Record<string, any>|null, have: (name: string) => boolean}} o
 * @returns {Promise<{stat: string, slim: Blob, parts: Map<string, Blob>, found: Record<string, any>}>}
 */
export async function slim(blob, sign, { seen = null, have }) {
  const z = await ZipReader.open(blob);
  const out = new ZipWriter();
  /** @type {Record<string, string>} */
  const listed = {};
  /** @type {Map<string, Blob>} */
  const parts = new Map();
  /** @type {Record<string, any>} */
  const found = {};
  const last = new Map(z.entries.map((e, i) => [e.name, i]));   // a later entry of the same name wins
  for (const [i, e] of z.entries.entries()) {
    if (e.name === BLOBS || last.get(e.name) !== i) continue;
    if (!isBlob(e)) {
      out.addRaw(e.name, { method: e.method, crc: e.crc, size: e.size, raw: await z.raw(e) });
      continue;
    }
    const name = named(seen, e) ?? await shaName(await z.blobOf(e.name));
    listed[e.name] = name;
    found[e.name] = [e.crc, e.size, name];
    if (!parts.has(name) && !have(name)) parts.set(name, await z.blobOf(e.name));
  }
  if (Object.keys(listed).length) await out.add(BLOBS, JSON.stringify(listed));
  return { stat: sign, slim: out.finish(), parts, found };
}

/**
 * Make a downloaded notebook whole again: its large PDFs and pictures are taken from the copy
 * of it that is here already (`have`) where that has them, and fetched with `fetch(name)` otherwise.
 * @param {Blob} part @param {Blob|null} have @param {Record<string, any>|null|undefined} seen
 * @param {(name: string) => Promise<Blob>} fetch
 * @returns {Promise<Blob>}
 */
export async function fatten(part, have, seen, fetch) {
  const z = await ZipReader.open(part);
  if (!z.has(BLOBS)) return part;   // uploaded whole, by an earlier version
  /** @type {Record<string, string>} */
  const listed = JSON.parse(await z.text(BLOBS));
  /** @type {ZipReader|null} */
  let old = null;
  if (have) { try { old = await ZipReader.open(have); } catch { old = null; } }
  const mine = old ? old.entries.filter(isBlob) : [];
  const byOld = new Map(mine.map(e => [oldName(e), e]));
  /** @type {Map<string, import('../core/zip.js').ZipEntry>|null} */
  let bySha = null;   // worked out when first asked for: it means reading every one of them
  /** @param {string} blob */
  const local = async blob => {
    if (!blob.startsWith(SHA)) return byOld.get(blob);
    if (bySha === null) {
      bySha = new Map();
      for (const e of mine) bySha.set(named(seen, e) ?? await shaName(await /** @type {ZipReader} */ (old).blobOf(e.name)), e);
    }
    return bySha.get(blob);
  };
  const out = new ZipWriter();
  for (const e of z.entries) {
    if (e.name !== BLOBS) out.addRaw(e.name, { method: e.method, crc: e.crc, size: e.size, raw: await z.raw(e) });
  }
  for (const name of Object.keys(listed).sort()) {
    const blob = listed[name];
    const e = old ? await local(blob) : undefined;
    if (old && e) {
      out.addRaw(name, { method: e.method, crc: e.crc, size: e.size, raw: await old.raw(e) });
    } else {
      const data = await fetch(blob);
      if (blob.startsWith(SHA) && (await shaName(data)) !== blob) {
        throw new DriveError(trf('从云端下载的 PDF 或图片（%s）内容不对，没有使用它。请再同步一次。', blob.slice(0, 24)));
      }
      // Stored, as the app itself writes them: they are compressed already.
      await out.add(name, data, { compress: false });
    }
  }
  return out.finish();
}

/**
 * Whether a notebook in the library is one as it is uploaded, without its large PDFs and
 * pictures. That is never meant to be: it is what a download that was cut off before those had
 * come left behind, or what a version of the app from before they were kept apart put in place
 * of the whole notebook. It cannot be opened, and must not be taken for a notebook that is up
 * to date, or be sent anywhere. @param {Blob} blob
 */
export async function stripped(blob) {
  try { return (await ZipReader.open(blob)).has(BLOBS); } catch { return false; }
}

/** @param {{find(name: string, parent: string): Promise<string|null>, download(id: string): Promise<Blob>}} drive
 * @param {string} rootId @param {() => Record<string, string>} names */
export function fetcher(drive, rootId, names) {
  return async (/** @type {string} */ blob) => {
    const id = names()[blob] || await drive.find(blob, rootId);
    if (!id) throw new DriveError(trf('云端缺少这本笔记里的一个 PDF 或图片（%s）。请在仍有这本笔记的设备上同步一次。', blob));
    return drive.download(id);
  };
}
