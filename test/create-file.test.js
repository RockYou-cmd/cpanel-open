'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path').posix;
const { test } = require('node:test');
const { CpanelClient } = require('../src/client');
const { CpanelFileSystem } = require('../src/filesystem');

const profile = { server: 'https://example.test:2083', username: 'user', root: '/home/user/public_html' };
const uri = {
  scheme: 'cpanel-open',
  authority: createHash('sha256').update(`${profile.server}\n${profile.username}`).digest('hex').slice(-16),
  path: `${profile.root}/sub/.notes.txt`,
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
};
const create = { create: true, overwrite: false };
const save = { create: true, overwrite: true };

function setup({ existing, beforeUpload, parentExists = true } = {}) {
  let content = existing;
  const uploads = [];
  const backups = [];
  const events = [];
  const baselines = new Map();
  const client = new CpanelClient(profile, 'test-token');
  client.send = async (url, options, body) => {
    if (url.pathname.endsWith('/list_files')) {
      assert.equal(url.searchParams.get('dir'), path.dirname(uri.path));
      if (!parentExists) throw new Error('Folder not found');
      return content === undefined ? [] : [{ file: path.basename(uri.path), type: 'file' }];
    }
    if (url.pathname.endsWith('/get_file_content')) {
      assert.equal(url.searchParams.get('file'), path.basename(uri.path));
      if (content === undefined) throw new Error('File not found');
      return content ? { content, from_charset: 'UTF-8' } : { content };
    }
    assert.equal(url.pathname, '/execute/Fileman/upload_files');
    assert.equal(options.method, 'POST');
    const parts = body.toString('utf8').split(options.headers['Content-Type'].split('boundary=')[1]);
    const overwriteField = parts[2].match(/name="overwrite"\r\n\r\n([01])\r\n/);
    assert.ok(overwriteField);
    const overwrite = overwriteField[1] === '1';
    assert.match(parts[1], /name="dir"/);
    assert.ok(parts[1].includes(path.dirname(uri.path)));
    assert.ok(parts[3].includes(`filename="${path.basename(uri.path)}"`));
    uploads.push(overwrite);
    if (beforeUpload) content = beforeUpload();
    if (!overwrite && content !== undefined) return { failed: 1, succeeded: 0 };
    content = parts[3].split('\r\n\r\n')[1].slice(0, -4);
    return { failed: 0, succeeded: 1 };
  };

  const filesystem = new CpanelFileSystem({
    EventEmitter: class { fire(changes) { events.push(...changes); } },
    FileChangeType: { Created: 2, Changed: 1 },
    FileSystemError: {
      FileExists: () => new Error('File already exists'),
      NoPermissions: message => new Error(message),
      Unavailable: message => new Error(message)
    }
  }, {
    getConnection: () => ({ profile, client }),
    baselines: { get: key => baselines.get(key), update: (key, value) => baselines.set(key, value) },
    backups: { create: (_profile, _path, bytes) => backups.push(bytes.toString()) }
  });
  return { filesystem, uploads, backups, events, content: () => content };
}

test('creates a blank dotfile and backs up that blank version on the first edit', async () => {
  const { filesystem, uploads, backups, events, content } = setup();
  await filesystem.writeFile(uri, Buffer.alloc(0), create);
  assert.equal(content(), '');
  assert.equal(events[0].type, 2);
  assert.deepEqual(await filesystem.readFile(uri), Buffer.alloc(0));
  assert.deepEqual(backups, []);

  await filesystem.writeFile(uri, Buffer.from('Hello'), save);
  assert.equal(content(), 'Hello');
  assert.deepEqual(uploads, [false, true]);
  assert.deepEqual(backups, ['']);
});

test('rejects a duplicate before uploading', async () => {
  const { filesystem, uploads, content } = setup({ existing: 'Keep this' });
  await assert.rejects(filesystem.writeFile(uri, Buffer.alloc(0), create), /already exists/);
  assert.deepEqual(uploads, []);
  assert.equal(content(), 'Keep this');
});

test('rejects a competing creation even when the other file is empty', async () => {
  const { filesystem, uploads, events, content } = setup({ beforeUpload: () => '' });
  await assert.rejects(filesystem.writeFile(uri, Buffer.alloc(0), create), /successful upload/);
  assert.deepEqual(uploads, [false]);
  assert.deepEqual(events, []);
  assert.equal(content(), '');
});

test('does not upload when the destination folder disappeared', async () => {
  const { filesystem, uploads } = setup({ parentExists: false });
  await assert.rejects(filesystem.writeFile(uri, Buffer.alloc(0), create), /Folder not found/);
  assert.deepEqual(uploads, []);
});
