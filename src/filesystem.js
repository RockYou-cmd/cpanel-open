'use strict';

const path = require('node:path').posix;
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { MAX_FILE_BYTES } = require('./client');

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function authority(profile) { return hash(`${profile.server}\n${profile.username}`).slice(-16); }

class CpanelFileSystem {
  constructor(api, { getConnection, baselines, backups, onSaved = () => {} }) {
    this.api = api;
    this.getConnection = getConnection;
    this.baselines = baselines;
    this.backups = backups;
    this.onSaved = onSaved;
    this.files = new Map();
    this.writes = new Map();
    this.emitter = new api.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
  }

  baselineKey(uri) { return `cpanel-open.baseline.${hash(uri.toString())}`; }

  async connectionFor(uri) {
    const active = await this.getConnection();
    if (!active || uri.scheme !== 'cpanel-open' || uri.authority !== authority(active.profile)) {
      throw this.api.FileSystemError.NoPermissions('Reconnect to this file’s cPanel account before opening or saving it.');
    }
    const relative = path.relative(active.profile.root, uri.path);
    if (!uri.path.startsWith('/') || /[\0\r\n]/.test(uri.path) || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw this.api.FileSystemError.NoPermissions('Choose a file within the connected starting folder.');
    }
    return active;
  }

  async remoteBytes(active, uri) {
    return Buffer.from(await active.client.readFile(uri.path, { forEditing: true }), 'utf8');
  }

  async prepareFile(uri, canReplace = () => true) {
    const active = await this.connectionFor(uri);
    const bytes = await this.remoteBytes(active, uri);
    // A user may have started typing while the remote request was running.
    if (!canReplace()) return;
    const previous = this.files.get(uri.toString());
    const previousExpected = previous?.expected || this.baselines.get(this.baselineKey(uri));
    const expected = hash(bytes);
    await this.baselines.update(this.baselineKey(uri), expected);
    if (!canReplace()) {
      await this.baselines.update(this.baselineKey(uri), previousExpected);
      return;
    }
    this.files.set(uri.toString(), { bytes, expected, mtime: Math.max(Date.now(), (previous?.mtime || 0) + 1), prepared: true });
    if (previous && !previous.bytes.equals(bytes)) this.changed(uri);
  }

  async stat(uri) {
    const active = await this.connectionFor(uri);
    const cached = this.files.get(uri.toString());
    if (cached) return { type: this.api.FileType.File, ctime: 0, mtime: cached.mtime, size: cached.bytes.length };
    if (uri.path === active.profile.root) return { type: this.api.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const entry = (await active.client.listFiles(path.dirname(uri.path))).find(item => item.name === path.basename(uri.path));
    if (!entry) throw this.api.FileSystemError.FileNotFound(uri);
    return { type: entry.directory ? this.api.FileType.Directory : this.api.FileType.File, ctime: 0, mtime: entry.mtime * 1000 || 0, size: entry.size };
  }

  async readDirectory(uri) {
    const active = await this.connectionFor(uri);
    return (await active.client.listFiles(uri.path)).map(entry => [entry.name, entry.directory ? this.api.FileType.Directory : this.api.FileType.File]);
  }

  async readFile(uri) {
    const active = await this.connectionFor(uri);
    const cached = this.files.get(uri.toString());
    if (cached?.prepared) {
      cached.prepared = false;
      return Buffer.from(cached.bytes);
    }
    const bytes = await this.remoteBytes(active, uri);
    // Keep the expected revision across restarts. Restoring an unsaved editor
    // must not silently adopt someone else’s newer server revision as its base.
    const expected = cached?.expected || this.baselines.get(this.baselineKey(uri)) || hash(bytes);
    if (!this.baselines.get(this.baselineKey(uri))) await this.baselines.update(this.baselineKey(uri), expected);
    this.files.set(uri.toString(), { bytes, expected, mtime: Date.now(), prepared: false });
    return Buffer.from(bytes);
  }

  async writeFile(uri, content, options) {
    const key = uri.toString();
    const previous = this.writes.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(() => this.save(uri, Buffer.from(content), options));
    this.writes.set(key, queued);
    try { return await queued; }
    finally { if (this.writes.get(key) === queued) this.writes.delete(key); }
  }

  async save(uri, bytes, options) {
    const active = await this.connectionFor(uri);
    if (!options.overwrite) throw this.api.FileSystemError.NoPermissions('This version edits existing files only.');
    if (bytes.length > MAX_FILE_BYTES) throw this.api.FileSystemError.NoPermissions('Files must stay smaller than 2 MB.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw this.api.FileSystemError.NoPermissions('Save this file using UTF-8 encoding.'); }
    if (bytes.includes(0)) throw this.api.FileSystemError.NoPermissions('Binary file writes are not supported.');

    const key = uri.toString();
    const expected = this.files.get(key)?.expected || this.baselines.get(this.baselineKey(uri));
    if (!expected) throw this.api.FileSystemError.NoPermissions('Open this file from the cPanel sidebar before saving it.');
    const current = await this.remoteBytes(active, uri);
    if (current.equals(bytes)) {
      await this.commit(uri, bytes);
      this.onSaved(uri);
      return;
    }
    if (hash(current) !== expected) throw this.conflict();

    let backup;
    try { backup = await this.backups.create(active.profile, uri.path, current); }
    catch { throw this.api.FileSystemError.Unavailable('Could not create a local backup. Nothing was uploaded; your edits remain unsaved.'); }

    // Recheck after writing the backup, immediately before the upload. UAPI
    // does not provide an atomic compare-and-swap, so a small race still exists.
    const latest = await this.connectionFor(uri);
    if (hash(await this.remoteBytes(latest, uri)) !== expected) throw this.conflict();
    let uploadError;
    try { await latest.client.uploadFile(uri.path, bytes); }
    catch (error) { uploadError = error; }
    let verified;
    try { verified = await this.remoteBytes(latest, uri); }
    catch {
      throw this.api.FileSystemError.Unavailable('The save could not be verified. The server may have received it. Your edits remain unsaved; retry Save to check again. A local backup was kept.');
    }
    if (!verified.equals(bytes)) {
      const message = uploadError ? uploadError.message : 'The server did not return the exact uploaded contents.';
      throw this.api.FileSystemError.Unavailable(`Save was not confirmed: ${message} Your edits remain unsaved; a local backup was kept.`);
    }
    await this.commit(uri, bytes);
    this.onSaved(uri, backup);
  }

  conflict() {
    return this.api.FileSystemError.NoPermissions('The server file changed since you opened it. Nothing was uploaded. Keep a copy of your edits, revert this tab, then reopen it from the cPanel sidebar and merge your changes.');
  }

  async commit(uri, bytes) {
    const key = uri.toString();
    const previous = this.files.get(key);
    const expected = hash(bytes);
    this.files.set(key, { bytes: Buffer.from(bytes), expected, mtime: Math.max(Date.now(), (previous?.mtime || 0) + 1), prepared: false });
    try { await this.baselines.update(this.baselineKey(uri), expected); }
    catch { throw this.api.FileSystemError.Unavailable('Saved on the server, but local save tracking could not be updated. Press Save again to retry tracking.'); }
    this.changed(uri);
  }

  changed(uri) { this.emitter.fire([{ type: this.api.FileChangeType.Changed, uri }]); }
  close(uri) { if (!this.writes.has(uri.toString())) this.files.delete(uri.toString()); }
  watch() { return { dispose() {} }; }
  createDirectory() { throw this.api.FileSystemError.NoPermissions('Creating folders is not supported in this version.'); }
  delete() { throw this.api.FileSystemError.NoPermissions('Deleting remote files is not supported in this version.'); }
  rename() { throw this.api.FileSystemError.NoPermissions('Renaming remote files is not supported in this version.'); }
  dispose() { this.files.clear(); this.emitter.dispose(); }
}

module.exports = { CpanelFileSystem };
