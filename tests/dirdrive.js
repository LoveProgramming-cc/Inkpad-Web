// Drive as a folder on disk, so that this code and B's own Python can sync with each other in a
// test (A:InkpadTests/CompatTests.swift DirDrive; tools/compat.py has the same on the Python side).
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class DirDrive {
  constructor(dir) {
    this.dir = dir;
    this.onBytes = null;
    mkdirSync(dir, { recursive: true });
  }

  _names() {
    try { return JSON.parse(readFileSync(join(this.dir, 'names.json'), 'utf8')); } catch { return {}; }
  }
  _setName(id, name) {
    const names = this._names();
    names[id] = name;
    writeFileSync(join(this.dir, 'names.json'), JSON.stringify(names));
  }
  _file(id) { return join(this.dir, id + '.bin'); }
  _newId() { return 'f' + randomUUID().replaceAll('-', '').slice(0, 8); }
  _write(id, bytes) { writeFileSync(this._file(id) + '.tmp', bytes); renameSync(this._file(id) + '.tmp', this._file(id)); }
  _md5(id) { try { return createHash('md5').update(readFileSync(this._file(id))).digest('hex'); } catch { return null; } }

  async root() { return 'root'; }
  async alive(id) { return id === 'root' || existsSync(this._file(id)); }
  async children() { return Object.entries(this._names()).map(([id, name]) => ({ id, name, md5: this._md5(id), modified: 0 })); }
  async md5(id) { return this._md5(id); }
  async find(name) { return Object.entries(this._names()).find(([, n]) => n === name)?.[0] ?? null; }
  async getJSON(id) { return JSON.parse(readFileSync(this._file(id), 'utf8')); }
  async putJSON(name, value, parent, id) {
    const fid = id ?? this._newId();
    this._write(fid, JSON.stringify(value));
    if (!id) this._setName(fid, name);
    return fid;
  }
  async rename(id, name) { this._setName(id, name); }
  async upload(blob, name, parent, id) {
    const fid = id ?? this._newId();
    this._write(fid, Buffer.from(await blob.arrayBuffer()));
    if (!id) this._setName(fid, name);
    return [fid, this._md5(fid)];
  }
  async download(id) { return new Blob([readFileSync(this._file(id))]); }
}
