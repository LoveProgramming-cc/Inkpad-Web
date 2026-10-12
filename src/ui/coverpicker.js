// @ts-check
// Choose a cover design and colour, or none (the first page then serves as the cover). B:dialogs.cover_picker.
import { h, icon } from './ui.js';
import { COVER_COLORS, COVER_STYLES } from '../core/page.js';
import { renderCover } from '../core/render.js';
import { swatchIcon } from '../core/icons.js';
import { tr } from '../core/i18n.js';

/**
 * @param {[string, number[]]|null} current @param {(spec: [string, number[]]|null) => void} onChange @param {string} [title]
 * @returns {HTMLElement}
 */
export function coverPicker(current, onChange, title = tr('笔记本')) {
  const state = { style: current ? current[0] : null, color: current ? current[1] : COVER_COLORS[0] };
  /** @type {[string, HTMLCanvasElement][]} */
  const previews = [];
  const sameColor = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  const colors = h('div', { class: 'row', style: { gap: 0, flexWrap: 'wrap' } });
  const styles = h('div', { class: 'row', style: { gap: '2px' }, role: 'radiogroup' });
  const draw = () => {
    for (const [style, canvas] of previews) {
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(/** @type {any} */ (renderCover(/** @type {any} */ ([style, state.color]), title, canvas.width, canvas.height)), 0, 0);
    }
    colors.classList.toggle('disabled', state.style === null);
  };
  const choose = () => { draw(); markPressed(); onChange(state.style ? /** @type {any} */ ([state.style, state.color]) : null); };
  const markPressed = () => {
    styles.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String([null, ...COVER_STYLES][i] === state.style)));
    colors.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(sameColor(COVER_COLORS[i], state.color))));
  };
  for (const style of /** @type {(string|null)[]} */ ([null, ...COVER_STYLES])) {
    let child;
    if (style === null) child = h('span', { class: 'thumb cover-none' }, icon('none', 18));
    else {
      const canvas = /** @type {HTMLCanvasElement} */ (h('canvas', { width: 72, height: 96, class: 'thumb', style: { width: '36px', height: '48px' } }));
      previews.push([style, canvas]);
      child = canvas;
    }
    styles.append(h('button', { class: 'flat cover-choice', title: style === null ? tr('用第一页作封面') : undefined, onClick: () => { state.style = style; choose(); } }, child));
  }
  for (const color of COVER_COLORS) {
    colors.append(h('button', { class: 'flat cover-color', onClick: () => { state.color = color; if (state.style === null) state.style = COVER_STYLES[0]; choose(); } }, swatchIcon(color, false, 22)));
  }
  const box = h('div', { class: 'col' }, styles, colors);
  draw();
  markPressed();
  return box;
}
