# cPanel Open

A small VS Code extension for browsing remote folders and creating and editing text files through the cPanel HTTPS API.

## Install and use

1. In VS Code, open **Extensions**, search for **cPanel Open** (publisher **RockYou**), and click **Install**.
3. Open the Command Palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux).
4. Run **cPanel: Connect / Change Connection…**.
5. Enter the server, cPanel username, API token, and starting folder.
6. The **cPanel** sidebar opens. Expand folders and click a file to open it.
7. Edit the file and press **Cmd+S** on Mac or **Ctrl+S** on Windows/Linux. Saving uploads your changes directly to the server.

Click the folder/code icon in the Activity Bar to return to cPanel, or run **cPanel: Show File Browser**. The sidebar header shows the saved server and username. The starting folder appears at the top of the tree; browsing stays beneath it.

Folders load **one level at a time when expanded**. The extension does not recursively download `public_html`. Expanding a folder only fetches its listing; file contents are fetched when you click a file. Listings are cached in memory until you click **Refresh Folders** in the sidebar header. Refresh reloads visible expanded folders; it does not automatically replace your open editor contents. Click a clean file again to fetch a fresh copy. Clicking a tab with unsaved edits keeps those edits.

The original **cPanel: Open File…** command is still available as a keyboard-friendly folder picker. Type a filename to filter the current folder, select `..` to return to its parent, or press Escape to close the picker.

### Creating a file

Right-click an existing folder in the cPanel sidebar and choose **New File…**. Use the sidebar’s New File button or run **cPanel: New File…** from the Command Palette to create a file in the starting folder. Enter a filename such as `notes.txt`. Confirming the name creates an empty file on the server and opens it for editing. If the name is already in use, creation stops.

### Saving to the server

Each changed save checks the server copy against the revision you opened, makes a private local backup of that server copy, checks again, uploads the new bytes, and reads the file back to verify the result. The editor keeps its unsaved state if saving fails. If a connection fails after the upload, a later Save can recognize that the server already has the exact contents.

VS Code **Auto Save also uploads changes** if you have enabled it. To upload only when you press Save, turn Auto Save off using VS Code's normal settings.

If the server file changed since you opened it, saving stops. Copy your unsaved edits to a temporary local file, revert the remote tab, reopen it from the cPanel sidebar, and merge your edits into the latest server copy. There is no force-overwrite action in this version. cPanel UAPI does not offer an atomic compare-and-swap for this upload, so the pre-upload checks reduce conflicts but cannot eliminate the small race with simultaneous server writes.

Use **cPanel: Show Local Backups** to open the backups folder in your operating system's file manager. Each `.bak` contains the exact previous UTF-8 bytes, with an accompanying `.json` recording the server, path, time, and checksum. Backups are stored in the extension's local data folder, outside the hosted website. To restore one, open it locally, copy its content into a freshly opened remote file, and Save. Backups accumulate until you remove them yourself.

### Updating from 0.1 or 0.2 (same publisher)

Install the new release, then reload your VS Code window. Your existing connection and token are reused. Files now open as editable remote documents. Open the cPanel sidebar or run **cPanel: Show File Browser**. Expected content hashes are retained in workspace state across restarts to help detect conflicts with restored unsaved editors. Reopen a clean file from the sidebar to load and adopt its latest server revision.

Bare hostnames use HTTPS port **2083**. You can also enter a full HTTPS address with your provider's port. Enter only the server address; remove any `/cpsess…` login session or other URL path.

Create a token in **cPanel → Security → Manage API Tokens**. The hosting provider must enable token access and the Fileman API. The default starting folder is `/home/USERNAME/public_html`; change it if your provider uses a different home path.

Use **cPanel: Connect / Change Connection…** to replace the connection or an expired token. Use **cPanel: Forget Connection** to delete the saved connection and token.

## Version 0.4 scope

- One saved connection.
- Sidebar with expandable folders, file icons, connected server, Refresh, and Collapse All.
- Folder listings load on expansion; hidden files are included.
- Keyboard folder picker remains available.
- Existing UTF-8 or ASCII code/text files up to 2 MB.
- Native Save uploads to the server, with local backups, conflict checks, and readback verification.
- Reopening through the sidebar or picker fetches a fresh copy.
- Create empty text files in existing folders. Folder creation, deletion, renaming, terminals, and remote debugging are outside this version’s scope.
- Binary files and image previews are outside this prototype's scope.

The token is stored using VS Code SecretStorage. The extension also stores connection settings and expected file hashes; previous file contents are kept in the local backups described above. Backup directories use mode `0700`, and backup files use `0600`, where supported by the operating system. The extension sends requests directly to your cPanel server, validates HTTPS certificates, and does not follow redirects. Other installed extensions may see open text documents, just as they can with local files. The extension runs locally even when VS Code is connected to a remote workspace.

## Development

Open this source folder in VS Code and press **F5** to launch an Extension Development Host. No build or runtime dependencies are needed.

With Node.js 20+, run the tests with:

```sh
node --test test/*.test.js
```

To package with pnpm:

```sh
pnpm dlx @vscode/vsce package --no-dependencies
```

Publisher: **RockYou**. Source version: **0.4.0**.

**Migrating from development packages:** The Marketplace publisher ID is `rockyou` rather than the development ID `cpanel-open-dev`. VS Code treats these as separate extensions, so configure your connection again after installing the Marketplace edition.

## License

The source code is available under the [MIT License](LICENSE.txt). The cPanel name and logo are third-party marks.

## API references

- [cPanel API tokens](https://docs.cpanel.net/knowledge-base/security/how-to-use-cpanel-api-tokens/)
- [Fileman list_files](https://api.docs.cpanel.net/specifications/cpanel.openapi/manage-files/fileman-list_files)
- [Fileman get_file_content](https://api.docs.cpanel.net/specifications/cpanel.openapi/manage-files/fileman-get_file_content)
- [Fileman upload_files](https://api.docs.cpanel.net/guides/quickstart-development-guide/tutorial-use-uapis-fileman-upload-files-function-in-custom-code)
- [VS Code FileSystemProvider](https://code.visualstudio.com/api/references/vscode-api#FileSystemProvider)
- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view)
