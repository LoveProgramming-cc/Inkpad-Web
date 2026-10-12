// @ts-check
// Random ids. crypto.randomUUID exists only in secure contexts (https, localhost); a page opened
// from another machine over plain http has crypto.getRandomValues and nothing more.

/** A version 4 UUID, lower case with dashes. @returns {string} */
export function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 32 hex digits: what documents and blobs are named by. @returns {string} */
export function hexId() {
  return uuid().replaceAll('-', '');
}
