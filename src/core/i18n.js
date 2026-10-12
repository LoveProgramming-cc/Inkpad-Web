// @ts-check
// Interface text. Source strings are Simplified Chinese; other languages look them up.
// The tables (from A:Resources/en.json, ja.json) are loaded by `setTables`; a string that has
// no entry is shown as written.

/** @type {'zh'|'en'|'ja'} */
let lang = 'zh';
/** @type {Record<string, Record<string, string>>} */
let tables = { en: {}, ja: {} };

/** @param {'zh'|'en'|'ja'} l */
export function setLang(l) { lang = l; }
export function getLang() { return lang; }

/** @param {Record<string, Record<string, string>>} t  {en: {...}, ja: {...}} */
export function setTables(t) { tables = { en: t.en || {}, ja: t.ja || {} }; }

/** The language to use for a `language` setting ('auto' follows the browser). @param {string} setting */
export function resolveLang(setting, navLang = (typeof navigator !== 'undefined' ? navigator.language : 'zh') || 'zh') {
  if (setting === 'zh' || setting === 'en' || setting === 'ja') return setting;
  const p = navLang.toLowerCase();
  return p.startsWith('ja') ? 'ja' : p.startsWith('zh') ? 'zh' : p.startsWith('en') ? 'en' : 'en';
}

/** @param {string} text */
export function tr(text) {
  if (lang === 'zh') return text;
  return tables[lang]?.[text] ?? text;
}

/** Translate and fill in %d / %s / %% like Python's `%` operator. @param {string} text @param {...any} args */
export function trf(text, ...args) {
  let i = 0;
  return tr(text).replace(/%([ds%])/g, (_, c) => (c === '%' ? '%' : String(args[i++])));
}

/** Switch the interface language: fetches the table for en or ja (zh is the source text).
 * @param {string} setting 'auto' | 'zh' | 'en' | 'ja' @param {string} [base] where the data files are */
export async function useLanguage(setting, base = new URL('../data/', import.meta.url).href) {
  const l = resolveLang(setting);
  if (l !== 'zh' && !Object.keys(tables[l] || {}).length) {
    try {
      const [table, web] = await Promise.all([fetch(base + l + '.json').then(r => r.json()), fetch(base + 'web.json').then(r => r.json()).catch(() => ({}))]);
      tables = { ...tables, [l]: { ...table, ...(web[l] || {}) } };   // A's tables, plus what only the web version says
    } catch { /* the source text is shown */ }
  }
  setLang(l);
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'zh' ? 'zh-CN' : l;
  return l;
}

/** strftime for the few formats the tables use: %Y %m %-m %d %-d %H %M %b. @param {string} fmt @param {number} t seconds */
export function fmtDate(fmt, t) {
  const d = new Date(t * 1000);
  const p2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return fmt.replace(/%(-?)([YmdHMb])/g, (_, dash, c) => {
    switch (c) {
      case 'Y': return String(d.getFullYear());
      case 'm': return dash ? String(d.getMonth() + 1) : p2(d.getMonth() + 1);
      case 'd': return dash ? String(d.getDate()) : p2(d.getDate());
      case 'H': return p2(d.getHours());
      case 'M': return p2(d.getMinutes());
      default: return months[d.getMonth()];
    }
  });
}
