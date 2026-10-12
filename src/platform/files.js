// @ts-check
// Choosing files, saving files, and files dropped on the window. PORTING.md 5.4.

/**
 * Ask for files with the browser's file chooser.
 * @param {{accept?: string, multiple?: boolean, directory?: boolean}} [o]
 * @returns {Promise<File[]>} none if the dialog was cancelled
 */
export function pickFiles({ accept = '', multiple = false, directory = false } = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.multiple = multiple;
    if (directory) /** @type {any} */ (input).webkitdirectory = true;
    input.style.display = 'none';
    document.body.append(input);
    let done = false;
    const finish = (/** @type {File[]} */ files) => { if (!done) { done = true; input.remove(); resolve(files); } };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

/**
 * Save a Blob for the user: through the save dialog where the browser has one, otherwise a download.
 * @param {Blob} blob @param {string} name @param {{description?: string, accept?: Record<string, string[]>}} [types]
 * @returns {Promise<boolean>} false if the user cancelled
 */
export async function saveBlob(blob, name, types) {
  const picker = /** @type {any} */ (window).showSaveFilePicker;
  if (picker && types) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description: types.description ?? '', accept: types.accept ?? {} }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') return false;
      // anything else (a refused permission, say): fall back to a download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/**
 * Files in a dropped folder, with their path inside it.
 * @param {DataTransferItemList} items @returns {Promise<{rel: string, file: File}[]>}
 */
export async function droppedTree(items) {
  /** @type {{rel: string, file: File}[]} */
  const out = [];
  /** @param {any} entry @param {string} prefix */
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ rel: prefix + entry.name, file: /** @type {File} */ (file) });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!(/** @type {any[]} */ (batch)).length) break;
        for (const e of /** @type {any[]} */ (batch)) await walk(e, prefix + entry.name + '/');
      }
    }
  };
  const entries = [...items].map(i => /** @type {any} */ (i).webkitGetAsEntry?.()).filter(Boolean);
  for (const e of entries) await walk(e, '');
  return out;
}

/** Files chosen with webkitdirectory, as the same list. @param {File[]} files */
export function pickedTree(files) {
  return files.map(f => ({ rel: /** @type {any} */ (f).webkitRelativePath || f.name, file: f }));
}
