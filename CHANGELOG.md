# Changelog

## 0.3.2

- Released the source under the MIT License.

## 0.3.1

- Added extension icon. No functional changes.

## 0.3.0

- Files are editable remote documents; Save uploads changes through cPanel UAPI.
- Added local backups, remote revision checks before upload, and exact readback verification.
- Failed or unverified saves remain unsaved in the editor. Concurrent saves are serialized per file.
- Expected file hashes persist across restarts; reopening a dirty tab preserves its edits.
- Added Show Local Backups. Existing UTF-8/ASCII files up to 2 MB are supported.
- VS Code Auto Save follows the same upload path when enabled.

## 0.2.0

- Added a dedicated cPanel sidebar with expandable folders and click-to-open text files.
- Folder listings load on demand and are cached in memory until Refresh.
- Added server and username display, Refresh Folders, Collapse All, and connection actions.
- Existing 0.1 connection settings, SecretStorage token, and keyboard picker are retained.
- Failed folder requests show a retry row. Old requests are ignored after connection changes.

## 0.1.0

- Initial read-only file picker using the cPanel HTTPS API.
