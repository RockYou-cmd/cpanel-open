'use strict';

const path = require('node:path').posix;
const { createHash } = require('node:crypto');

function connectionId(profile) {
  return createHash('sha256').update(`${profile.server}\n${profile.username}\n${profile.root}`).digest('hex');
}

function documentAuthority(profile) {
  return createHash('sha256').update(`${profile.server}\n${profile.username}`).digest('hex').slice(-16);
}

// A listing is requested only for the folder passed to getChildren. The cache
// holds listing promises, so simultaneous expands do not send duplicate calls.
class CpanelTreeProvider {
  constructor(api, restoreConnection, onConnectionChanged) {
    this.api = api;
    this.restoreConnection = restoreConnection;
    this.onConnectionChanged = onConnectionChanged;
    this.connection = undefined;
    this.restoring = undefined;
    this.generation = 0;
    this.cache = new Map();
    this.emitter = new api.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  async getConnection() {
    if (this.connection !== undefined) return this.connection;
    if (this.restoring) return this.restoring;
    const generation = this.generation;
    const pending = Promise.resolve().then(() => this.restoreConnection()).then(connection => {
      if (generation !== this.generation) return undefined;
      this.connection = connection || null;
      this.onConnectionChanged(this.connection);
      return this.connection;
    }).finally(() => {
      if (this.restoring === pending) this.restoring = undefined;
    });
    this.restoring = pending;
    return pending;
  }

  setConnection(connection, entries) {
    this.generation++;
    this.cache.clear();
    this.restoring = undefined;
    this.connection = connection || null;
    if (connection && entries) this.cache.set(connection.profile.root, Promise.resolve(entries));
    this.onConnectionChanged(this.connection);
    this.emitter.fire(undefined);
  }

  refresh() {
    this.generation++;
    this.cache.clear();
    // Reload SecretStorage as well, without prompting on a passive refresh.
    this.connection = undefined;
    this.restoring = undefined;
    this.emitter.fire(undefined);
  }

  isCurrent(node) {
    return Boolean(node && this.connection && node.generation === this.generation &&
      node.connectionId === connectionId(this.connection.profile));
  }

  async getChildren(node) {
    const generation = this.generation;
    try {
      const connection = await this.getConnection();
      if (!connection || generation !== this.generation) return [];
      const { profile, client } = connection;
      if (!node) {
        return [{
          name: path.basename(profile.root) || '/', path: profile.root, directory: true,
          root: true, generation, connectionId: connectionId(profile), authority: documentAuthority(profile)
        }];
      }
      if (!this.isCurrent(node) || !node.directory || node.error) return [];
      let pending = this.cache.get(node.path);
      if (!pending) {
        pending = client.listFiles(node.path);
        this.cache.set(node.path, pending);
      }
      let entries;
      try {
        entries = await pending;
      } catch (error) {
        if (this.cache.get(node.path) === pending) this.cache.delete(node.path);
        throw error;
      }
      if (generation !== this.generation) return [];
      return entries.map(entry => ({
        ...entry, path: path.join(node.path, entry.name), generation,
        connectionId: node.connectionId, authority: node.authority
      }));
    } catch (error) {
      if (generation !== this.generation) return [];
      return [{ error: error.message || 'Could not load the folder.', path: node?.path || '/', generation }];
    }
  }

  getTreeItem(node) {
    const { api } = this;
    if (node.error) {
      const item = new api.TreeItem('Could not load folder', api.TreeItemCollapsibleState.None);
      item.description = 'Click to retry';
      item.tooltip = node.error;
      item.iconPath = new api.ThemeIcon('warning');
      item.command = { command: 'cpanelOpen.refresh', title: 'Retry Loading Folders' };
      return item;
    }
    const collapsible = node.directory ?
      (node.root ? api.TreeItemCollapsibleState.Expanded : api.TreeItemCollapsibleState.Collapsed) :
      api.TreeItemCollapsibleState.None;
    const item = new api.TreeItem(node.name, collapsible);
    item.id = `${node.connectionId}:${node.path}`;
    item.contextValue = node.directory ? 'cpanelFolder' : 'cpanelFile';
    item.resourceUri = api.Uri.from({ scheme: 'cpanel-open', authority: node.authority, path: node.path });
    item.iconPath = node.directory ? api.ThemeIcon.Folder : api.ThemeIcon.File;
    item.tooltip = `${node.path}${node.directory ? '' : '\nSave uploads changes to the server'}`;
    if (node.root && this.connection) {
      item.tooltip = `${this.connection.profile.username}@${new URL(this.connection.profile.server).host}\n${node.path}\nSave uploads changes to the server`;
    }
    if (!node.directory) {
      item.command = { command: 'cpanelOpen.openRemoteFile', title: 'Open File', arguments: [node] };
    }
    return item;
  }

  dispose() {
    this.generation++;
    this.cache.clear();
    this.connection = null;
    this.restoring = undefined;
    this.emitter.dispose();
  }
}

module.exports = { CpanelTreeProvider };
