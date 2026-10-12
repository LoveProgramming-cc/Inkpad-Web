// Write into sw.js the list of files the app is made of and a version that changes when any of
// them does:  node tools/build_sw.mjs  (with --check: only say whether sw.js is up to date).
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOP = ['index.html', 'oauth.html', 'manifest.webmanifest'];
const DIRS = ['css', 'src', 'icons'];
// Fetched as pdf.js meets them, and kept then (hundreds of small files); licences are not code.
const SKIP = [/^src\/vendor\/pdfjs\/(cmaps|standard_fonts)\//, /(^|\/)(LICENSE(\.md)?|VERSIONS\.txt|\.DS_Store)$/];

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...await walk(rel)); else out.push(rel);
  }
  return out;
}

/** The block of sw.js between the markers, as it should be. */
export async function precacheBlock() {
  const files = [...TOP];
  for (const d of DIRS) files.push(...await walk(d));
  const list = files.filter(f => !SKIP.some(re => re.test(f))).sort();
  const hash = createHash('sha256');
  for (const f of list) { hash.update(f + '\0'); hash.update(await readFile(join(root, f))); }
  // The part of sw.js outside the block counts too: a changed worker is a new version.
  hash.update((await readFile(join(root, 'sw.js'), 'utf8')).replace(BLOCK, ''));
  const version = hash.digest('hex').slice(0, 12);
  return `/* precache:begin */\nconst VERSION = '${version}';\nconst FILES = ${JSON.stringify(['./', ...list], null, 1)};\n/* precache:end */`;
}

const BLOCK = /\/\* precache:begin \*\/[\s\S]*?\/\* precache:end \*\//;

/** @returns {Promise<{current: string, wanted: string}>} */
export async function swState() {
  const current = await readFile(join(root, 'sw.js'), 'utf8');
  return { current, wanted: current.replace(BLOCK, () => '\0').replace('\0', await precacheBlock()) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { current, wanted } = await swState();
  if (process.argv.includes('--check')) {
    if (current !== wanted) { console.error('sw.js is out of date: run node tools/build_sw.mjs'); process.exit(1); }
  } else if (current !== wanted) {
    await writeFile(join(root, 'sw.js'), wanted);
    console.log('sw.js updated');
  }
}
