// @ts-check
// Google Drive over fetch: the `DriveAPI` the sync works with (B:gdrive.py `Drive`; A:Sync/Drive.swift;
// PORTING.md 7.7). Requests carry an access token that is refreshed when it has run out.
import { DriveError } from './errors.js';
import { accessToken } from './googleauth.js';
import { tr } from '../core/i18n.js';
import { hexId } from '../core/uuid.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Inkpad';

/** A file name or id inside a Drive query: backslash and quote escaped (B did not; A does). @param {string} s */
const quoted = s => s.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

export class GoogleDrive {
  /** @param {import('../platform/vfs.js').Vfs} vfs */
  constructor(vfs) {
    this.vfs = vfs;
    /** @type {((got: number, total: number) => void)|null} */ this.onBytes = null;
  }

  /** @param {string} method @param {string} url @param {BodyInit|null} [body] @param {Record<string, string>} [headers] @returns {Promise<Response>} */
  async _open(method, url, body = null, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(url, { method, body, headers: { ...headers, Authorization: 'Bearer ' + await accessToken(this.vfs, attempt > 0) } });
      } catch (e) {
        if (e instanceof DriveError) throw e;
        throw new DriveError(tr('无法连接 Google Drive：%s').replace('%s', String((/** @type {any} */ (e)).message || e)));
      }
      if (r.status === 401 && attempt === 0) continue;   // the token was refused: one more try with a fresh one
      if (!r.ok) {
        const text = await r.text();
        let detail = text.slice(0, 300);
        try { detail = JSON.parse(text).error.message; } catch { /* plain text */ }
        throw new DriveError(tr('Google Drive 错误（%d）：%s').replace('%d', String(r.status)).replace('%s', detail), r.status);
      }
      return r;
    }
  }

  /** @param {string} method @param {string} url @param {any} [body] */
  async _json(method, url, body) {
    const r = await this._open(method, url, body === undefined ? null : JSON.stringify(body), body === undefined ? {} : { 'Content-Type': 'application/json' });
    return r.json();
  }

  /** @param {string} folder @returns {Promise<{id: string, name: string, mimeType: string, md5Checksum?: string}[]>} */
  async _children(folder) {
    const out = [];
    let page = null;
    for (;;) {
      const query = new URLSearchParams({ q: `'${quoted(folder)}' in parents and trashed = false`, pageSize: '1000', fields: 'nextPageToken, files(id, name, mimeType, md5Checksum)' });
      if (page) query.set('pageToken', page);
      const data = await this._json('GET', `${API}/files?${query}`);
      out.push(...(data.files || []));
      page = data.nextPageToken;
      if (!page) return out;
    }
  }

  /** Whether a file or folder is still there, and not in the bin. (One that has been binned still answers to its id.) @param {string} id */
  async alive(id) {
    try { return !(await this._json('GET', `${API}/files/${encodeURIComponent(id)}?fields=trashed`)).trashed; }
    catch (e) { if (e instanceof DriveError && e.code === 404) return false; throw e; }
  }

  /** @param {string} parent */
  async children(parent) {
    return (await this._children(parent)).map(f => ({ id: f.id, name: f.name, md5: f.md5Checksum ?? null, modified: 0 }));
  }

  /** The checksum of a file's content as it is on Drive at this moment. @param {string} id @returns {Promise<string|null>} */
  async md5(id) { return (await this._json('GET', `${API}/files/${encodeURIComponent(id)}?fields=md5Checksum`)).md5Checksum ?? null; }

  async root() {
    const query = new URLSearchParams({ q: `name = '${quoted(ROOT_NAME)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`, fields: 'files(id)' });
    const found = (await this._json('GET', `${API}/files?${query}`)).files || [];
    return found.length ? found[0].id : this.createFolder(ROOT_NAME, 'root');
  }

  /** @param {string} name @param {string} parent @returns {Promise<string|null>} */
  async find(name, parent) {
    const query = new URLSearchParams({ q: `name = '${quoted(name)}' and '${quoted(parent)}' in parents and trashed = false`, fields: 'files(id)' });
    const found = (await this._json('GET', `${API}/files?${query}`)).files || [];
    return found.length ? found[0].id : null;
  }

  /** @param {string} id */
  async getJSON(id) { return (await this._open('GET', `${API}/files/${encodeURIComponent(id)}?alt=media`)).json(); }

  /** Create or replace a small JSON file; returns its id. @param {string} name @param {any} value @param {string} parent @param {string|null} id */
  async putJSON(name, value, parent, id) {
    const boundary = 'inkpad' + hexId();
    const meta = id ? {} : { name, parents: [parent] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--`;
    const url = UPLOAD + (id ? '/' + encodeURIComponent(id) : '') + '?uploadType=multipart&fields=id';
    const r = await this._open(id ? 'PATCH' : 'POST', url, body, { 'Content-Type': 'multipart/related; boundary=' + boundary });
    return (await r.json()).id;
  }

  /** @param {string} id @param {string} name */
  async rename(id, name) { await this._json('PATCH', `${API}/files/${encodeURIComponent(id)}?fields=id`, { name }); }

  /** @param {string} name @param {string} parent */
  async createFolder(name, parent) { return (await this._json('POST', `${API}/files?fields=id`, { name, mimeType: FOLDER_MIME, parents: [parent] })).id; }

  /** Create or replace a file with a resumable upload; returns [id, md5]. The first request starts the session
   * (its Location header is the address to send the bytes to); the bytes go with XMLHttpRequest, which
   * can report upload progress where fetch cannot. @param {Blob} blob @param {string} name @param {string} parent @param {string|null} id @returns {Promise<[string, string|null]>} */
  async upload(blob, name, parent, id) {
    const [url, method, meta] = id
      ? [`${UPLOAD}/${encodeURIComponent(id)}?uploadType=resumable&fields=id,md5Checksum`, 'PATCH', {}]
      : [`${UPLOAD}?uploadType=resumable&fields=id,md5Checksum`, 'POST', { name, parents: [parent] }];
    const start = await this._open(method, url, JSON.stringify(meta), { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(blob.size) });
    const session = start.headers.get('Location');
    if (!session) throw new DriveError(tr('Google Drive 没有给出上传地址'));
    const token = await accessToken(this.vfs);
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', session);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.upload.onprogress = e => { if (this.onBytes && e.lengthComputable) this.onBytes(e.loaded, e.total); };
      xhr.onerror = () => reject(new DriveError(tr('无法连接 Google Drive：%s').replace('%s', 'upload')));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); } }
        else {
          let detail = xhr.responseText.slice(0, 300);
          try { detail = JSON.parse(xhr.responseText).error.message; } catch { /* plain */ }
          reject(new DriveError(tr('Google Drive 错误（%d）：%s').replace('%d', String(xhr.status)).replace('%s', detail), xhr.status));
        }
      };
      xhr.send(blob);
    });
    return [/** @type {any} */ (data).id, /** @type {any} */ (data).md5Checksum ?? null];
  }

  /** @param {string} id @returns {Promise<Blob>} */
  async download(id) {
    const r = await this._open('GET', `${API}/files/${encodeURIComponent(id)}?alt=media`);
    const total = Number(r.headers.get('Content-Length') || 0);
    if (!r.body) return r.blob();
    const reader = r.body.getReader();
    /** @type {Uint8Array[]} */ const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (this.onBytes && total) this.onBytes(got, total);
    }
    return new Blob(/** @type {BlobPart[]} */ (chunks));
  }

  /** @param {string} id */
  async trash(id) { await this._json('PATCH', `${API}/files/${encodeURIComponent(id)}?fields=id`, { trashed: true }); }
}
