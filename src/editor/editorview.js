// @ts-check
// The editor: header bar, tool options, floating bars, panels, autosave (B:window.py, the editor half).
import './tools.js';
import './input.js';
import { PageCanvas } from './canvas.js';
import { EditorSession } from './session.js';
import { Sidebar } from './sidebar.js';
import { Minimap } from './minimap.js';
import { PageOps } from './pageops.js';
import { bgSource } from './pdfqueue.js';
import { h, icon } from '../ui/ui.js';
import { openPopover, menuPopover } from '../ui/popover.js';
import { toast } from '../ui/toast.js';
import { inform, askText, showDialog } from '../ui/dialog.js';
import { slider, switchEl } from '../ui/controls.js';
import { paperDialog } from '../ui/paperdialog.js';
import { coverPicker } from '../ui/coverpicker.js';
import { weightIcon, dotIcon, letterIcon, lineStyleIcon, swatchIcon, wheelIcon } from '../core/icons.js';
import { Document, merge } from '../core/document.js';
import { Stroke } from '../core/items.js';
import { Page } from '../core/page.js';
import { DEFAULTS, copy } from '../core/settings.js';
import { tr, trf } from '../core/i18n.js';
import { drawStroke } from '../core/draw.js';
import { toPng, decode } from '../platform/image.js';
import { pickFiles } from '../platform/files.js';
import { basename, dirname } from '../core/path.js';

const LASER_COLORS = [[1.0, 0.16, 0.2], [0.1, 0.8, 0.3], [0.16, 0.5, 1.0]];
const ERASER_SIZES = [4.0, 9.0, 18.0];
const TEXT_SIZES = [12.0, 18.0, 28.0];
const PEN_SENS_DIVISOR = 50;   // B: sens / 50; A divides by 100 for the Apple Pencil (PORTING.md 2.3)

// Names are translated where they are shown, so the language can change while running.
const TOOLS = [['lasso', 'lasso', '套索'], ['pen', 'pen', '笔'], ['eraser', 'eraser', '橡皮擦'], ['hl', 'highlighter', '荧光笔'], ['shape', 'shapes', '形状'],
  ['text', 'text', '文本'], ['note', 'note', '便签'], ['tape', 'tape', '胶带'], ['laser', 'laser', '激光笔']];
const TAPE_COLORS = [[0.96, 0.82, 0.36], [0.55, 0.8, 0.95], [0.95, 0.6, 0.65], [0.6, 0.85, 0.6], [0.72, 0.72, 0.76]];
const TAPE_WIDTHS = [10.0, 16.0, 26.0];
const NOTE_COLORS = [[1.0, 0.93, 0.55], [1.0, 0.8, 0.86], [0.75, 0.9, 1.0], [0.8, 0.95, 0.75]];
const PENS = [['fountain', 'fountain', '钢笔'], ['ball', 'ball', '圆珠笔'], ['brush', 'brush', '画笔']];
const PALETTE = [[0, 0, 0], [0.37, 0.37, 0.37], [0.6, 0.6, 0.6], [0.82, 0.82, 0.82], [1, 1, 1],
  [1.0, 0.1, 0.1], [0.53, 0.18, 0.57], [0.95, 0.33, 0.33], [1.0, 0.6, 0.6], [0.97, 0.58, 0.11],
  [0.04, 0.47, 1.0], [0.05, 0.29, 0.56], [0.03, 0.62, 0.36], [0.49, 0.76, 0.22], [1.0, 1.0, 0.5]];
const pctToWidth = (/** @type {number} */ pct) => 0.3 + pct * 0.047;
const widthToPct = (/** @type {number} */ w) => Math.max(0, Math.min(100, Math.round((w - 0.3) / 0.047)));

/** @type {Editor|null} */
let current = null;

/** Open a notebook in the editor. @param {any} app @param {string} path */
export async function openEditor(app, path) {
  if (current) return;
  const file = await app.vfs.readFile(path);
  if (!file) throw new Error(tr('无法打开笔记本'));
  let doc;
  try { doc = await Document.load(file.blob, { path, sign: file.sign, vfs: app.vfs }); }
  catch (e) { throw new Error(tr('无法打开笔记本') + ': ' + ((/** @type {any} */ (e)).message || e)); }
  current = new Editor(app, doc);
  app.editor = current;
  await current.start();
}

export class Editor {
  /** @param {any} app @param {import('../core/document.js').Document} doc */
  constructor(app, doc) {
    this.app = app;
    this.vfs = app.vfs;
    this.settings = app.settings;
    this.doc = doc;
    this.tool = this.prevTool = 'pen';
    this.toolSwitched = false;
    this.canvas = new PageCanvas();
    this.canvas.bgSource = bgSource;
    this.ops = new PageOps(this);
    this.sidebar = new Sidebar(i => this.canvas.scrollToPage(i), (page, anchor) => this.pageMenu(page, anchor), () => this.ops.addEnd());
    this.minimap = new Minimap(this.canvas);
    this.session = new EditorSession(doc, { busy: () => !!this.canvas.op || !!this.canvas.popover, vfs: this.vfs,
      onEdit: () => app.scheduler?.edited?.(doc), onError: e => toast(trf('自动保存失败：%s', (/** @type {any} */ (e)).message || e)) });
    this._offDoc = () => {};
    this.build();
  }

  saveSettings() { this.app.saveSettings(); }
  /** The page in the middle of the view. */
  page() { return this.doc.pages[Math.min(this.canvas.currentPageIndex(), this.doc.pages.length - 1)]; }

  // -- construction -----------------------------------------------------------------------------

  build() {
    const cv = this.canvas;
    cv.on('view-changed', () => { this.updateStatus(); this.placeSelbar(); });
    cv.on('selection-changed', () => this.placeSelbar());
    cv.on('menu-wanted', (/** @type {number} */ x, /** @type {number} */ y) => this.canvasMenu(x, y));
    cv.onEraseDone = () => { if (this.settings.eraser_auto && this.tool === 'eraser') this.selectTool(this.prevTool); };
    cv.onPullAdd = side => this.ops.pullAdd(side);
    cv.el.addEventListener('contextmenu', e => this.canvasContext(e));

    this.titleLabel = h('span', { class: 'ellipsis' });
    const home = h('button', { class: 'icon-btn', title: tr('文稿库'), onClick: () => this.goHome() }, icon('home'));
    const titleBtn = h('button', { class: 'title-btn', title: tr('笔记本'), onClick: e => this.titleMenu(/** @type {Element} */ (e.currentTarget)) }, this.titleLabel, icon('chevron', 14));
    this.sideBtn = h('button', { class: 'side icon-btn', title: tr('页面、大纲与书签'), 'aria-pressed': 'false', onClick: () => this.toggleSidebar() }, icon('sidebar'));
    const find = h('button', { class: 'icon-btn', title: tr('在笔记中查找 (Ctrl+F)'), onClick: () => this.showFind() }, icon('search'));
    this.toolButtons = /** @type {Record<string, HTMLElement>} */ ({});
    const group = h('div', { class: 'toolgroup' });
    for (const [name, ic, tip] of TOOLS) {
      const b = h('button', { class: 'tool', title: tr(tip), 'aria-pressed': String(name === this.tool), onClick: () => this.toolClicked(name) }, icon(ic));
      this.toolButtons[name] = b; group.append(b);
    }
    const imageBtn = this.toolButtons.image = h('button', { class: 'tool', title: tr('插入图片'), onClick: () => this.insertImage() }, icon('image'));
    const ruler = this.toolButtons.ruler = h('button', { class: 'tool', 'aria-pressed': 'false', title: tr('尺子：沿它的边缘画线会吸附成直线。手指拖动移动，双指旋转；鼠标拖动移动，滚轮旋转'),
      onClick: () => { const on = ruler.getAttribute('aria-pressed') !== 'true'; ruler.setAttribute('aria-pressed', String(on)); this.canvas.setRuler(on); } }, icon('ruler'));
    group.append(imageBtn, ruler);
    const more = h('button', { class: 'icon-btn', title: tr('页面与设置'), onClick: e => this.pagePanel(/** @type {Element} */ (e.currentTarget)) }, icon('more'));
    const exportBtn = h('button', { class: 'icon-btn', title: tr('导出'), onClick: e => this.exportMenu(/** @type {Element} */ (e.currentTarget)) }, icon('share'));
    const add = h('button', { class: 'icon-btn', title: tr('添加页面'), onClick: e => this.addPopover(/** @type {Element} */ (e.currentTarget)) }, icon('page_add'));
    this.header = h('div', { class: 'gn-header' }, home, titleBtn, h('div', { class: 'sepv' }), this.sideBtn, find,
      h('div', { class: 'grow' }), h('div', { class: 'header-scroll' }, group), h('div', { class: 'grow' }), add, exportBtn, more);

    this.undoBtn = h('button', { class: 'flat icon-btn', title: tr('撤销 (Ctrl+Z)'), onClick: () => this.undo() }, icon('undo'));
    this.redoBtn = h('button', { class: 'flat icon-btn', title: tr('重做 (Ctrl+Shift+Z)'), onClick: () => this.redo() }, icon('redo'));
    const history = h('div', { class: 'pill float undo-pill' }, this.undoBtn, this.redoBtn);
    this.optsEl = h('div', { class: 'pill' });
    const options = h('div', { class: 'options' }, this.optsEl);
    this.selbar = this.buildSelbar();
    this.findbar = this.buildFindbar();
    this.status = h('div', { class: 'status' });
    const statusWrap = h('div', { class: 'status-wrap' }, this.status);
    this.center = h('div', { class: 'editor-center' }, this.canvas.el, history, options, this.selbar, this.minimap.el, this.findbar, statusWrap);
    this.root = h('div', { class: 'editor' }, this.header, h('div', { class: 'editor-body' }, this.sidebar.el, this.center));
    this.statusWrap = statusWrap;
    this._keys = (/** @type {KeyboardEvent} */ e) => this.onKey(e);
  }

  async start() {
    const app = this.app;
    app.library.el.hidden = true;
    document.getElementById('app')?.append(this.root);
    this.canvas._resized();   // measured now, not left to the observer (which waits for a frame, and for the page to be visible)
    this.syncCanvas();
    this.rebuildOptions();
    this._offDoc = this.doc.listen((kind, ...a) => this.onDocEvent(kind, ...a));
    this.canvas.setDocument(this.doc);
    this.sidebar.setDocument(this.doc);
    const board = this.doc.pages[0].board;
    this.statusWrap.hidden = board;
    this.minimap.showFor(board);
    const memo = (this.settings.views || {})[this.doc.id];
    if (memo) this.canvas.restoreMemo(memo);
    this.onDocEvent('state');
    addEventListener('keydown', this._keys);
    this._unload = (/** @type {BeforeUnloadEvent} */ e) => { if (this.doc.modified) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', this._unload);
    this._hidden = () => { if (document.visibilityState === 'hidden') this.session.save(); };
    document.addEventListener('visibilitychange', this._hidden);
    this.canvas.el.focus();
    app.scheduler?.opened?.(this);
  }

  /** Save, remember where we were, and go back to the library. */
  async goHome() {
    const app = this.app;
    this.canvas.cancel();
    this.canvas.popover?.close?.();
    const memo = this.canvas.viewMemo();
    if (memo) {
      const views = (this.settings.views ||= {});
      views[this.doc.id] = memo;
      const keys = Object.keys(views);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete views[k];
      this.saveSettings();
    }
    try { await this.session.close(); } catch (e) { app.reportError(tr('保存失败'), e); return; }
    removeEventListener('keydown', this._keys);
    removeEventListener('beforeunload', this._unload);
    document.removeEventListener('visibilitychange', this._hidden);
    this._offDoc();
    this.canvas.destroy();
    this.root.remove();
    app.editor = null;
    current = null;
    app.library.el.hidden = false;
    await app.library.refresh();
    app.scheduler?.closed?.();
  }

  // -- settings → canvas ------------------------------------------------------------------------------

  pen() { return this.settings.pens[this.settings.pen_type]; }

  /** Pass the preferences on to the canvas (B: _sync). */
  syncCanvas() {
    const st = this.settings, c = this.canvas, pen = this.pen();
    c.penType = st.pen_type;
    c.penColor = [...st.pen_colors[st.pen_color]];
    c.penWidth = pen.widths[pen.slot];
    c.penSens = pen.sens / PEN_SENS_DIVISOR; c.penStab = pen.stab / 100; c.penDash = pen.dash || 0;
    c.holdShape = st.hold_shape;
    c.hlColor = [...st.hl_colors[st.hl_color]]; c.hlWidth = st.hl_widths[st.hl_w];
    c.eraserR = ERASER_SIZES[st.eraser_size]; c.eraserMode = st.eraser_mode;
    c.eraseFilter = new Set(st.erase_filter);
    c.lassoRect = st.lasso_rect; c.lassoFilter = new Set(st.lasso_filter);
    c.shapeKind = st.shape_kind; c.textSize = TEXT_SIZES[st.text_size];
    c.scribbleErase = st.scribble_erase; c.scribbleLoose = !!st.scribble_loose; c.fingerDraw = st.finger_draw;
    c.palmMs = st.palm_ms ?? 80;
    c.inputLog = st.input_log ? (/** @type {string} */ line) => this.app.logInput?.(line) : null;
    c.noteColor = NOTE_COLORS[(st.note_color || 0) % NOTE_COLORS.length];
    c.tapeColor = TAPE_COLORS[(st.tape_color || 0) % TAPE_COLORS.length];
    c.tapeWidth = TAPE_WIDTHS[(st.tape_w ?? 1) % TAPE_WIDTHS.length];
    c.mouseHand = st.mouse_hand ?? true;
    c.setPaging(st.paging || 'vertical');
    c.scrollbars = st.scrollbars ?? true; c.maxZoom = Math.max(2.0, Number(st.max_zoom ?? 6.0));
    c.queueDraw();
    if (c.showCross !== (st.crosshair ?? true)) { c.showCross = st.crosshair ?? true; c.updateCursor(); }
    c.laserMode = st.laser_mode; c.laserColor = LASER_COLORS[st.laser_color % LASER_COLORS.length];
    if (c.tool !== this.tool) c.setTool(this.tool);
    this.applyHiddenTools();
  }

  /** Show only the tools the user kept in the toolbar (the pen always stays). */
  applyHiddenTools() {
    const hidden = new Set(/** @type {string[]} */ (this.settings.hidden_tools || []));
    hidden.delete('pen');
    for (const [name, b] of Object.entries(this.toolButtons)) b.hidden = hidden.has(name);
    if (hidden.has(this.tool)) this.selectTool('pen');
    if (hidden.has('ruler') && this.canvas.ruler) { this.canvas.setRuler(false); this.toolButtons.ruler.setAttribute('aria-pressed', 'false'); }
  }

  /** @param {string} target @param {...any} _ */
  set(target, key, value) { target[key] = value; this.saveSettings(); this.syncCanvas(); }

  // -- tools ---------------------------------------------------------------------------------------------

  /** Tapping the tool that is already selected hides or shows its options bar. @param {string} name */
  toolClicked(name) {
    if (name === this.tool) { this.optsEl.parentElement.hidden = !this.optsEl.parentElement.hidden; return; }
    this.selectTool(name);
  }

  /** @param {string} name */
  selectTool(name) {
    if (name === this.tool) return;
    if (this.tool !== 'eraser') this.prevTool = this.tool;
    this.tool = name;
    for (const [n, b] of Object.entries(this.toolButtons)) if (n !== 'image' && n !== 'ruler') b.setAttribute('aria-pressed', String(n === name));
    /** @type {HTMLElement} */ (this.optsEl.parentElement).hidden = false;
    this.rebuildOptions();
    this.syncCanvas();
  }

  // -- the options bar ---------------------------------------------------------------------------------------

  /** A row of radio buttons bound to target[key]. @param {any} target @param {string} key @param {[any, Node, string|undefined][]} entries */
  group(target, key, entries, cls = '') {
    const nodes = entries.map(([value, child, tip]) => h('button', { class: cls, title: tip, 'aria-pressed': String(value === target[key]), onClick: () => {
      this.set(target, key, value);
      nodes.forEach((n, i) => n.setAttribute('aria-pressed', String(entries[i][0] === value)));
    } }, child));
    this.optsEl.append(...nodes);
  }

  sep() { this.optsEl.append(h('div', { class: 'sep' })); }

  /** @param {Node} ic @param {string|null} label @param {(anchor: Element) => void} open @param {string} tip */
  dropdown(ic, label, open, tip) {
    this.optsEl.append(h('button', { class: 'drop', title: tip, style: { gap: '4px', padding: '0 6px', marginLeft: '6px' }, onClick: e => open(/** @type {Element} */ (e.currentTarget)) }, ic, label && h('span', null, label), icon('chevron', 14)));
  }

  /** Colour slots: tap to select, tap the selected one to edit or remove it, + adds one. @param {string} colorsKey @param {string} indexKey */
  colors(colorsKey, indexKey) {
    const st = this.settings, colors = st[colorsKey], current = st[indexKey];
    colors.forEach((color, i) => {
      if (i === current) this.optsEl.append(h('button', { class: 'swatch current', title: tr('更改或删除此颜色'), style: { background: 'color-mix(in srgb, currentColor 13%, transparent)' },
        onClick: e => this.palette(/** @type {Element} */ (e.currentTarget), colorsKey, indexKey) }, swatchIcon(color, true, 22)));
      else this.optsEl.append(h('button', { class: 'swatch', onClick: () => { st[indexKey] = i; this.saveSettings(); this.syncCanvas(); this.rebuildOptions(); } }, swatchIcon(color, false, 22)));
    });
    if (colors.length < 9) this.optsEl.append(h('button', { class: 'swatch', title: tr('添加颜色'), onClick: e => this.palette(/** @type {Element} */ (e.currentTarget), colorsKey, indexKey, true) }, icon('plus', 16)));
  }

  /** Thickness presets: tap to select, tap the selected one to set its width. @param {any} target @param {string} key @param {number[]} widths */
  weights(target, key, widths, low, high, look) {
    widths.forEach((w, i) => {
      const ic = weightIcon(Math.max(0.8, Math.min(7.5, w * look)));
      if (i === target[key]) this.optsEl.append(h('button', { class: 'weight', title: tr('调整粗细') + ` (${w.toFixed(1)} pt)`, style: { background: 'color-mix(in srgb, currentColor 13%, transparent)' },
        onClick: e => this.widthPopover(/** @type {Element} */ (e.currentTarget), widths, i, low, high) }, ic));
      else this.optsEl.append(h('button', { title: `${w.toFixed(1)} pt`, onClick: () => { target[key] = i; this.saveSettings(); this.syncCanvas(); this.rebuildOptions(); } }, ic));
    });
  }

  penWeights() { const pen = this.pen(); this.weights(pen, 'slot', pen.widths, 0.3, 8.0, 1.3); }

  rebuildOptions() {
    const o = this.optsEl;
    o.replaceChildren();
    const st = this.settings, tool = this.tool;
    const lbl = (/** @type {string} */ t) => h('label', { style: { margin: '0 10px 0 6px' } }, t);
    if (tool === 'pen') {
      this.dropdown(icon(this.pen && PENS.find(p => p[0] === st.pen_type)?.[1] || 'pen'), null, a => this.penPopover(a), tr('笔设置'));
      this.sep(); this.penWeights(); this.sep(); this.colors('pen_colors', 'pen_color');
    } else if (tool === 'tape') {
      this.group(st, 'tape_w', [[0, weightIcon(3.5), tr('细')], [1, weightIcon(5.5), tr('中')], [2, weightIcon(7.5), tr('粗')]]);
      this.sep(); this.group(st, 'tape_color', TAPE_COLORS.map((c, i) => /** @type {[any, Node, string|undefined]} */ ([i, swatchIcon(c, false, 22), undefined])), 'swatch');
      this.sep(); o.append(lbl(tr('画过要遮住的内容；用手指或鼠标点一下胶带可掀开或盖回')));
    } else if (tool === 'note') {
      this.group(st, 'note_color', NOTE_COLORS.map((c, i) => /** @type {[any, Node, string|undefined]} */ ([i, swatchIcon(c, false, 22), undefined])), 'swatch');
      this.sep(); o.append(lbl(tr('点击页面放置便签，再点便签可修改')));
    } else if (tool === 'hl') {
      this.weights(st, 'hl_w', st.hl_widths, 3.0, 40.0, 0.34); this.sep(); this.colors('hl_colors', 'hl_color');
    } else if (tool === 'eraser') {
      this.dropdown(icon('eraser'), tr(st.eraser_mode === 'stroke' ? '笔画' : '标准'), a => this.eraserPopover(a), tr('橡皮擦设置'));
      this.sep(); this.group(st, 'eraser_size', [[0, dotIcon(2.5), tr('小')], [1, dotIcon(4.5), tr('中')], [2, dotIcon(7), tr('大')]]);
    } else if (tool === 'shape') {
      this.group(st, 'shape_kind', [['line', icon('shape_line'), tr('直线')], ['arrow', icon('shape_arrow'), tr('箭头')], ['rect', icon('shape_rect'), tr('矩形')], ['ellipse', icon('shape_ellipse'), tr('椭圆')]]);
      this.sep(); this.penWeights(); this.sep(); this.colors('pen_colors', 'pen_color');
    } else if (tool === 'laser') {
      this.group(st, 'laser_mode', [['dot', icon('laser_dot'), tr('点：跟随笔尖的光点')], ['trail', icon('laser_trail'), tr('轨迹：画出的线约一秒后消失')]]);
      this.sep(); this.group(st, 'laser_color', LASER_COLORS.map((c, i) => /** @type {[any, Node, string|undefined]} */ ([i, swatchIcon(c, false, 22), undefined])), 'swatch');
    } else if (tool === 'text') {
      this.group(st, 'text_size', [[0, letterIcon(0.6), tr('小')], [1, letterIcon(0.85), tr('中')], [2, letterIcon(1.15), tr('大')]]);
      this.sep(); this.colors('pen_colors', 'pen_color');
    } else {
      const rect = st.lasso_rect;
      this.dropdown(icon(rect ? 'lasso_rect' : 'lasso'), rect ? tr('长方形') : tr('自由'), a => this.lassoPopover(a), tr('套索设置'));
      this.sep(); o.append(lbl(tr('拖动移动 · 右下角手柄缩放 · Delete 删除')));
    }
  }

  // -- popovers -------------------------------------------------------------------------------------------------

  /** @param {string} title */
  panel(title, ...children) {
    return h('div', { class: 'col', style: { minWidth: '280px' } }, title && h('h4', null, title), children);
  }

  /** @param {string} text */
  caption(text) { return h('div', { class: 'caption dim' }, text); }

  /** @param {string} text @param {boolean} on @param {(on: boolean) => void} fn @param {string} [ic] */
  switchRow(text, on, fn, ic) {
    return h('div', { class: 'row' }, ic && icon(ic), h('span', { class: 'grow' }, text), switchEl(on, fn));
  }

  /** Big side-by-side radio buttons with an icon above a label. @param {any} target @param {string} key @param {[any, Node, string][]} entries @param {() => void} [after] */
  choiceRow(target, key, entries, after) {
    const row = h('div', { class: 'row', style: { gap: '6px' } });
    const nodes = entries.map(([value, ic, text]) => h('button', { class: 'choice', style: { flex: 1, flexDirection: 'column', padding: '6px', gap: '4px', height: 'auto' }, 'aria-pressed': String(target[key] === value),
      onClick: () => { this.set(target, key, value); nodes.forEach((n, i) => n.setAttribute('aria-pressed', String(entries[i][0] === value))); after?.(); } }, ic, h('span', null, text)));
    row.append(...nodes);
    return row;
  }

  /** @param {Element} anchor */
  penPopover(anchor) {
    const st = this.settings;
    const wide = innerWidth >= 760;
    const preview = /** @type {HTMLCanvasElement} */ (h('canvas', { width: 560, height: 168, style: { width: '280px', height: '84px', alignSelf: 'center' } }));
    const drawPreview = () => {
      const pen = this.pen();
      const ctx = /** @type {CanvasRenderingContext2D} */ (preview.getContext('2d'));
      ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.clearRect(0, 0, 280, 84);
      const pts = Array.from({ length: 61 }, (_, i) => { const t = i / 60; return [24 + 232 * t, 42 + 22 * Math.sin(t * 2 * Math.PI + Math.PI), 0.12 + 0.85 * Math.sin(t * Math.PI)]; });
      const s = new Stroke(st.pen_type, st.pen_colors[st.pen_color], pen.widths[pen.slot] * 1.5, pts, pen.sens / PEN_SENS_DIVISOR, 0);
      ctx.fillStyle = ctx.strokeStyle = getComputedStyle(this.root).color;
      drawStroke(ctx, { ox: 0, oy: 0, perPixel: 0.5, onDark: true, printing: false }, s);
    };
    const title = h('h4');
    const dashHolder = h('div');
    const sizeVal = h('div', { class: 'caption dim', style: { textAlign: 'right' } });
    /** @param {string} text @param {(pct: number) => void} onChange @param {(v: number) => void} [shown] */
    const scale = (text, onChange, shown) => {
      const val = h('span', { class: 'caption dim' });
      const input = slider({ min: 0, max: 100, value: 0, onInput: v => { val.textContent = v + '%'; shown?.(v); onChange(v); } });
      return { el: h('div', { class: 'col', style: { gap: '2px' } }, h('div', { class: 'row' }, h('span', { class: 'caption grow' }, text), val), input), set: (/** @type {number} */ v) => { input.value = String(v); val.textContent = v + '%'; shown?.(v); } };
    };
    const size = scale(tr('笔尖'), pct => { const pen = this.pen(); pen.widths[pen.slot] = Math.round(pctToWidth(pct) * 100) / 100; this.saveSettings(); this.syncCanvas(); drawPreview(); }, pct => { sizeVal.textContent = (pctToWidth(pct) * 0.3528).toFixed(2) + ' mm'; });
    const sens = scale(tr('压力灵敏度'), pct => { this.pen().sens = pct; this.saveSettings(); this.syncCanvas(); drawPreview(); });
    const stab = scale(tr('画笔稳定性'), pct => { this.pen().stab = pct; this.saveSettings(); this.syncCanvas(); drawPreview(); });
    const load = () => {
      const pen = this.pen();
      title.textContent = tr(/** @type {string} */ (PENS.find(p => p[0] === st.pen_type)?.[2]));
      pen.dash ??= 0;
      dashHolder.replaceChildren(this.choiceRow(pen, 'dash', [[0, lineStyleIcon(0), tr('实线')], [1, lineStyleIcon(1), tr('虚线')], [2, lineStyleIcon(2), tr('点线')]], drawPreview));
      size.set(widthToPct(pen.widths[pen.slot])); sens.set(pen.sens); stab.set(pen.stab);
      drawPreview();
    };
    const types = this.choiceRow(st, 'pen_type', PENS.map(([n, ic, t]) => /** @type {[any, Node, string]} */ ([n, icon(ic), tr(t)])), load);
    const reset = h('button', { class: 'flat icon-btn', title: tr('恢复此笔的默认设置'), style: { alignSelf: 'flex-end' }, onClick: () => { st.pens[st.pen_type] = copy(DEFAULTS.pens[/** @type {'fountain'} */ (st.pen_type)]); this.saveSettings(); this.syncCanvas(); load(); } }, icon('reset', 18));
    const left = h('div', { class: 'col', style: { width: '280px' } }, preview, types, h('div', { class: 'sep' }), this.caption(tr('笔画样式')), dashHolder);
    const right = h('div', { class: 'col', style: { width: '280px' } }, size.el, sizeVal, sens.el, stab.el, h('div', { class: 'sep' }), this.caption(tr('设置')),
      this.switchRow(tr('长按绘制规则形状'), st.hold_shape, on => this.set(st, 'hold_shape', on)), this.switchRow(tr('涂画以擦除'), st.scribble_erase, on => this.set(st, 'scribble_erase', on)), reset);
    load();
    openPopover(h('div', { class: 'col' }, title, h('div', { class: 'row', style: { alignItems: 'flex-start', flexDirection: wide ? 'row' : 'column', gap: '12px' } }, left, wide ? h('div', { style: { width: '1px', alignSelf: 'stretch', background: 'var(--border)' } }) : null, right)),
      { anchor, side: 'bottom', onClose: () => this.rebuildOptions() });
  }

  /** @param {Element} anchor @param {string} colorsKey @param {string} indexKey */
  palette(anchor, colorsKey, indexKey, add = false) {
    const st = this.settings, colors = st[colorsKey];
    const current = add ? null : colors[st[indexKey]];
    let pop;
    const choose = (/** @type {number[]} */ color) => {
      if (add) { colors.push([...color]); st[indexKey] = colors.length - 1; } else colors[st[indexKey]] = [...color];
      this.saveSettings(); this.syncCanvas(); pop.close(); this.rebuildOptions();
    };
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, auto)', gap: '4px' } },
      PALETTE.map(c => h('button', { class: ['flat swatch', current && c.every((v, i) => Math.abs(v - current[i]) < 0.02) && 'checked'], onClick: () => choose(c) }, swatchIcon(c, false, 26))),
      h('button', { class: 'flat swatch', title: tr('自定义颜色'), onClick: () => {
        const input = /** @type {HTMLInputElement} */ (h('input', { type: 'color', value: current ? '#' + current.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : '#000000' }));
        input.addEventListener('change', () => { const n = parseInt(input.value.slice(1), 16); choose([(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]); });
        input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.click(); setTimeout(() => input.remove(), 60000);
      } }, wheelIcon(26)));
    const remove = !add && colors.length > 1 ? h('div', { class: 'col' }, h('div', { class: 'sep' }), h('button', { class: 'menu-row danger', onClick: () => {
      colors.splice(st[indexKey], 1); st[indexKey] = Math.min(st[indexKey], colors.length - 1); this.saveSettings(); this.syncCanvas(); pop.close(); this.rebuildOptions();
    } }, tr('删除此颜色'))) : null;
    pop = openPopover(h('div', { class: 'col' }, h('h4', null, add ? tr('添加颜色') : colorsKey === 'pen_colors' ? tr('笔颜色') : tr('荧光笔颜色')), grid, remove), { anchor, side: 'bottom' });
  }

  /** @param {Element} anchor @param {number[]} widths @param {number} slot */
  widthPopover(anchor, widths, slot, low, high) {
    const hl = this.tool === 'hl';
    const preview = /** @type {HTMLCanvasElement} */ (h('canvas', { width: 560, height: 88, style: { width: '280px', height: '44px', alignSelf: 'center' } }));
    const value = h('div', { class: 'caption dim', style: { textAlign: 'right' } });
    const input = slider({ min: low, max: high, step: 0.1, value: widths[slot], onInput: v => changed(v) });
    const changed = (/** @type {number} */ v) => {
      const w = Math.round(v * 10) / 10;
      widths[slot] = w; value.textContent = w.toFixed(1) + ' pt';
      this.saveSettings(); this.syncCanvas();
      const ctx = /** @type {CanvasRenderingContext2D} */ (preview.getContext('2d'));
      ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.clearRect(0, 0, 280, 44);
      const pts = Array.from({ length: 41 }, (_, i) => [20 + 240 * (i / 40), 22 + 7 * Math.sin(i / 40 * 2 * Math.PI), 0.6]);
      const item = hl ? new Stroke('hl', this.canvas.hlColor, w, pts) : new Stroke('ball', this.canvas.penColor, w, pts);
      drawStroke(ctx, { ox: 0, oy: 0, perPixel: 0.5, onDark: true, printing: false }, item);
    };
    const nudge = (/** @type {number} */ d) => { input.value = String(Number(input.value) + d); changed(Number(input.value)); };
    changed(widths[slot]);
    openPopover(this.panel(tr('粗细'), preview, h('div', { class: 'row' }, h('button', { class: 'flat icon-btn', onClick: () => nudge(-0.1) }, icon('minus', 16)), h('div', { class: 'grow' }, input),
      h('button', { class: 'flat icon-btn', onClick: () => nudge(0.1) }, icon('plus', 16))), value), { anchor, side: 'bottom', onClose: () => this.rebuildOptions() });
  }

  /** @param {Element} anchor */
  eraserPopover(anchor) {
    const st = this.settings;
    const toggle = (/** @type {string} */ key, /** @type {string} */ name) => (/** @type {boolean} */ on) => {
      const v = st[key]; if (on && !v.includes(name)) v.push(name); else if (!on && v.includes(name)) v.splice(v.indexOf(name), 1);
      this.saveSettings(); this.syncCanvas();
    };
    const pop = openPopover(this.panel(tr('橡皮擦'),
      this.choiceRow(st, 'eraser_mode', [['standard', icon('eraser'), tr('标准')], ['stroke', icon('ball'), tr('笔画')]]),
      this.caption(tr('标准橡皮擦只擦掉碰到的部分；笔画橡皮擦一次擦除整条笔画。')), h('div', { class: 'sep' }), this.caption(tr('橡皮擦筛选')),
      [['pen', 'pen', tr('笔')], ['hl', 'highlighter', tr('荧光笔')], ['shape', 'shapes', tr('形状')]].map(([n, ic, t]) => this.switchRow(t, st.erase_filter.includes(n), toggle('erase_filter', n), ic)),
      this.caption(tr('如工具已关闭，则橡皮擦不会擦除其留下的痕迹。')), h('div', { class: 'sep' }),
      this.switchRow(tr('自动取消选择'), st.eraser_auto, on => this.set(st, 'eraser_auto', on)),
      h('button', { class: 'menu-row danger', onClick: () => { pop.close(); this.ops.clearPage(this.page()); } }, tr('清除页面'))),
    { anchor, side: 'bottom', onClose: () => this.rebuildOptions() });
  }

  /** @param {Element} anchor */
  lassoPopover(anchor) {
    const st = this.settings;
    const toggle = (/** @type {string} */ name) => (/** @type {boolean} */ on) => {
      const v = st.lasso_filter; if (on && !v.includes(name)) v.push(name); else if (!on && v.includes(name)) v.splice(v.indexOf(name), 1);
      this.saveSettings(); this.syncCanvas();
    };
    openPopover(this.panel(tr('套索选取'), this.caption(tr('套索类型')), this.choiceRow(st, 'lasso_rect', [[false, icon('lasso'), tr('自由')], [true, icon('lasso_rect'), tr('长方形')]]),
      this.caption(tr('包含在选取区域中的内容')),
      [['ink', tr('手写内容')], ['image', tr('图像')], ['shape', tr('形状与箭头')], ['text', tr('文本框')]].map(([n, t]) => this.switchRow(t, st.lasso_filter.includes(n), toggle(n)))),
    { anchor, side: 'bottom', onClose: () => this.rebuildOptions() });
  }

  // -- selection bar ---------------------------------------------------------------------------------------------------

  buildSelbar() {
    const c = this.canvas;
    const btn = (/** @type {string} */ ic, /** @type {string} */ tip, /** @type {() => void} */ fn, cls = '') => h('button', { class: ['flat icon-btn', cls], title: tip, onClick: fn }, icon(ic));
    const bar = h('div', { class: 'pill float selbar', hidden: true },
      h('button', { class: 'flat icon-btn', title: tr('颜色'), onClick: e => this.selColor(/** @type {Element} */ (e.currentTarget)) }, icon('palette')), h('div', { class: 'sep' }),
      btn('scissors', tr('剪切'), () => this.selCut()), btn('copy', tr('拷贝'), () => this.selCopy()), btn('duplicate', tr('复制'), () => c.duplicateSelection()),
      btn('trash', tr('删除'), () => c.deleteSelection(), 'danger'),
      h('button', { class: 'flat icon-btn', title: tr('更多'), onClick: e => this.selMore(/** @type {Element} */ (e.currentTarget)) }, icon('dots')));
    this.selMoreBtn = bar.lastElementChild;
    return bar;
  }

  /** @param {Element} anchor */
  selMore(anchor) {
    const c = this.canvas;
    menuPopover(anchor, [
      { label: tr('向左旋转'), icon: 'reset', fn: () => c.rotateSelection(3) }, { label: tr('向右旋转'), icon: 'rotate_cw', fn: () => c.rotateSelection(1) }, null,
      { label: tr('移到最前'), icon: 'to_front', fn: () => c.restackSelection(true) }, { label: tr('移到最后'), icon: 'to_back', fn: () => c.restackSelection(false) }, null,
      { label: tr('粘贴'), icon: 'paste', fn: () => this.paste() }, { label: tr('截图到剪贴板'), icon: 'camera', fn: () => this.selScreenshot() },
      { label: tr('存为图片…'), icon: 'image', fn: () => this.selSaveImage() }], { side: 'auto' });
  }

  /** @param {Element} anchor */
  selColor(anchor) {
    const pop = openPopover(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, auto)', gap: '4px' } },
      PALETTE.map(c => h('button', { class: 'flat swatch', onClick: () => { pop.close(); this.canvas.recolorSelection(c); } }, swatchIcon(c, false, 24)))), { anchor, side: 'auto' });
  }

  selCopy() { if (this.canvas.copySelection()) toast(tr('已拷贝')); }
  selCut() { if (this.canvas.copySelection()) this.canvas.deleteSelection(); }

  /** @param {number[]|null} [at] */
  async paste(at = null) {
    if (this.canvas.paste(at)) return;
    // Nothing copied inside the app: a picture on the system clipboard.
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) { await this.addPicture(await item.getType(type)); return; }
      }
    } catch { /* not allowed, or nothing there */ }
  }

  async selScreenshot() {
    const canvas = this.canvas.selectionImage(2.0);
    if (!canvas) return;
    try {
      const blob = await new Promise(res => /** @type {HTMLCanvasElement} */ (canvas).toBlob ? /** @type {HTMLCanvasElement} */ (canvas).toBlob(res, 'image/png') : /** @type {any} */ (canvas).convertToBlob({ type: 'image/png' }).then(res));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': /** @type {Blob} */ (blob) })]);
      toast(tr('截图已拷贝到剪贴板'));
    } catch { this.selSaveImage(); }
  }

  async selSaveImage() {
    const canvas = this.canvas.selectionImage(3.0);
    if (!canvas) return;
    const { toPng: encode } = await import('../platform/canvas.js');
    const { saveBlob } = await import('../platform/files.js');
    await saveBlob(await encode(canvas), 'selection.png', { description: tr('PNG 图片'), accept: { 'image/png': ['.png'] } });
  }

  placeSelbar() {
    const bar = this.selbar, rect = this.canvas.selectionRect();
    if (!rect) { bar.hidden = true; return; }
    const [x, y, w, hh] = rect;
    bar.hidden = false;
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    const cw = this.canvas.W, ch = this.canvas.H;
    const left = Math.max(8, Math.min(cw - bw - 8, x + w / 2 - bw / 2));
    let top = y - bh - 14;
    if (top < 64) top = y + hh + 18;   // no room above (the tool options sit there): go below
    bar.style.left = Math.round(left) + 'px';
    bar.style.top = Math.round(Math.max(8, Math.min(ch - bh - 8, top))) + 'px';
  }

  /** A right click on the selection opens the bar's "more" menu. @param {MouseEvent} e */
  canvasContext(e) {
    const r = this.canvas.el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const rect = this.canvas.selectionRect();
    if (rect && x >= rect[0] - 6 && x <= rect[0] + rect[2] + 6 && y >= rect[1] - 6 && y <= rect[1] + rect[3] + 6) this.selMore(this.selMoreBtn);
  }

  /** A long press with the select tool: what can be done with the selection if it was on it, and pasting at that place otherwise. @param {number} x @param {number} y */
  canvasMenu(x, y) {
    const c = this.canvas, rect = c.selectionRect();
    /** @type {any[]} */
    let rows = [{ label: tr('粘贴'), icon: 'paste', fn: () => this.paste([x, y]) }];
    if (rect && x >= rect[0] - 8 && x <= rect[0] + rect[2] + 8 && y >= rect[1] - 8 && y <= rect[1] + rect[3] + 8) {
      rows = [{ label: tr('剪切'), icon: 'scissors', fn: () => this.selCut() }, { label: tr('拷贝'), icon: 'copy', fn: () => this.selCopy() },
        { label: tr('复制'), icon: 'duplicate', fn: () => c.duplicateSelection() }, { label: tr('删除'), icon: 'trash', danger: true, fn: () => c.deleteSelection() }, null, ...rows];
    }
    const r = c.el.getBoundingClientRect();
    menuPopover(new DOMRect(r.left + x, r.top + y, 0, 0), rows);
  }

  // -- find in notebook ------------------------------------------------------------------------------------------------------

  buildFindbar() {
    this.findInput = /** @type {HTMLInputElement} */ (h('input', { type: 'search', class: 'round', placeholder: tr('查找文本框和 PDF 中的文字'), style: { width: '240px' },
      onInput: () => this.find(), onKeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !e.isComposing) this.findStep(e.shiftKey ? -1 : 1); else if (e.key === 'Escape') this.hideFind(); } }));
    this.findCount = h('span', { class: 'dim mono', style: { minWidth: '56px', margin: '0 4px' } });
    const b = (/** @type {string} */ ic, /** @type {string} */ tip, /** @type {() => void} */ fn) => h('button', { class: 'flat icon-btn', title: tip, onClick: fn }, icon(ic, 16));
    return h('div', { class: 'pill float findbar', hidden: true }, this.findInput, this.findCount, b('up', tr('上一个'), () => this.findStep(-1)), b('down', tr('下一个'), () => this.findStep(1)), b('close', tr('关闭'), () => this.hideFind()));
  }

  showFind() { this.findbar.hidden = false; this.findInput.focus(); this.findInput.select(); this.find(); }
  hideFind() { this.findbar.hidden = true; this.canvas.setMarks([]); this.canvas.el.focus(); }

  async find() {
    const query = this.findInput.value;
    const token = this._findToken = (this._findToken || 0) + 1;
    /** @type {[any, number[]][]} */
    let marks = [];
    if (query.trim()) {
      const { findText } = await import('../core/find.js');
      try { for (const page of this.doc.pages) for (const box of await findText(page, query)) marks.push([page, box]); } catch (e) { toast(String((/** @type {any} */ (e)).message || e)); }
    }
    if (token !== this._findToken) return;
    this.canvas.setMarks(marks, marks.length ? 0 : -1);
    this.findLabel();
  }

  /** @param {number} step */
  findStep(step) {
    const marks = this.canvas.marks;
    if (marks.length) { this.canvas.setMarks(marks, (this.canvas.markAt + step + marks.length) % marks.length); this.findLabel(); }
  }

  findLabel() {
    const n = this.canvas.marks.length;
    this.findCount.textContent = n ? `${this.canvas.markAt + 1} / ${n}` : this.findInput.value.trim() ? tr('无结果') : '';
  }

  // -- the document -----------------------------------------------------------------------------------------------------------

  /** @param {string} kind @param {...any} _ */
  onDocEvent(kind, ..._) {
    // Every kind of change counts: erasing, for one, only announces a new state.
    this.minimap.contentChanged();
    if (kind === 'state') {
      this.updateTitle();
      this.undoBtn.disabled = !this.doc.undoStack.length;
      this.redoBtn.disabled = !this.doc.redoStack.length;
    } else if (kind === 'pages' || kind === 'meta') {
      this.updateStatus();
    }
  }

  updateTitle() {
    const name = this.doc.displayName();
    this.titleLabel.textContent = name;
    document.title = `${name} — Inkpad`;
  }

  updateStatus() {
    const i = this.canvas.currentPageIndex();
    this.status.textContent = `${i + 1} / ${this.doc.pages.length} · ${Math.round(this.canvas.shownZoom() * 100)}%`;
    this.sidebar.select(i);
  }

  undo() { this.canvas.cancel(); this.canvas.clearSelection(); this.doc.undo(); }
  redo() { this.canvas.cancel(); this.canvas.clearSelection(); this.doc.redo(); }

  toggleSidebar() {
    const on = this.sideBtn.getAttribute('aria-pressed') !== 'true';
    this.sideBtn.setAttribute('aria-pressed', String(on));
    this.sidebar.show(on);
  }

  // -- menus and panels ---------------------------------------------------------------------------------------------------------

  /** @param {Element} anchor */
  titleMenu(anchor) {
    menuPopover(anchor, [
      { label: tr('重命名…'), icon: 'rename', fn: () => this.rename() },
      { label: tr('更改封面…'), icon: 'cover', fn: () => this.changeCover() },
      { label: tr('导入 PDF 页面…'), icon: 'share', fn: () => this.importPdf(true) },
      null,
      { label: tr('立即保存'), icon: 'check_circle', fn: async () => { await this.session.save(); toast(tr('已保存')); } }]);
  }

  async rename() {
    const name = await askText(tr('重命名'), { value: this.doc.displayName() });
    if (!name || !name.trim() || !this.doc.path) return;
    await this.session.save();
    try {
      const store = this.app.store;
      const old = this.doc.path;
      const next = await store.rename(old, name);
      this.doc.path = next;
      this.updateTitle();
      this.doc.touch();   // the cover shows the name
    } catch (e) { this.app.reportError(tr('操作失败'), e); }
  }

  async changeCover() {
    /** @type {[string, number[]]|null} */
    let chosen = /** @type {any} */ (this.doc.coverSpec);
    const r = await showDialog({
      className: 'alert', dismissed: null,
      build: () => [h('h2', null, tr('笔记本封面')), h('p', null, tr('封面显示在文稿库里。')), h('div', { style: { marginTop: '12px' } }, coverPicker(chosen, c => { chosen = c; }, this.doc.displayName()))],
      footer: close => [h('button', { onClick: () => close(null) }, tr('取消')), h('button', { class: 'suggested', onClick: () => close(true) }, tr('应用'))],
    });
    if (r) this.doc.setCover(chosen);
  }

  /** @param {boolean} [append] */
  async importPdf(append = true) {
    const { importPdfPages } = await import('../io/importer.js');
    await importPdfPages(this, append);
  }

  async insertImage() {
    const [file] = await pickFiles({ accept: 'image/*' });
    if (file) await this.addPicture(file);
  }

  /** @param {Blob} file */
  async addPicture(file) {
    try {
      const { png, w, h: hh } = await toPng(file);
      const bitmap = await decode(png);
      this.canvas.insertImage(png, w, hh, null, bitmap);
      this.selectTool('lasso');
    } catch (e) { this.app.reportError(tr('无法插入图片'), e); }
  }

  /** @param {Element} anchor */
  addPopover(anchor) {
    const st = this.settings, page = this.page();
    /** @type {any} */ let pop;
    const where = h('div', { class: 'segmented' }, [['before', tr('在此之前')], ['after', tr('在此之后')], ['last', tr('最后一页')]].map(([v, t]) =>
      h('button', { 'aria-pressed': String(st.add_pos === v), onClick: (/** @type {Event} */ e) => { st.add_pos = v; this.saveSettings(); where.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false')); /** @type {Element} */ (e.currentTarget).setAttribute('aria-pressed', 'true'); } }, t)));
    const blank = page.blankLike();
    const thumb = h('canvas', { class: 'thumb', width: 156, height: 208, style: { width: '78px', height: '104px' } });
    import('../core/render.js').then(m => {
      const s = blank.board ? m.pageSurface(blank, 0, { size: [156, 208] }) : m.pageSurface(blank, Math.min(156 / blank.w, 208 / blank.h));
      const cv = /** @type {HTMLCanvasElement} */ (thumb);
      cv.width = /** @type {any} */ (s).width; cv.height = /** @type {any} */ (s).height; cv.style.width = cv.width / 2 + 'px'; cv.style.height = cv.height / 2 + 'px';
      /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d')).drawImage(/** @type {any} */ (s), 0, 0);
    });
    const row = (/** @type {string} */ ic, /** @type {string} */ text, /** @type {() => void} */ fn) => h('button', { class: 'menu-row', onClick: () => { pop.close(); fn(); } }, icon(ic), h('span', null, text));
    pop = openPopover(h('div', { class: 'col', style: { width: '320px' } }, h('h4', null, page.board ? tr('添加白板') : tr('添加页面')), where, this.caption(tr('模板')),
      h('button', { class: 'flat', style: { flexDirection: 'column', alignSelf: 'flex-start', height: 'auto', padding: '6px' }, onClick: () => { pop.close(); this.ops.addPages([blank]); } }, thumb, h('span', null, tr('当前模板'))),
      h('div', { class: 'sep' }),
      row('grid', tr('更多模板…'), async () => { const r = await paperDialog({ template: /** @type {any} */ (page.template()), heading: tr('添加页面'), applyLabel: tr('添加'), board: page.board }); if (r) this.ops.addPages([new Page(r.template)]); }),
      row('image', tr('图像…'), () => this.addImagePage()), row('share', tr('导入 PDF…'), () => this.importPdf(true))), { anchor, side: 'bottom', align: 'end' });
  }

  async addImagePage() {
    const [file] = await pickFiles({ accept: 'image/*' });
    if (!file) return;
    const { png, w, h: hh } = await toPng(file);
    const bitmap = await decode(png);
    const page = this.page().blankLike();
    const box = page.board ? [page.w / 2 - 300, page.h / 2 - 220, page.w / 2 + 300, page.h / 2 + 220] : [0, 0, page.w, page.h];
    const k = Math.min((box[2] - box[0]) * 0.9 / w, (box[3] - box[1]) * 0.9 / hh, 1.5);
    const { Image: Img } = await import('../core/items.js');
    page.items = [new Img((box[0] + box[2] - w * k) / 2, (box[1] + box[3] - hh * k) / 2, w * k, hh * k, png, bitmap)];
    this.ops.addPages([page]);
  }

  /** The page menu of a thumbnail (and the base of the "more" panel). @param {Page} page @param {Element} anchor */
  pageMenu(page, anchor) {
    const o = this.ops;
    const n = o.index(page) + 1;
    /** @type {any[]} */
    const rows = [
      { label: page.bookmark ? tr('移除书签') : tr('添加书签'), fn: () => o.toggleBookmark(page) },
      { label: page.outline ? tr('从大纲移除') : tr('将页面添加到大纲…'), fn: () => o.editOutline(page) }, null,
      { label: tr('拷贝页面'), fn: () => o.copyPage(page) }];
    if (o.clip) rows.push({ label: tr('粘贴页面'), fn: () => o.pastePage(page) });
    rows.push({ label: tr('复制页面'), fn: () => o.duplicatePage(page) }, { label: tr('在后面添加页面'), fn: () => o.addAfter(page) },
      { label: tr('顺时针旋转'), fn: () => o.rotatePage(page, 1) }, { label: tr('逆时针旋转'), fn: () => o.rotatePage(page, 3) }, { label: tr('旋转 180°'), fn: () => o.rotatePage(page, 2) },
      { label: tr('更改模板…'), fn: () => o.changeTemplate(page) }, null,
      { label: tr('清除页面'), danger: true, fn: () => o.clearPage(page) }, { label: tr('删除页面'), danger: true, fn: () => o.deletePage(page) });
    void n;
    menuPopover(anchor, rows, { side: 'auto' });
  }

  /** The header menu: page actions as a grid of tiles, then view options and the rest. It stays open
   * after an action, so the result can be watched and the action repeated; only entries that open a
   * dialog close it. @param {Element} anchor */
  pagePanel(anchor) {
    const st = this.settings, o = this.ops;
    const box = h('div', { class: 'col', style: { width: '336px' } });
    const pop = openPopover(box, { anchor, side: 'bottom', align: 'end' });
    const fill = () => {
      const page = this.page();
      const act = (/** @type {() => any} */ fn) => () => { fn(); setTimeout(fill, 0); };   // page count, bookmark state and the like may have changed
      const leave = (/** @type {() => any} */ fn) => () => { pop.close(); fn(); };
      const tiles = [
        [page.bookmark ? 'bookmark_filled' : 'bookmark', page.bookmark ? tr('移除书签') : tr('书签'), act(() => o.toggleBookmark(page))],
        ['outline', tr('大纲'), leave(() => o.editOutline(page))], ['grid', tr('模板'), leave(() => o.changeTemplate(page))],
        ['page_add', tr('加页'), act(() => o.addAfter(page))], ['copy', tr('拷贝'), act(() => o.copyPage(page))], ['duplicate', tr('复制'), act(() => o.duplicatePage(page))],
        ['reset', tr('左转'), act(() => o.rotatePage(page, 3))], ['rotate_cw', tr('右转'), act(() => o.rotatePage(page, 1))]];
      if (o.clip) tiles.push(['paste', tr('粘贴'), act(() => o.pastePage(page))]);
      const rowBtn = (/** @type {string} */ ic, /** @type {string} */ text, /** @type {() => void} */ fn, cls = '') => h('button', { class: ['menu-row', cls], onClick: fn }, icon(ic, 18), h('span', { class: 'ellipsis' }, text));
      box.replaceChildren(
        h('div', { class: 'row' }, h('h4', { class: 'grow' }, trf('第 %d / %d 页', o.index(page) + 1, this.doc.pages.length)), h('button', { class: 'pill-btn', style: { minHeight: '28px', padding: '2px 14px', fontWeight: 'normal' }, onClick: leave(() => o.gotoPage()) }, tr('前往…'))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' } }, tiles.map(([ic, t, fn]) => h('button', { class: 'tile', onClick: /** @type {any} */ (fn) }, icon(/** @type {string} */ (ic)), h('span', { class: 'caption ellipsis' }, /** @type {string} */ (t))))),
        h('div', { class: 'segmented', style: { display: 'flex' } },
          h('button', { style: { flex: 1 }, onClick: () => this.canvas.zoomBy(1 / 1.2) }, icon('minus', 16)), h('button', { style: { flex: 1 }, onClick: () => this.canvas.fitWidth() }, tr('适合宽度')), h('button', { style: { flex: 1 }, onClick: () => this.canvas.zoomBy(1.2) }, icon('plus', 16))),
        this.switchRow(tr('涂画以擦除'), st.scribble_erase, on => this.set(st, 'scribble_erase', on)), this.switchRow(tr('用手指书写'), st.finger_draw, on => this.set(st, 'finger_draw', on)),
        this.switchRow(tr('全屏模式'), !!document.fullscreenElement, on => { if (on) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); }),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px' } },
          rowBtn('settings', tr('设置…'), leave(() => this.app.openSettings?.())), rowBtn('info', tr('关于'), leave(() => this.about())),
          rowBtn('eraser', tr('清除页面'), act(() => o.clearPage(page)), 'danger'), rowBtn('trash', tr('删除页面'), act(() => o.deletePage(page)), 'danger')));
      pop.place();
    };
    fill();
  }

  about() {
    inform('Inkpad', tr('手写笔记、白板与 PDF 批注。') + '\nGPL-3.0');
  }

  /** @param {Element} anchor */
  exportMenu(anchor) {
    const run = (/** @type {string} */ fn) => () => import('../io/exporter.js').then(m => m[/** @type {'exportPdf'} */ (fn)](this)).catch(e => { console.error(e); toast(String(e.message || e)); });
    menuPopover(anchor, [
      { label: tr('导出为矢量 PDF…'), fn: run('exportPdf') }, { label: tr('导出当前页为图片…'), fn: run('exportPng') }, { label: tr('导出全部页面为图片…'), fn: run('exportPngAll') }, null,
      { label: tr('导出为 Goodnotes（实验性）…'), fn: run('exportGoodnotes') }, { label: tr('导出 .inkpad 文件…'), fn: run('exportInkpad') }], { align: 'end' });
  }

  // -- keys ----------------------------------------------------------------------------------------------------------------------

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const c = this.canvas;
    const t = /** @type {HTMLElement} */ (e.target);
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod) {
      if (typing && !(k === 's' || k === 'e')) return;
      let used = true;
      if (k === 'z' && !e.shiftKey) this.undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') this.redo();
      else if (k === 'c') { if (typing) return; this.selCopy(); }
      else if (k === 'v') { if (typing) return; this.paste(); }
      else if (k === 's') this.session.save().then(() => toast(tr('已保存')));
      else if (k === 'e') this.exportMenu(this.header.querySelector('[title="' + tr('导出') + '"]') || this.header);
      else if (k === 'f') this.showFind();
      else if (k === 'g') this.ops.gotoPage();
      else if (k === '+' || k === '=') c.zoomBy(1.2);
      else if (k === '-') c.zoomBy(1 / 1.2);
      else if (k === '0') c.fitWidth();
      else used = false;
      if (used) e.preventDefault();
      return;
    }
    if (typing) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'ArrowDown' && c.paging === 'horizontal') { c.scrollToPage(Math.min(this.doc.pages.length - 1, c.currentPageIndex() + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp' && c.paging === 'horizontal') { c.scrollToPage(Math.max(0, c.currentPageIndex() - 1)); e.preventDefault(); }
    else if (e.key === 'F11') { e.preventDefault(); if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.(); }
  }
}

export { merge, basename, dirname };
