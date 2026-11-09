# cPanel Open

[![VS Code Marketplace installs](https://img.shields.io/endpoint?url=https%3A%2F%2Fshieldcn.dev%2Fvscode%2Finstalls%2FRockYou%2Fcpanel-open%2Fshields.json&style=for-the-badge&label=VS%20Code%20Marketplace%20installs&labelColor=163652&color=0069B3)](https://marketplace.visualstudio.com/items?itemName=RockYou.cpanel-open)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/rockyou/cpanel-open?style=for-the-badge&label=Open%20VSX%20downloads&labelColor=33204F&color=6D28D9)](https://open-vsx.org/extension/rockyou/cpanel-open)

Browse, create, and edit cPanel files directly in your editor over HTTPS.

## Get started

1. Install **cPanel Open** from either marketplace above.
2. Run **cPanel: Connect / Change Connection…** from the Command Palette. Enter your server address, cPanel username, [API token](https://docs.cpanel.net/knowledge-base/security/how-to-use-cpanel-api-tokens/), and starting folder.
3. Open a file from the **cPanel** sidebar. To create one, right-click a folder and choose **New File…**.

**Save uploads your changes**, including when Auto Save is enabled. The extension checks for conflicts, makes a local backup before replacing server content, and verifies the upload. Find backups with **cPanel: Show Local Backups**.

Supports UTF-8 and ASCII text files up to 2 MB. Your token is stored in VS Code SecretStorage.

## Development

Press **F5** in VS Code to launch the extension host. Run `node --test test/*.test.js` with Node.js 20+.

[MIT License](LICENSE.txt) · The cPanel name and logo are third-party marks.
