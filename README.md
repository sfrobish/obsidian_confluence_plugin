# obsidian_confluence_plugin

## Getting started with Confluence publish

This plugin publishes Obsidian notes to Confluence by reading a small amount of frontmatter on the note and then creating or updating the matching page in Confluence.

The key idea is:

1. configure which Obsidian folders are scanned
2. make sure each note you want published is in those scanned folders
3. give the note a Confluence target or parent mapping
4. run the publish

---

## 1) Configure which folders are scanned

In the plugin settings, set the scanned folders list to one or more vault folders that should participate in publish.

Examples:

- `Notes`
- `Knowledge/Base`
- `Projects/Team`

If you leave the scan list empty or restrict it too narrowly, notes outside those folders will not be considered for publish.

Any markdown file in a scanned folder can participate, as long as it has the required Confluence binding metadata.

---

## 2) Make sure a note is in scope

A note only gets processed if it is inside one of the configured scanned folders.

For example, if your scan list contains:

```text
Projects/
```

then these notes are in scope:

```text
Projects/Alpha/meeting-notes.md
Projects/Alpha/2025/weekly-update.md
```

but this is not in scope:

```text
Archive/old-notes.md
```

If a note is outside the scanned folders, it will be ignored even if it has Confluence frontmatter.

---

## 3) Bind a note to Confluence

Each note you want published should include frontmatter such as:

```yaml
---
confluence_url: "https://your-company.atlassian.net/wiki/spaces/ENG/pages/123456789"
confluence_parent_url: "https://your-company.atlassian.net/wiki/spaces/ENG/pages/987654321"
---
```

Or, if the note has not been created in Confluence yet, you can rely on a parent mapping and let the plugin create the page for you.

The plugin will treat the note as a publish target when it sees at least one binding field in frontmatter.

---

## 4) Use folder hierarchy for parent placement

The plugin also supports a folder-based hierarchy using `_index.md` files.

Example layout:

```text
Vault/
  Projects/
    _index.md
    Alpha/
      _index.md
      note-1.md
      note-2.md
```

If `Alpha/_index.md` has a Confluence page ID or URL, then notes beneath that folder will inherit that parent page automatically.

The nearest ancestor `_index.md` wins. A note-level `confluence_parent_url` still overrides the folder hierarchy.

Example:

```yaml
---
confluence_page_id: "67890"
---
```

Then `note-1.md` and `note-2.md` will be created under the page with ID `67890`.

This is the easiest way to replicate a folder structure into Confluence without manually setting a parent URL on every note.

---

## 5) How replication actually happens

Once the note is inside a scanned folder and has valid Confluence metadata:

- the plugin reads the note
- computes the content hash
- uploads attachments or rendered diagrams if needed
- creates a child page under the resolved parent if no page exists yet
- updates the page content if it already exists
- writes the resulting Confluence page ID and URL back into frontmatter

After a successful publish, the note becomes bound to its Confluence page and future publishes will update the same page instead of creating duplicates.

---

## 6) Typical workflow

A practical setup is:

1. add a folder like `Projects/Alpha` to the scan list
2. create `Projects/Alpha/_index.md` and set its Confluence page ID or URL
3. add or move notes into that folder
4. run publish
5. confirm each note gets created under the corresponding Confluence parent page

This gives you a simple “vault folder → Confluence hierarchy” mapping.

---

## Confluence corporate CA / proxy certificate setup

If your Confluence instance is behind a corporate proxy or uses an internal certificate authority, the Obsidian desktop app must trust the CA chain for the Node HTTPS upload path used by attachment uploads.

Set one of these environment variables before starting Obsidian:

- `NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem`
- `CONFLUENCE_CA_FILE=/path/to/corp-root-ca.pem`

This is required for generated attachments such as rendered SVG/PNG diagrams because the multipart upload uses the Electron-backed Node HTTPS client to avoid Confluence XSRF false positives.

If you are not using a corporate CA, you can usually omit this configuration.
