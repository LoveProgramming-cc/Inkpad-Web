// @ts-check
// The font that text in an exported PDF is set in (PORTING.md 7.5): chosen by the user from a file or,
// where the browser offers it, from the fonts installed on the system, and kept in kv['export_font'].
import { h } from '../ui/ui.js';
import { showDialog, inform } from '../ui/dialog.js';
import { pickFiles } from '../platform/files.js';
import { tr } from '../core/i18n.js';

/** @param {import('../platform/vfs.js').Vfs} vfs @returns {Promise<{name: string, blob: Blob}|null>} */
export async function getExportFont(vfs) {
  const f = await vfs.kvGet('export_font');
  return f && f.blob ? f : null;
}

/** @param {import('../platform/vfs.js').Vfs} vfs */
export async function clearExportFont(vfs) { await vfs.kvDelete('export_font'); }

/** Only a single .ttf or .otf: collections and variable fonts cannot be embedded as a subset. @param {Blob} blob @returns {Promise<string|null>} what is wrong, or null */
export async function checkFont(blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const tag = String.fromCharCode(...head);
  if (tag === 'ttcf') return tr('请选择单个 .ttf 或 .otf 字体文件');
  if (!(tag === 'OTTO' || tag === '\0\x01\0\0' || tag === 'true')) return tr('请选择单个 .ttf 或 .otf 字体文件');
  return null;
}

/** Ask for a font and keep it. Returns it, or null if the user gave none.
 * @param {any} app @returns {Promise<{name: string, blob: Blob}|null>} */
export async function chooseExportFont(app) {
  const local = typeof (/** @type {any} */ (window)).queryLocalFonts === 'function';
  const r = await showDialog({
    className: 'alert', dismissed: null,
    build: close => [h('h2', null, tr('导出 PDF 的字体')),
      h('p', null, tr('文本框、便签等文字在导出的 PDF 里是矢量文字，用这里选的字体。请选一个支持你所写文字的 .ttf 或 .otf 字体文件。')),
      h('p', { class: 'caption dim' }, tr('字体文件各有授权条款；把它嵌入 PDF 是否被允许，由你自己负责。'))],
    footer: close => [h('button', { onClick: () => close(null) }, tr('取消')),
      local ? h('button', { onClick: () => close('system') }, tr('从系统字体中选择…')) : null,
      h('button', { class: 'suggested', onClick: () => close(pickFiles()) }, tr('选择字体文件…'))],
  });
  /** @type {{name: string, blob: Blob}|null} */
  let picked = null;
  if (Array.isArray(r)) {   // the files: a promise given to close() is waited for
    // No `accept`: iOS greys font files out when asked for them by extension; checkFont looks at the file itself.
    const [file] = r;
    if (file) picked = { name: file.name.replace(/\.(ttf|otf)$/i, ''), blob: file };
  } else if (r === 'system') {
    try {
      const fonts = await (/** @type {any} */ (window)).queryLocalFonts();
      const choice = await pickFromList(fonts.map((/** @type {any} */ f) => ({ label: f.fullName, f })));
      if (choice) picked = { name: choice.fullName, blob: await choice.blob() };
    } catch (e) { await inform(tr('无法读取系统字体'), String((/** @type {any} */ (e)).message || e)); }
  }
  if (!picked) return null;
  const problem = await checkFont(picked.blob);
  if (problem) { await inform(tr('字体不能使用'), problem); return null; }
  await app.vfs.kvSet('export_font', picked);
  return picked;
}

/** @param {{label: string, f: any}[]} items */
async function pickFromList(items) {
  let chosen = null;
  const input = /** @type {HTMLInputElement} */ (h('input', { type: 'search', placeholder: tr('搜索'), style: { width: '100%' } }));
  const list = h('div', { class: 'scroll', style: { maxHeight: '320px', marginTop: '8px' } });
  const fill = () => {
    const q = input.value.toLowerCase();
    list.replaceChildren(...items.filter(i => i.label.toLowerCase().includes(q)).slice(0, 200).map(i => h('button', { class: 'menu-row', onClick: () => { chosen = i.f; document.querySelector('dialog[open] .suggested')?.dispatchEvent(new Event('click')); } }, i.label)));
  };
  input.addEventListener('input', fill);
  fill();
  await showDialog({ className: 'alert', build: close => { const done = () => close(true); list.addEventListener('click', () => setTimeout(done, 0)); return [h('h2', null, tr('系统字体')), input, list]; }, footer: close => [h('button', { class: 'suggested', style: { display: 'none' }, onClick: () => close(true) }), h('button', { onClick: () => close(false) }, tr('取消'))] });
  return chosen;
}
