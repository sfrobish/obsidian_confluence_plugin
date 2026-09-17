# Obsidian to Confluence Publish Plugin — Current State Specification

## 1. Purpose

This plugin publishes Markdown notes from an Obsidian vault to Confluence pages. It reads binding metadata from note frontmatter, resolves the correct Confluence target, uploads local attachments, renders supported diagrams, and writes the resulting Storage XHTML back to the target page.

The system is designed to behave like a content publish pipeline rather than a static export. It supports repeated updates, page reconciliation, folder-based hierarchy mapping, and multi-instance Confluence configuration.

## 2. Product Goal

Enable a the architecture team to keep a vault folder of content they want to publish to confluence.  The folder tree and corresponding Confluence page tree aligned without manually copying content from Obsidian into Confluence.

In practical terms, the plugin should:
- scan configured vault folders
- detect notes with Confluence bindings
- create or update matching pages in Confluence
- preserve per-note attachment state across publishes
- render diagrams to attachment files before pushing page content
- keep page IDs and URLs in frontmatter for subsequent updates

## 3. Current Scope

### In scope
- Markdown note publish to Confluence Storage Format XHTML
- Confluence page creation and update
- Frontmatter-driven target binding
- Parent page resolution through explicit URL or inherited `_index.md` hierarchy
- Attachment upload for local embedded files
- Diagram rendering for Mermaid and Draw.io
- Per-note content hash skip logic to avoid redundant updates
- Multi-instance configuration support
- SecretStorage-backed auth for instance credentials

### Out of scope / explicitly not the primary target
- Rich live preview editing in Confluence
- Two-way publish from Confluence back to Obsidian
- Full CMS-style versioning semantics beyond the page update flow
- Generic multi-file document diff UI
- Automated conflict resolution across arbitrary page edits outside the plugin's structure checks

## 4. Primary User Journeys

### 4.1 Initial publish of a folder tree
1. User configures one or more vault folders to scan.
2. User creates or edits a note with Confluence binding frontmatter.
3. Plugin resolves the target page or parent page.
4. Plugin creates a missing Confluence page under the parent.
5. Plugin uploads attachments and rendered diagrams.
6. Plugin writes the final page content.
7. Frontmatter is updated with the Confluence page ID and URL.

### 4.2 Repeated publish after a note change
1. Plugin reads the note content.
2. Plugin computes a content hash.
3. If the hash matches the last published hash for the page, publish is skipped.
4. Otherwise the page is updated.
5. Only changed attachments or diagram files are re-uploaded or replaced as needed.

### 4.3 Hierarchical parent placement
1. Note has `confluence_parent_url` or related target metadata.
2. If not, nearest ancestor `_index.md` file can provide inherited parent context.
3. Plugin resolves the effective parent page and uses it for child page creation.

## 5. Functional Requirements

### 5.1 Frontmatter binding
A note is considered publishable when it contains one or more of the following binding fields:
- `confluence_url`
- `confluence_parent_url`
- `confluence_page_id`

The plugin stores the Confluence target(s) as a list of `PublishTarget` objects with:
- `url`
- `parentUrl`
- `pageId`

The plugin also preserves scalar / CSV / array formatting style when it rewrites frontmatter so the original user style is not unnecessarily changed.

### 5.2 Folder scan behavior
- `scanFolders` determines which vault directories are eligible for publish.
- Empty list means the full vault is considered.
- `ignorePatterns` excludes matching paths from publish.
- Only markdown files under eligible directories are candidates.

### 5.3 Page creation and update
- If a page has no `pageId`, the plugin resolves a parent page and creates a child page.
- If a page exists and the content hash differs, the plugin updates it.
- If the page has materially diverged from the vault hierarchy or expected title, the plugin may rebuild or replace the page according to structure-conflict rules.

### 5.4 Attachment handling
- Local image and media references are discovered from markdown.
- Resolved local files are uploaded to the Confluence page via `uploadAttachments`.
- Uploaded attachments are tracked by filename and SHA-1 hash.
- The page's attachment cache is stored under frontmatter `confluence_attachments` in a per-instance nested record.

### 5.5 Diagram rendering
The pipeline supports these renderers:
- Mermaid
- Draw.io

#### Mermaid
- Mermaid fences are discovered and hashed.
- If rendering is enabled, a Mermaid block is rendered into a generated SVG file attachment via Obsidian's built-in mermaid engine — offline, no external service.
- Final Confluence page output replaces the Mermaid code fence with an `ac:image` attachment.

#### Draw.io
- Draw.io files are converted to SVG or rendered output and uploaded as attachments.
- Embedded `.drawio` files or fence blocks are integrated into the page.

### 5.6 Hash-based skip logic
Each note computes a hash from the preprocessed markdown content. The current implementation includes enough context to detect changes in:
- note body
- attachment-related width settings
- Unicode handling flags

The hash is stored per instance and per page ID so that different Confluence instances do not overwrite each other's publish state.

## 6. Architecture

### 6.1 Plugin root
The main plugin class in [src/main.ts](src/main.ts):
- loads settings
- manages Confluence engine instances
- runs publish commands
- maintains status UI and menu integrations
- handles migration

### 6.2 Settings
The settings model in [src/settings.ts](src/settings.ts) contains:
- folder scan rules
- ignore patterns
- binding field name
- attachment settings
- diagram rendering settings
- instance list and per-instance auth configuration

### 6.3 Confluence API layer
The API layer in [src/confluence/api.ts](src/confluence/api.ts):
- creates authenticated requests to Confluence
- handles page lookup, create, update, delete, and attachment operations
- normalizes and wraps Confluence errors into typed `ConfluenceApiError`
- supports Electron session/cookie flows when required by the desktop app

### 6.4 Markdown conversion
The markdown conversion layer in [src/confluence/convertMarkdown.ts](src/confluence/convertMarkdown.ts):
- strips frontmatter
- preprocesses Obsidian-specific syntax
- masks inline code and fenced code blocks to avoid rewriting example syntax
- extracts local attachment references
- extracts Mermaid / Draw.io diagrams
- builds a final Confluence XHTML representation using MarkdownIt
- replaces code fences with Confluence attachment images when rendering has succeeded
- converts Obsidian-specific link forms to Confluence-friendly structures

### 6.5 Publish engine
The orchestration layer in [src/publish/publishNotes.ts](src/publish/publishNotes.ts):
- resolves the effective target
- computes note content hash
- extracts references
- renders diagrams
- uploads attachments
- creates or updates the page
- writes updated frontmatter
- tracks per-target results and multi-instance routing

### 6.6 Frontmatter and state tracking
The state model in [src/frontmatter/handler.ts](src/frontmatter/handler.ts):
- reads `confluence_url`, `confluence_parent_url`, and `confluence_page_id`
- writes updated target info and hash state back to frontmatter
- preserves CSV / list formatting when rewriting binding fields
- tracks attachment records and last hashes per instance per page

### 6.7 Rendering adapters
Renderer implementations live in:
- [src/confluence/mermaidRenderer.ts](src/confluence/mermaidRenderer.ts)
- [src/confluence/drawiorender.ts](src/confluence/drawiorender.ts)

These follow a consistent pattern:
- extract diagram source
- render it to image bytes
- return a `DiagramBlock` + rendered payload
- upload the resulting file as a Confluence attachment

## 7. Data Model

### 7.1 Frontmatter contracts
The current plugin writes and reads the following key fields:

```yaml
---
confluence_url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123"
confluence_parent_url: "https://example.atlassian.net/wiki/spaces/ENG/pages/456"
confluence_page_id: "123"
confluence_last_hash: {
  instanceId: {
    pageId: "sha256-like-hash"
  }
}
confluence_attachments: {
  instanceId: {
    pageId: {
      filename: { hash: "...", id: "..." }
    }
  }
}
---
```

### 7.2 Rendered diagram object
A diagram block is represented as:
- `hash` — stable content hash
- `source` — diagram source text
- `filename` — generated attachment filename
- `sourcePath` — optional source file path for draw.io references

### 7.3 Attachment record
```ts
interface AttachmentRecord {
  hash: string;
  id: string;
}
```

## 8. Publish Flow (Current Implementation)

1. `PublishEngine.publishFileInternal(...)` reads the note content.
2. It computes the note content hash.
3. It extracts references from the markdown:
   - local attachments
   - Mermaid blocks
   - Draw.io blocks
4. It renders diagram content into image data.
5. It uploads attachment and diagram data to the target page.
6. It converts markdown into Confluence Storage XHTML.
7. It performs page creation/update logic.
8. It sends the final page body to Confluence.
9. It writes updated frontmatter state.

This is a synchronous pipeline with asynchronous network-bound steps at the render/upload layer.

## 9. Multi-instance Behavior

The plugin supports multiple Confluence instances via `PublishConfluenceSettings.instances`.

Key rules:
- each instance has its own base URL, auth config, and page scope
- page IDs are considered local to the instance
- hash tracking and attachment tracking are keyed by instance ID and page ID
- foreign instance targets are preserved without clobbering each other's publish state

This is a major design constraint of the current system and should be preserved in future changes.

## 10. Known Constraints and Practical Notes

### 10.1 Rendering behavior
- Mermaid rendering may require a network-backed renderer or the Obsidian native Mermaid engine.
- Some Confluence versions or renderers may treat SVG differently than PNG.
- Mermaid fence normalization must preserve stable hash equality between extracted blocks and rendered replacements.

### 10.2 Frontmatter safety
- The plugin writes binding state structurally, not by direct text patching.
- It preserves original scalar / array / CSV forms when possible.

### 10.3 Page conflict handling
The plugin includes logic to identify structural conflicts between vault hierarchy and Confluence hierarchy, and may replace or recreate pages when necessary.

### 10.4 Corporate environment assumptions
- Corporate CAs may require `NODE_EXTRA_CA_CERTS` or `CONFLUENCE_CA_FILE` for attachment upload paths.
- This is especially relevant when Confluence uses private certificate chains or proxy interception.

## 11. Current Acceptance Criteria

The current system is considered functional when:
- a note can be published to Confluence with frontmatter binding
- page creation succeeds when no page exists
- page update succeeds when content changes
- local attachments are uploaded and referenced correctly
- Mermaid / Draw.io render outputs are uploaded as attachments and linked in the page body
- repeated publishes avoid redundant updates when content is unchanged
- multiple Confluence instances do not overwrite each other’s state

## 12. Risks and Known Edge Cases
- Mermaid fence matching can fail when line endings or trailing whitespace differ across editors.
- Broken local attachment references can silently fall through unless explicitly validated.
- Rendered diagram output may need fallback behavior when the external service is unavailable.
- Confluence storage XHTML is strict; some malformed HTML or unsupported inline output can break page writes.

## 13. Extension Points for the Next Stage

The next phase should focus on making this pipeline more robust and more explicit. Suggested extension areas:

### 13.1 Better diagram validation and fallback
- validate rendered SVG/PNG output before upload
- distinguish “render failed” vs “render succeeded but page replacement failed”
- support deterministic fallback to raw code blocks when rendering is unavailable

### 13.2 More explicit publish contract layer
- separate extraction, validation, upload, and conversion phases into clearer interfaces
- define richer result objects for failure reasons and per-diagram status

### 13.3 Publish state diagnostics
- add a preview/dry-run output for Confluence XML before upload
- log per-file reasons for skip/update/create flows
- expose a detailed publish report for troubleshooting

### 13.4 Broader content transformation coverage
- handle additional Obsidian-specific markdown syntax more explicitly
- support more advanced Confluence macro conversion patterns
- improve link and media rewriting

### 13.5 Operational safety
- add retry and backoff policies for render and upload failures
- standardize cancellation and partial publish behavior
- make the conflict replacement strategy more configurable

## 14. Summary

This plugin is currently a functioning markdown-to-Confluence publish engine with: note binding, page lifecycle management, masonry-style attachment upload, diagram rendering, hash-based dedupe, and multi-instance support. The current baseline is robust enough to extend, but the next stage should focus on more detailed validation, clearer publish contracts, more explicit failure modes, and easier maintainability as the feature set expands.
