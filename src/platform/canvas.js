// @ts-check
// Making canvases and getting pictures in and out of them.

/** A canvas of w x h pixels: OffscreenCanvas where there is one. @param {number} w @param {number} h */
export function createCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** @param {HTMLCanvasElement|OffscreenCanvas} c @param {boolean} [alpha] @returns {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} */
export function context2d(c, alpha = true) {
  const ctx = c.getContext('2d', { alpha });
  if (!ctx) throw new Error('the browser could not make a canvas of that size');
  return /** @type {any} */ (ctx);
}

/** Free a canvas's memory now: Safari does not give it back until the size is zero (R9).
 * @param {HTMLCanvasElement|OffscreenCanvas} c */
export function release(c) { c.width = 0; c.height = 0; }

/** @param {HTMLCanvasElement|OffscreenCanvas} c @returns {Promise<Blob>} */
export function toPng(c) {
  if ('convertToBlob' in c) return c.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode the picture'))), 'image/png'));
}
