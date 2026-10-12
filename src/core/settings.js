// @ts-check
// Tool and app preferences (B:settings.py), kept in the store's kv table under 'settings'.

export const DEFAULTS = {
  pen_type: 'fountain',
  // Per pen: three width presets (points), the active preset, pressure
  // sensitivity and stabilisation in percent.
  pens: {
    fountain: { widths: [0.9, 1.6, 2.8], slot: 1, sens: 50, stab: 0, dash: 0 },
    ball: { widths: [0.7, 1.2, 2.0], slot: 1, sens: 50, stab: 0, dash: 0 },
    brush: { widths: [1.4, 2.4, 3.8], slot: 1, sens: 50, stab: 0, dash: 0 },
  },
  pen_colors: [[0.29, 0.62, 0.96], [0.66, 0.11, 0.94], [0.94, 0.24, 0.24],
    [0.49, 0.76, 0.19], [0.0, 0.0, 0.0], [1.0, 0.6, 0.12]],
  pen_color: 4,
  hl_colors: [[1.0, 0.88, 0.3], [0.56, 0.89, 0.41], [1.0, 0.54, 0.82], [0.49, 0.77, 1.0], [1.0, 0.7, 0.28]],
  hl_color: 0,
  hl_w: 1,
  hl_widths: [8.0, 14.0, 22.0],
  laser_mode: 'trail',
  palm_ms: 80,
  input_log: false,
  last_folder: '',
  views: {},
  note_color: 0,
  tape_color: 0,
  tape_w: 1,
  mouse_hand: true,
  paging: 'vertical',
  scrollbars: true,
  sync_every: 30,
  max_zoom: 6.0,
  hidden_tools: [],
  crosshair: true,
  laser_color: 0,
  eraser_size: 1,
  eraser_mode: 'standard',
  erase_filter: ['pen', 'hl', 'shape'],
  eraser_auto: false,
  lasso_rect: false,
  lasso_filter: ['ink', 'image', 'shape', 'text'],
  shape_kind: 'line',
  text_size: 1,
  hold_shape: true,
  scribble_erase: true,
  finger_draw: false,
  template: { w: 595.0, h: 842.0, paper: 'blank', color: [1.0, 1.0, 1.0] },
  sort: 'date',
  theme: 'system',
  language: 'auto',
  add_pos: 'after',
};

/** @template T @param {T} v @returns {T} */
export function copy(v) { return JSON.parse(JSON.stringify(v)); }

/** Python's `type(a) is type(b)` for JSON values. */
function sameType(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b);
  if (a === null || b === null) return a === b;
  return typeof a === typeof b;
}

/** The defaults, with whatever was saved laid over them (values of the wrong type are ignored).
 * @param {any} saved @returns {typeof DEFAULTS & Record<string, any>} */
export function fromSaved(saved) {
  /** @type {any} */
  const st = copy(DEFAULTS);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return st;
  for (const [key, value] of Object.entries(saved)) {
    if (key === 'pens' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, pen] of Object.entries(/** @type {Record<string, any>} */ (value))) {
        if (name in st.pens && pen && typeof pen === 'object' && !Array.isArray(pen)) Object.assign(st.pens[name], pen);
      }
    } else if (key in st && sameType(value, st[key])) {
      st[key] = value;
    }
  }
  return st;
}

/** @param {import('../platform/vfs.js').Vfs} vfs */
export async function loadSettings(vfs) {
  return fromSaved(await vfs.kvGet('settings'));
}

/** @param {import('../platform/vfs.js').Vfs} vfs @param {any} st */
export async function saveSettings(vfs, st) {
  await vfs.kvSet('settings', st);
}
