'use strict';

const vscode = require('vscode');
const path = require('node:path').posix;
const { createHash } = require('node:crypto');
const { CpanelClient, MAX_FILE_BYTES, normalizeServer, normalizeDirectory, validUsername, validateToken } = require('./client');
const { CpanelTreeProvider } = require('./tree');
const { CpanelFileSystem } = require('./filesystem');
const { LocalBackups } = require('./backups');

const SCHEME = 'cpanel-open';
const PROFILE_KEY = 'connection';

function tokenKey(profile) {
  const id = createHash('sha256').update(`${profile.server}\n${profile.username}`).digest('hex');
  return `cpanel-open.token.${id}`;
}

function validation(fn) {
  return value => { try { fn(value); return undefined; } catch (error) { return error.message; } };
}

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function activate(context) {
  let busy = false;
  let treeView;
  const tree = new CpanelTreeProvider(vscode, restoreConnection, connection => {
    const profile = connection?.profile;
    treeView.description = profile ? new URL(profile.server).host : 'Not connected';
    treeView.message = profile ? `${new URL(profile.server).host}\n${profile.username} • Save uploads to server` : undefined;
    vscode.commands.executeCommand('setContext', 'cpanelOpen.connected', Boolean(profile));
  });
  treeView = vscode.window.createTreeView('cpanelOpen.files', { treeDataProvider: tree, showCollapseAll: true });
  treeView.description = 'Not connected';
  context.subscriptions.push(tree, treeView);

  const backups = new LocalBackups(require('node:path').join(context.globalStorageUri.fsPath, 'backups'));
  const files = new CpanelFileSystem(vscode, {
    getConnection: () => tree.getConnection(), baselines: context.workspaceState, backups,
    onSaved() {
      tree.refresh();
      vscode.window.setStatusBarMessage('cPanel: saved and verified on server', 8000);
    }
  });
  context.subscriptions.push(files,
    vscode.workspace.registerFileSystemProvider(SCHEME, files, { isCaseSensitive: true, isReadonly: false }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === SCHEME) files.close(document.uri);
    })
  );

  async function connect() {
    const previous = context.globalState.get(PROFILE_KEY);
    const serverInput = await vscode.window.showInputBox({
      title: 'Connect to cPanel (1/4)', prompt: 'cPanel server address',
      placeHolder: 'server.example.com:2083', value: previous?.server || '',
      ignoreFocusOut: true, validateInput: validation(normalizeServer)
    });
    if (serverInput === undefined) return;
    const server = normalizeServer(serverInput);
    const usernameInput = await vscode.window.showInputBox({
      title: 'Connect to cPanel (2/4)', prompt: 'cPanel username',
      value: previous?.username || '', ignoreFocusOut: true,
      validateInput: value => validUsername(value.trim()) ? undefined : 'Enter your cPanel username.'
    });
    if (usernameInput === undefined) return;
    const username = usernameInput.trim();
    const tokenInput = await vscode.window.showInputBox({
      title: 'Connect to cPanel (3/4)', prompt: 'API token from cPanel → Security → Manage API Tokens',
      password: true, ignoreFocusOut: true, validateInput: validation(value => validateToken(value.trim()))
    });
    if (tokenInput === undefined) return;
    const token = tokenInput.trim();
    const rootInput = await vscode.window.showInputBox({
      title: 'Connect to cPanel (4/4)', prompt: 'Starting folder on the server',
      value: previous?.username === username ? previous.root : `/home/${username}/public_html`,
      ignoreFocusOut: true, validateInput: validation(normalizeDirectory)
    });
    if (rootInput === undefined) return;
    const profile = { server, username, root: normalizeDirectory(rootInput) };
    const client = new CpanelClient(profile, token);
    const entries = await loading('Connecting to cPanel…', () => client.listFiles(profile.root));
    await context.secrets.store(tokenKey(profile), token);
    await context.globalState.update(PROFILE_KEY, profile);
    if (previous && tokenKey(previous) !== tokenKey(profile)) await context.secrets.delete(tokenKey(previous));
    tree.setConnection({ profile, client }, entries);
    return { profile, client, entries };
  }

  async function restoreConnection() {
    const profile = context.globalState.get(PROFILE_KEY);
    const token = profile && await context.secrets.get(tokenKey(profile));
    if (!profile || !token) return undefined;
    return { profile, client: new CpanelClient(profile, token) };
  }

  async function getConnection() {
    return await tree.getConnection() || connect();
  }

  async function showRemoteFile(active, filename, size) {
    if (size > MAX_FILE_BYTES) {
      await vscode.window.showWarningMessage('Choose a text file smaller than 2 MB.');
      return false;
    }
    const relative = path.relative(active.profile.root, filename);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('Choose a file within the connected starting folder.');
    }
    const uri = vscode.Uri.from({ scheme: SCHEME, authority: tokenKey(active.profile).slice(-16), path: filename });
    const isDirty = () => vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty);
    if (!isDirty()) await loading('Opening cPanel file…', () => files.prepareFile(uri, () => !isDirty()));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.setStatusBarMessage('cPanel: editable remote file — Save uploads to server', 5000);
    return true;
  }

  async function openFile(connection) {
    const active = connection || await getConnection();
    if (!active) return;
    const { profile, client } = active;
    let current = profile.root;
    let entries = active.entries;
    while (true) {
      if (!entries) entries = await loading('Loading cPanel folder…', () => client.listFiles(current));
      const items = entries.map(entry => ({
        label: `${entry.directory ? '$(folder)' : '$(file)'} ${entry.name.replace(/\$\(/g, '＄(')}`,
        description: entry.directory ? 'Folder' : formatSize(entry.size),
        entry
      }));
      if (current !== profile.root) items.unshift({ label: '$(arrow-up) ..', description: 'Parent folder', parent: true });
      const selected = await vscode.window.showQuickPick(items, {
        title: 'cPanel: Open File', placeHolder: `${current} — choose a folder or text file`,
        matchOnDescription: false, ignoreFocusOut: true
      });
      if (!selected) return;
      if (selected.parent) {
        current = path.dirname(current);
        entries = undefined;
        continue;
      }
      const filename = path.join(current, selected.entry.name);
      if (selected.entry.directory) {
        current = filename;
        entries = undefined;
        continue;
      }
      try {
        if (await showRemoteFile(active, filename, selected.entry.size)) return;
      } catch (error) {
        await vscode.window.showErrorMessage(error.message);
      }
    }
  }

  async function guarded(action) {
    if (busy) return;
    busy = true;
    try { await action(); }
    catch (error) { await vscode.window.showErrorMessage(error.message || 'Could not open the cPanel file.'); }
    finally { busy = false; }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('cpanelOpen.openFile', () => guarded(() => openFile())),
    vscode.commands.registerCommand('cpanelOpen.connect', () => guarded(async () => {
      const connection = await connect();
      if (connection) await vscode.commands.executeCommand('workbench.view.extension.cpanelOpen');
    })),
    vscode.commands.registerCommand('cpanelOpen.showBrowser', () => vscode.commands.executeCommand('workbench.view.extension.cpanelOpen')),
    vscode.commands.registerCommand('cpanelOpen.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('cpanelOpen.openBackups', () => guarded(async () => {
      await backups.ensureDirectory();
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(backups.directory));
    })),
    vscode.commands.registerCommand('cpanelOpen.openRemoteFile', node => guarded(async () => {
      if (!tree.isCurrent(node) || node.directory || node.error) return;
      const active = await tree.getConnection();
      if (active && tree.isCurrent(node)) await showRemoteFile(active, node.path, node.size);
    })),
    vscode.commands.registerCommand('cpanelOpen.disconnect', () => guarded(async () => {
      const profile = context.globalState.get(PROFILE_KEY);
      if (profile) await context.secrets.delete(tokenKey(profile));
      await context.globalState.update(PROFILE_KEY, undefined);
      tree.setConnection(null);
      vscode.window.showInformationMessage('cPanel connection forgotten.');
    }))
  );
}

function loading(title, task) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

module.exports = { activate };
