'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

class LocalBackups {
  constructor(directory) { this.directory = directory; }

  async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    return this.directory;
  }

  async create(profile, filename, bytes) {
    await this.ensureDirectory();
    const timestamp = new Date().toISOString();
    const name = path.posix.basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
    const backup = path.join(this.directory, `${timestamp.replace(/[:.]/g, '-')}-${randomUUID()}-${name}.bak`);
    await fs.writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(`${backup}.json`, JSON.stringify({
      server: profile.server, username: profile.username, file: filename, createdAt: timestamp,
      encoding: 'UTF-8', sha256: createHash('sha256').update(bytes).digest('hex')
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return backup;
  }
}

module.exports = { LocalBackups };
