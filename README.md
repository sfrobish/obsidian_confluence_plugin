# obsidian_confluence_plugin

## Confluence corporate CA / proxy certificate setup

If your Confluence instance is behind a corporate proxy or uses an internal certificate authority, the Obsidian desktop app must trust the CA chain for the Node HTTPS upload path used by attachment uploads.

Set one of these environment variables before starting Obsidian:

- `NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem`
- `CONFLUENCE_CA_FILE=/path/to/corp-root-ca.pem`

This is required for generated attachments such as rendered SVG/PNG diagrams because the multipart upload uses the Electron-backed Node HTTPS client to avoid Confluence XSRF false positives.

If you are not using a corporate CA, you can usually omit this configuration.
