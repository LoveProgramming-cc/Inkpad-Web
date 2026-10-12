// A Drive kept in memory, shared by the "devices" of a test (A:InkpadTests/SyncTests.swift FakeDrive).
import { md5Blob } from '../src/core/hash.js';
import { DriveError } from '../src/sync/errors.js';

export class Cloud {
  constructor() {
    /** @type {Map<string, {name: string, data: Blob}>} */
    this.files = new Map();
    this.n = 0;
  }
  named(name) { return [...this.files].filter(([, f]) => f.name === name); }
  startingWith(prefix) { return [...this.files].filter(([, f]) => f.name.startsWith(prefix)); }
}

export class FakeDrive {
  /** @param {Cloud} cloud */
  constructor(cloud) {
    this.cloud = cloud;
    this.onBytes = null;
    this.uploads = 0;
    this.downloads = 0;
    /** Something that another device does at a chosen moment of this one's sync. */
    this.afterIndex = null;
    this.afterMD5 = null;
  }

  _newId() { this.cloud.n += 1; return 'file' + this.cloud.n; }

  async root() { return 'root'; }

  async find(name) {
    for (const [id, f] of this.cloud.files) if (f.name === name) return id;
    return null;
  }

  async getJSON(id) {
    const f = this.cloud.files.get(id);
    if (!f) throw new DriveError('not found', 404);
    const out = JSON.parse(await f.data.text());
    if (this.afterIndex) {
      const then = this.afterIndex;
      this.afterIndex = null;
      await then();
    }
    return out;
  }

  async putJSON(name, value, parent, id) {
    id = id ?? this._newId();
    this.cloud.files.set(id, { name: this.cloud.files.get(id)?.name ?? name, data: new Blob([JSON.stringify(value)]) });
    return id;
  }

  async rename(id, name) { this.cloud.files.get(id).name = name; }

  async upload(blob, name, parent, id) {
    id = id ?? this._newId();
    this.cloud.files.set(id, { name: this.cloud.files.get(id)?.name ?? name, data: blob });
    this.uploads++;
    return [id, await md5Blob(blob)];
  }

  async download(id) {
    const f = this.cloud.files.get(id);
    if (!f) throw new DriveError('not found', 404);
    this.downloads++;
    return f.data;
  }

  async alive(id) { return id === 'root' || id.startsWith('folder') || this.cloud.files.has(id); }

  async md5(id) {
    const f = this.cloud.files.get(id);
    const out = f ? await md5Blob(f.data) : null;
    if (this.afterMD5) {
      const then = this.afterMD5;
      this.afterMD5 = null;
      await then();
    }
    return out;
  }

  async children() {
    const out = [];
    for (const [id, f] of this.cloud.files) {
      // Ids are handed out in order, so the number in one says how new the file is.
      out.push({ id, name: f.name, md5: await md5Blob(f.data), modified: Number(id.slice(4)) || 0 });
    }
    return out;
  }
}

/** A drive that passes everything on and notes what was asked of it. */
export class Wrapped {
  constructor(inner) {
    this.inner = inner;
    this.calls = [];
    this.onBytes = null;
    for (const m of ['root', 'find', 'getJSON', 'putJSON', 'rename', 'upload', 'download', 'children', 'alive', 'md5']) {
      this[m] = async (...args) => {
        this.calls.push(m);
        await this.before?.(m);
        return this.inner[m](...args);
      };
    }
  }
}
