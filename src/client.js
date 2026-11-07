'use strict';

const https = require('node:https');
const path = require('node:path').posix;
const { randomBytes } = require('node:crypto');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const READ_OPERATIONS = new Set(['list_files', 'get_file_content']);

function normalizeServer(input) {
  const value = String(input).trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  let url;
  try {
    url = new URL(hasScheme ? value : `https://${value}`);
  } catch {
    throw new Error('Enter a valid cPanel hostname or HTTPS address.');
  }
  if (url.protocol !== 'https:') throw new Error('Use HTTPS for the cPanel connection.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter only the cPanel server address, without a login session, path, or credentials.');
  }
  if (!url.hostname) throw new Error('Enter a cPanel hostname.');
  // A bare hostname uses cPanel’s standard port. Full HTTPS URLs keep their port.
  if (!hasScheme && !url.port && !/:443$/.test(value)) url.port = '2083';
  return url.origin;
}

function normalizeDirectory(input) {
  const value = String(input).trim();
  if (!value.startsWith('/') || /[\0\r\n]/.test(value)) {
    throw new Error('Enter an absolute server folder, for example /home/username/public_html.');
  }
  const normalized = path.normalize(value);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function validUsername(value) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
}

function validateToken(value) {
  if (!value || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Enter an API token without spaces or line breaks.');
  }
}

class CpanelClient {
  constructor(profile, token, transport = https) {
    this.server = normalizeServer(profile.server);
    if (!validUsername(profile.username)) throw new Error('Enter a valid cPanel username.');
    validateToken(token);
    this.username = profile.username;
    this.token = token;
    this.transport = transport;
  }

  async request(operation, parameters) {
    if (!READ_OPERATIONS.has(operation)) throw new Error('Unsupported read operation.');
    const url = new URL(`/execute/Fileman/${operation}`, this.server);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));

    return this.send(url, { method: 'GET' });
  }

  async uploadFile(filename, content, { overwrite = true } = {}) {
    const fullpath = validateFilePath(filename);
    const bytes = Buffer.from(content);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Choose a text file smaller than 2 MB.');
    const boundary = `----cpanel-open-${randomBytes(16).toString('hex')}`;
    const basename = path.basename(fullpath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="dir"\r\n\r\n${path.dirname(fullpath)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\n${overwrite ? 1 : 0}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file-1"; filename="${basename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return this.send(new URL('/execute/Fileman/upload_files', this.server), {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, body);
  }

  async send(url, options, body) {
    return new Promise((resolve, reject) => {
      const request = this.transport.request(url, {
        ...options,
        headers: {
          Authorization: `cpanel ${this.username}:${this.token}`,
          Accept: 'application/json',
          ...options.headers
        }
      }, response => {
        const status = response.statusCode || 0;
        if (status !== 200) {
          response.resume();
          if (status === 401 || status === 403) {
            reject(new Error('cPanel refused access. Check your username, token expiry, and host API access. Use “cPanel: Connect / Change Connection…” to reconnect.'));
          } else if (status >= 300 && status < 400) {
            reject(new Error('cPanel redirected the request. Use the direct cPanel HTTPS address, usually on port 2083.'));
          } else {
            reject(new Error(`cPanel returned HTTP ${status}.`));
          }
          return;
        }
        const chunks = [];
        let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            const error = new Error('The cPanel response is too large for this prototype.');
            reject(error);
            request.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('The cPanel response was interrupted. Please try again.')));
        response.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (payload.status !== 1) {
              const errors = Array.isArray(payload.errors) ? payload.errors.join('; ') : '';
              const message = errors ? errors.split(this.token).join('[redacted]') : 'The API operation failed.';
              reject(new Error(`cPanel: ${message}`));
              return;
            }
            resolve(payload.data);
          } catch {
            reject(new Error('cPanel returned an unexpected response. Check the server address and API availability.'));
          }
        });
      });
      request.setTimeout(30000, () => request.destroy(new Error('timeout')));
      request.on('error', error => {
        const messages = {
          ENOTFOUND: 'The cPanel hostname could not be found.',
          ECONNREFUSED: 'The cPanel connection was refused. Check the hostname and port.',
          ETIMEDOUT: 'The cPanel connection timed out.',
          CERT_HAS_EXPIRED: 'The server’s HTTPS certificate has expired.',
          DEPTH_ZERO_SELF_SIGNED_CERT: 'The server’s HTTPS certificate is not trusted.',
          UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The server’s HTTPS certificate could not be verified.'
        };
        reject(new Error(error.message === 'timeout' ? 'The cPanel connection timed out.' :
          messages[error.code] || 'Could not complete the secure cPanel connection. Check your server and network.'));
      });
      request.end(body);
    });
  }

  async listFiles(directory) {
    const data = await this.request('list_files', { dir: normalizeDirectory(directory), include_mime: 1 });
    if (!Array.isArray(data)) throw new Error('cPanel returned an unexpected folder listing.');
    return data.filter(entry => {
      return entry && typeof entry.file === 'string' && entry.file &&
        !['.', '..'].includes(entry.file) && !/[\/\0\r\n]/.test(entry.file) &&
        ['dir', 'file'].includes(entry.type);
    }).map(entry => ({
      name: entry.file,
      directory: entry.type === 'dir',
      size: Number(entry.size) || 0,
      mtime: Number(entry.mtime) || 0,
      mime: entry.mimetype || ''
    })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }

  async readFile(filename, { forEditing = false } = {}) {
    // Preserve spaces in the selected filename; only form inputs are trimmed.
    const fullpath = validateFilePath(filename);
    const data = await this.request('get_file_content', {
      dir: path.dirname(fullpath), file: path.basename(fullpath), to_charset: 'UTF-8'
    });
    if (!data || typeof data.content !== 'string') throw new Error('cPanel did not return text content for this file.');
    if (Buffer.byteLength(data.content, 'utf8') > MAX_FILE_BYTES) throw new Error('Choose a text file smaller than 2 MB.');
    if (data.content.includes('\0')) throw new Error('This prototype opens text files only. Choose a code or text file.');
    if (forEditing && data.content.length > 0 && !['utf-8', 'utf8', 'us-ascii', 'ascii'].includes(String(data.from_charset || '').toLowerCase())) {
      throw new Error('Editing currently supports UTF-8 and ASCII files only. This file’s original encoding could not be safely preserved.');
    }
    return data.content;
  }
}

function validateFilePath(filename) {
  if (typeof filename !== 'string' || !filename.startsWith('/') || /[\0\r\n]/.test(filename)) {
    throw new Error('Choose a valid absolute file path.');
  }
  return path.normalize(filename);
}

module.exports = { CpanelClient, MAX_FILE_BYTES, normalizeServer, normalizeDirectory, validUsername, validateToken };
