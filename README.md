# obsidian_confluence_plugin

## Folder hierarchy and _index.md parent mapping

The plugin supports folder-based Confluence hierarchy. A note inherits its parent from the nearest ancestor folder that contains an `_index.md` file with Confluence metadata.

Rules:

- The nearest ancestor `_index.md` wins.
- A folder index can set either `confluence_page_id`, `confluence_url`, or `confluence_parent_url`.
- A note-level `confluence_parent_url` still takes precedence over the folder hierarchy.
- If neither a note parent nor a folder parent is found, page creation fails with a clear error.

Example:

```text
Vault/
  Projects/
    _index.md        # contains confluence_page_id: "12345"
    Alpha/
      _index.md      # contains confluence_page_id: "67890"
      note-1.md
      note-2.md
```

Then `note-1.md` and `note-2.md` will be created under the `Alpha` parent page (`67890`), not the `Projects` parent (`12345`).

This is intended as a temporary convention while the hierarchy behavior is being refined.

## Confluence corporate CA / proxy certificate setup

If your Confluence instance is behind a corporate proxy or uses an internal certificate authority, the Obsidian desktop app must trust the CA chain for the Node HTTPS upload path used by attachment uploads.

Set one of these environment variables before starting Obsidian:

- `NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem`
- `CONFLUENCE_CA_FILE=/path/to/corp-root-ca.pem`

This is required for generated attachments such as rendered SVG/PNG diagrams because the multipart upload uses the Electron-backed Node HTTPS client to avoid Confluence XSRF false positives.

If you are not using a corporate CA, you can usually omit this configuration.
