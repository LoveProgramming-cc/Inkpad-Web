// @ts-check
// Pictures: decoding, shrinking, turning. PORTING.md 7.11.
import { createCanvas, context2d, toPng as canvasToPng, release } from './canvas.js';
import { setImageRotator } from '../core/items.js';

/** Decode a picture so it can be drawn. @param {Blob} blob @returns {Promise<ImageBitmap>} */
export function decode(blob) {
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

/** Give every picture in `items` its decoded bitmap (and tell `done` for each one that came in).
 * @param {any[]} items @param {(item: any) => void} [done] */
export async function ensureBitmaps(items, done) {
  await Promise.all(items.filter(it => it.kind === 'i' && !it.bitmap).map(async it => {
    try {
      it.bitmap = await decode(it.data);
      done?.(it);
    } catch { /* a picture that cannot be read stays blank */ }
  }));
}

/**
 * Any picture as PNG, turned the right way up by its EXIF data and no larger than `limit` pixels
 * on its longer side (B: GdkPixbuf import).
 * @param {Blob} blob @param {number} [limit]
 * @returns {Promise<{png: Blob, w: number, h: number}>}
 */
export async function toPng(blob, limit = 2000) {
  const bitmap = await decode(blob);
  try {
    const k = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
    const canvas = createCanvas(w, h);
    context2d(canvas).drawImage(bitmap, 0, 0, w, h);
    const png = await canvasToPng(canvas);
    release(canvas);
    return { png, w, h };
  } finally {
    bitmap.close();
  }
}

/** Turn a PNG k quarter turns clockwise and encode it again (B: Image.rotated). @param {Blob} blob @param {number} k */
export async function rotatePng(blob, k) {
  const bitmap = await decode(blob);
  try {
    const sw = bitmap.width, sh = bitmap.height;
    const odd = k % 2 === 1;
    const canvas = createCanvas(odd ? sh : sw, odd ? sw : sh);
    const ctx = context2d(canvas);
    const [tx, ty] = /** @type {Record<number, number[]>} */ ({ 1: [sh, 0], 2: [sw, sh], 3: [0, sw] })[k % 4] ?? [0, 0];
    ctx.translate(tx, ty);
    ctx.rotate(k * Math.PI / 2);
    ctx.drawImage(bitmap, 0, 0);
    const png = await canvasToPng(canvas);
    release(canvas);
    return png;
  } finally {
    bitmap.close();
  }
}

setImageRotator(rotatePng);
