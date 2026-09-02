import type { App } from 'obsidian';
import MarkdownIt from 'markdown-it';
import { AttachmentRef } from '../types';
import { sha1Hex } from '../utils/hash';
import { resolveAttachmentFile } from './attachmentUploader';
import { replaceMarkdownTocCallouts, replaceTocMarkersWithMacros } from './tocConverter';

export interface DiagramBlock {
	/** Source sha1 hex, used as the cache key and filename prefix */
	hash: string;
	source: string;
	filename: string;
	sourcePath?: string;
}

export interface ExtractedReferences {
	attachments: AttachmentRef[];
	mermaid: DiagramBlock[];
	drawio: DiagramBlock[];
}

/** markdown-it env is typed as `any`; we only add a callout state flag */
interface CalloutEnv { __calloutOpen?: boolean }

export interface ResolvedWikilink {
	url: string;
	/** Confluence page title; needed to generate ri:page for cross-page anchors */
	title?: string;
}

export type WikilinkResolution = string | ResolvedWikilink;

export interface ConvertContext {
	/** filename -> uploaded attachment record (used in convert phase to decide whether img should be replaced with ac:image) */
	attachedFilenames: Set<string>;
	/** hash -> successfully uploaded mermaid SVG filename */
	mermaidFilenameByHash: Map<string, string>;
	/** hash -> successfully uploaded draw.io SVG filename */
	drawioFilenameByHash: Map<string, string>;
	/** source path -> successfully uploaded draw.io SVG filename (embedded local .drawio files) */
	drawioFilenameByPath: Map<string, string>;
	/** Configuration flags */
	renderMermaidToSvg: boolean;
	renderDrawioToSvg: boolean;
	/** Default display width for ordinary attachment images on Confluence (px); 0 = original size */
	defaultImageWidthPx: number;
	/**
	 * Compatibility with older Confluence Server (MySQL utf8 3-byte): replace characters with codePoint > 0xFFFF
	 * (emoji, etc.) with [U+XXXX] placeholders. Off by default; emoji remain untouched by default (issue #5).
	 */
	stripSupplementaryChars: boolean;
	/**
	 * Resolve Obsidian [[wikilink]] into the target Confluence page URL / title.
	 * Return null/undefined → keep the original behavior (fall back to plain text).
	 */
	resolveWikilink?: (linkpath: string, sourcePath: string) => WikilinkResolution | null;
	/**
	 * Resolve @[[Name]] mention into a Confluence username (issue #3, ri:username for Server/DC).
	 * Return null/undefined → fall back to plain text `@Name`.
	 */
	resolveMention?: (linkpath: string, sourcePath: string) => string | null;
}

interface PreprocessOptions {
	resolveWikilink?: (linkpath: string, sourcePath: string) => WikilinkResolution | null;
	resolveMention?: (linkpath: string, sourcePath: string) => string | null;
	sourcePath?: string;
}

/**
 * markdown → Confluence storage XHTML converter.
 *
 * Usage:
 *   1. await extractReferences(app, markdown, sourcePath) — gather attachment + mermaid lists
 *   2. Call AttachmentUploader / MermaidRenderer to upload/render
 *   3. await convert(app, markdown, sourcePath, ctx) — render the final storage xhtml
 *
 * The work is split into two steps because rendering diagrams / uploading attachments is async + network-bound,
 * while markdown-it itself is synchronous; the caller should finish the network-heavy work first, and the convert
 * phase only looks up the precomputed tables.
 */
export async function extractReferences(
	app: App,
	markdown: string,
	sourcePath: string,
): Promise<ExtractedReferences> {
	const body = stripFrontmatter(markdown);
	const preprocessed = preprocessObsidianSyntax(body);

	const attachments = collectAttachments(app, preprocessed, sourcePath);
	const mermaid = await collectDiagrams(preprocessed, 'mermaid');
	const drawio = await collectDrawio(app, preprocessed, sourcePath);

	return { attachments, mermaid, drawio };
}

export async function convert(app: App, markdown: string, sourcePath: string, ctx: ConvertContext): Promise<string> {
	const body = stripFrontmatter(markdown);
	const preprocessed = preprocessObsidianSyntax(body, {
		resolveWikilink: ctx.resolveWikilink,
		resolveMention: ctx.resolveMention,
		sourcePath,
	});

	// Precompute a hash for each fence block so the renderer can look it up synchronously
	const fenceHashMap = await buildFenceHashMap(preprocessed);

	const md = buildRenderer(ctx, fenceHashMap);
	const html = md.render(preprocessed);

	return postProcessHtml(html, ctx);
}

/**
 * Compute a stable hash of the markdown content for last_hash deduplication.
 * Include the resolver in the hash as well: when a peer page URL changes, it triggers a re-upload.
 */
export async function computeContentHash(
	app: App,
	markdown: string,
	sourcePath: string,
	opts?: {
		resolveWikilink?: (linkpath: string, sourcePath: string) => WikilinkResolution | null;
		resolveMention?: (linkpath: string, sourcePath: string) => string | null;
		stripSupplementaryChars?: boolean;
		defaultImageWidthPx?: number;
	},
): Promise<string> {
	const body = stripFrontmatter(markdown);
	const preprocessed = preprocessObsidianSyntax(body, {
		resolveWikilink: opts?.resolveWikilink,
		resolveMention: opts?.resolveMention,
		sourcePath,
	});
	// Notes containing supplementary characters (emoji, etc.) are affected by the strip flag in the final output,
	// but the hash is computed from markdown rather than output. Without a salt, pages previously published in placeholder
	// form would be permanently skipped because of the hash match, making the flag effectively useless. Only salt the
	// affected notes: when the flag changes, only notes containing emoji are re-pushed; others still skip normally.
	// When strip=true, do not salt so the old stored hashes from previous versions (which always stripped) remain compatible.
	const hasSupplementary = /[\u{10000}-\u{10FFFF}]/u.test(preprocessed);
	const supplementarySalt = !opts?.stripSupplementaryChars && hasSupplementary ? '\0keep-supplementary' : '';
	// Display width changes the final storage XHTML and must be included in the hash; otherwise, changing only the setting would hit
	// last_hash and skip the publish. Only salt notes that contain local images to avoid needless re-pushes for image-free pages.
	const hasLocalImages = collectAttachments(app, preprocessed, sourcePath).length > 0;
	const width = normalizeImageWidth(opts?.defaultImageWidthPx);
	const imageWidthSalt = hasLocalImages ? `\0image-width:${width}` : '';
	return sha1Hex(preprocessed + supplementarySalt + imageWidthSalt);
}

function collectAttachments(app: App, markdown: string, sourcePath: string): AttachmentRef[] {
	// Mask fenced / inline code regions to avoid mistaking ![[...]] / ![](...) in code examples for real attachment references
	const { masked } = maskCodeRegions(markdown);
	const refs: AttachmentRef[] = [];
	const seen = new Set<string>();
	if (masked.match(/\.drawio(?:\.|$)/i)) {
		// Draw.io files are rendered via the dedicated diagram pipeline; do not upload them as ordinary attachments.
	}

	// Obsidian embed:![[file.png|alt]] / ![[folder/file.png]]
	// `\\?\|` handles escaped pipes inside markdown tables (`\|`); otherwise the backslash gets swallowed into the linkpath
	const embedRe = /!\[\[([^\]\n|\\]+)(?:\\?\|([^\]\n]*))?\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = embedRe.exec(masked)) !== null) {
		const linkpath = m[1]!.trim();
		// Note/heading/block embeds (![[note#section]] / ![[note#^id]]) are not attachments; skip them
		if (linkpath.includes('#')) continue;
		const alt = (m[2] ?? '').trim();
		const tfile = resolveAttachmentFile(app, linkpath, sourcePath);
		const filename = tfile?.name ?? linkpath.split('/').pop() ?? linkpath;
		if (/\.drawio(?:\.|$)/i.test(filename)) continue;
		const key = `embed:${filename}`;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push({ rawMatch: m[0], linkpath, alt, tfile, filename });
	}

	// Standard markdown image: ![alt](path "title")
	// Only relative paths or URLs without a scheme are treated as local attachments
	const imgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	while ((m = imgRe.exec(masked)) !== null) {
		const alt = m[1] ?? '';
		const path = m[2]!;
		if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(path) || path.startsWith('data:')) continue;
		if (path.includes('#')) continue;
		const decoded = tryDecode(path);
		const tfile = resolveAttachmentFile(app, decoded, sourcePath);
		const filename = tfile?.name ?? decoded.split('/').pop() ?? decoded;
		if (/\.drawio(?:\.|$)/i.test(filename)) continue;
		const key = `img:${filename}`;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push({ rawMatch: m[0], linkpath: decoded, alt, tfile, filename });
	}

return refs;
}

async function collectDrawio(app: App, markdown: string, sourcePath: string): Promise<DiagramBlock[]> {
	const blocks = extractFenceBlocks(markdown).filter((b) => b.lang === 'drawio' || b.lang === 'draw.io');
	const seen = new Set<string>();
	const out: DiagramBlock[] = [];
	for (const b of blocks) {
		const hash = await sha1Hex(b.content);
		if (seen.has(hash)) continue;
		seen.add(hash);
		out.push({ hash, source: b.content, filename: `drawio-${hash}.svg` });
	}

	const { masked } = maskCodeRegions(markdown);
	const refs = new Set<string>();
	const embedRe = /!\[\[([^\]\n|\\]+)(?:\\?\|([^\]\n]*))?\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = embedRe.exec(masked)) !== null) {
		const raw = m[1]!;
		const decoded = tryDecode(raw);
		if (!/\.drawio(?:\.|$)/i.test(decoded)) continue;
		const tfile = resolveAttachmentFile(app, decoded, sourcePath);
		if (!tfile) continue;
		const content = await app.vault.read(tfile);
		const hash = await sha1Hex(content);
		if (refs.has(hash)) continue;
		refs.add(hash);
		out.push({ hash, source: content, filename: `drawio-${hash}.svg`, sourcePath: tfile.path });
	}
	const markdownImageRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	while ((m = markdownImageRe.exec(masked)) !== null) {
		const raw = m[2]!;
		const decoded = tryDecode(raw);
		if (!/\.drawio(?:\.|$)/i.test(decoded)) continue;
		const tfile = resolveAttachmentFile(app, decoded, sourcePath);
		if (!tfile) continue;
		const content = await app.vault.read(tfile);
		const hash = await sha1Hex(content);
		if (refs.has(hash)) continue;
		refs.add(hash);
		out.push({ hash, source: content, filename: `drawio-${hash}.svg`, sourcePath: tfile.path });
	}

	return out;
}

async function collectDiagrams(
	markdown: string,
	lang: 'mermaid',
): Promise<DiagramBlock[]> {
	const blocks = extractFenceBlocks(markdown).filter((b) => b.lang === lang);
	const seen = new Set<string>();
	const out: DiagramBlock[] = [];
	for (const b of blocks) {
		const norm = b.content.replace(/\r/g, '').replace(/\n+$/, '');
		const hash = await sha1Hex(norm);
		if (seen.has(hash)) continue;
		seen.add(hash);
		out.push({ hash, source: norm, filename: `${lang}-${hash}.svg` });
	}
	return out;
}

async function buildFenceHashMap(markdown: string): Promise<Map<string, string>> {
	// key: "lang|content" → hash
	const map = new Map<string, string>();
	const blocks = extractFenceBlocks(markdown);
	for (const b of blocks) {
		if (b.lang !== 'mermaid' && b.lang !== 'drawio' && b.lang !== 'draw.io') continue;
		const norm = b.content.replace(/\r/g, '').replace(/\n+$/, '');
		const key = `${b.lang}|${norm}`;
		if (map.has(key)) continue;
		map.set(key, await sha1Hex(norm));
	}
	return map;
}

function buildRenderer(ctx: ConvertContext, fenceHashes: Map<string, string>): MarkdownIt {
	// xhtmlOut: true — Confluence storage uses strict XHTML, so void elements must be self-closed (<hr /> rather than <hr>)
	const md = new MarkdownIt({ html: false, xhtmlOut: true, breaks: false, linkify: true });

	// fence: code blocks + diagrams
	md.renderer.rules.fence = (tokens, idx) => {
		const token = tokens[idx]!;
		// `token.info` may be a whole string like `mermaid id=foo` with attributes,
		// so to match extractFenceBlocks / markdown-it conventions, only the first token is used as the lang.
		const lang = (token.info || '').trim().split(/\s+/)[0]!.toLowerCase();
		// markdown-it fence token content may end with a trailing newline; extractFenceBlocks strips it,
		// but some editors preserve a final blank line before the closing fence. Normalize both forms so
		// the hash lookup remains stable and the rendered attachment matches the uploaded file.
		const content = token.content.replace(/\n+$/, '').replace(/\r/g, '');

		if (lang === 'mermaid' && ctx.renderMermaidToSvg) {
			const hash = fenceHashes.get(`mermaid|${content}`);
			const filename = hash ? ctx.mermaidFilenameByHash.get(hash) : undefined;
			if (filename) return renderAcImage(filename, '');
		}
		if ((lang === 'drawio' || lang === 'draw.io') && ctx.renderDrawioToSvg) {
			const lookupLang = lang === 'draw.io' ? 'draw.io' : 'drawio';
			const hash = fenceHashes.get(`${lookupLang}|${content}`);
			const filename = hash ? ctx.drawioFilenameByHash.get(hash) : undefined;
			if (filename) return renderAcImage(filename, '');
		}
		return renderAcCode(lang, content);
	};

	md.renderer.rules.code_block = (tokens, idx) => {
		return renderAcCode('', tokens[idx]!.content);
	};

	// image: replace with ac:image (for existing attachments) or keep the original external src
	md.renderer.rules.image = (tokens, idx) => {
		const token = tokens[idx]!;
		const src = token.attrGet('src') ?? '';
		const alt = token.content || '';
		if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(src) || src.startsWith('data:')) {
			return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`;
		}
		const decoded = tryDecode(src);
		const filename = decoded.split('/').pop() ?? decoded;
		if (/\.drawio(?:\.|$)/i.test(filename) && ctx.renderDrawioToSvg) {
			const maybe = ctx.drawioFilenameByPath.get(decoded) ?? ctx.drawioFilenameByPath.get(filename) ?? undefined;
			if (maybe) return renderAcImage(maybe, alt);
		}
		if (ctx.attachedFilenames.has(filename)) {
			return renderAcImage(filename, alt, ctx.defaultImageWidthPx);
		}
		return `<!-- Attachment not uploaded: ${escapeAttr(filename)} -->`;
	};

	// callout: implemented by wrapping blockquotes with a custom renderer
	const originalBlockquoteOpen = md.renderer.rules.blockquote_open;
	const originalBlockquoteClose = md.renderer.rules.blockquote_close;
	md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
		const calloutType = detectCalloutType(tokens, idx);
		if (calloutType) {
			(env as CalloutEnv).__calloutOpen = true;
			return `<ac:structured-macro ac:name="${calloutType.macro}"><ac:rich-text-body>`;
		}
		return originalBlockquoteOpen
			? originalBlockquoteOpen(tokens, idx, options, env, self)
			: self.renderToken(tokens, idx, options);
	};
	md.renderer.rules.blockquote_close = (tokens, idx, options, env, self) => {
		const e = env as CalloutEnv;
		if (e.__calloutOpen) {
			e.__calloutOpen = false;
			return `</ac:rich-text-body></ac:structured-macro>`;
		}
		return originalBlockquoteClose
			? originalBlockquoteClose(tokens, idx, options, env, self)
			: self.renderToken(tokens, idx, options);
	};

	// inline html (html:false is disabled by default; this is a safety fallback)
	md.renderer.rules.html_block = () => '';
	md.renderer.rules.html_inline = () => '';

	return md;
}

// ============ Helper: text processing ============

function stripFrontmatter(md: string): string {
	if (!md.startsWith('---')) return md;
	const m = md.match(/^---\n[\s\S]*?\n---\n?/);
	if (!m) return md;
	return md.slice(m[0].length);
}

/**
 * Apply minimal preprocessing to Obsidian-specific syntax so markdown-it can parse it correctly.
 * - ![[file]] is converted to a standard image ![alt](file) (the ac:image replacement itself is handled by the image renderer)
 * - [[link|alias]] is reduced to plain text alias (or link)
 * - callout `> [!type] Title\n> body` is rewritten on the first line to `> **TYPE: Title**\n> body`,
 *   and the blockquote_open renderer then turns it into an ac:structured-macro based on this marker
 */
function preprocessObsidianSyntax(md: string, opts?: PreprocessOptions): string {
	// First replace code regions (fenced + inline) with placeholders so ![[...]] / [[...]] in examples are not rewritten
	const { masked, restore } = maskCodeRegions(md);
	// `[!summary]+ Table of Contents` still appears as a handwritten table of contents in Obsidian; during publish it is converted to the official Confluence
	// TOC macro. This must happen after code regions are masked to avoid rewriting syntax examples in documents.
	let s = replaceMarkdownTocCallouts(masked);

	// 0. @[[Name]] / @[[Name|alias]] mention → PUA sentinel (replaced later in postProcessHtml with <ac:link><ri:user>)
	//    This must run before rules 1/2, otherwise the inner [[Name]] is swallowed by the generic wikilink handling.
	//    If confluence_username cannot be resolved, fall back to plain text `@Name`, consistent with issue #3's graceful degradation.
	{
		const resolveMention = opts?.resolveMention;
		const sourcePath = opts?.sourcePath;
		s = s.replace(/@\[\[([^\]\n|\\]+)(?:\\?\|([^\]\n]*))?\]\]/g, (_full, link: string, alias: string) => {
			const linkpath = link.trim().split('#')[0]!.trim();
			const text = (alias ?? '').trim() || link.trim().split('/').pop() || link.trim();
			if (resolveMention && sourcePath && linkpath) {
				const username = resolveMention(linkpath, sourcePath);
				if (username) return `MENTION:${username}`;
			}
			return `@${text}`;
		});
	}

	// 1. ![[...]] embed → ![alt](path)
	//    - `[^|\\]+` + `\\?\|` supports escaped pipes inside markdown tables (`\|`)
	//    - A link containing `#section` / `#^block` is a note fragment embed, not an image attachment, so it falls back to plain text
	//    - Use encodeURI for paths like Obsidian's "Pasted image YYYYMMDDHHMMSS.png", which may contain spaces;
	//      without encoding, markdown-it fails to parse `![alt](path with space)` and re-emits the original text.
	s = s.replace(/!\[\[([^\]\n|\\]+)(?:\\?\|([^\]\n]*))?\]\]/g, (_full, link: string, alias: string) => {
		const text = (alias ?? '').trim();
		const linkpath = link.trim();
		if (linkpath.includes('#')) {
			return text || linkpath.split('/').pop() || linkpath;
		}
		return `![${text}](${encodeURI(linkpath)})`;
	});

	// 2. Same-page anchor [[#Heading|alias]] → PUA sentinel; postProcessHtml converts it to
	//    Confluence's native <ac:link ac:anchor="...">. This must happen before the generic wikilink processing.
	s = s.replace(/\[\[#([^\]\n|\\]+)(?:\\?\|([^\]\n]*))?\]\]/g, (_full, anchor: string, alias: string) => {
		const cleanAnchor = anchor.trim();
		const text = (alias ?? '').trim() || cleanAnchor;
		// #^block-id is an Obsidian block reference; Confluence heading anchors cannot carry it, so keep the old plain-text fallback.
		if (cleanAnchor.startsWith('^')) return (alias ?? '').trim() || `#${cleanAnchor}`;
		return makeAnchorLinkMarker(cleanAnchor, text);
	});

	// Standard Markdown same-page anchors [text](#heading) are also converted to Confluence native anchor links.
	// This also supports angle destinations with spaces (`<#heading name>`) and optional titles.
	s = s.replace(
		/(?<!!)\[([^\]\n]+)\]\((?:<#([^>\n]+)>|#([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g,
		(full, text: string, angleAnchor: string, bareAnchor: string) => {
			const anchor = tryDecode((angleAnchor || bareAnchor).trim());
			return anchor.startsWith('^') ? full : makeAnchorLinkMarker(anchor, text);
		},
	);

	// 2b. [[link|alias]] / [[link]] → resolve to a CF link; when it includes #heading, keep it as a cross-page anchor.
	s = s.replace(/\[\[([^\]\n|\\]+)(?:\\?\|([^\]\n]*))?\]\]/g, (_full, link: string, alias: string) => {
		const cleanLink = link.trim();
		const text = (alias ?? '').trim() || cleanLink.split('/').pop() || cleanLink;
		const resolver = opts?.resolveWikilink;
		const sourcePath = opts?.sourcePath;
		if (resolver && sourcePath) {
			const hashIndex = cleanLink.indexOf('#');
			const linkpath = (hashIndex >= 0 ? cleanLink.slice(0, hashIndex) : cleanLink).trim();
			const anchor = hashIndex >= 0 ? cleanLink.slice(hashIndex + 1).trim() : '';
			if (linkpath) {
				const resolved = normalizeWikilinkResolution(resolver(linkpath, sourcePath));
				if (resolved) {
					if (anchor && !anchor.startsWith('^')) {
						const title = resolved.title ?? inferPageTitle(linkpath);
						return makeAnchorLinkMarker(anchor, text, title);
					}
					return `[${escapeMarkdownLinkText(text)}](${resolved.url})`;
				}
			}
		}
		return text;
	});

	// 2c. Standard markdown links [text](relative.md[#anchor]) → resolve to a CF link; if resolution fails, fall back to plain text.
	//     `(?<!!)` excludes ![image](...); it also excludes absolute/special forms such as http(s)/mailto/tel/anchors.
	const resolver = opts?.resolveWikilink;
	const sourcePath = opts?.sourcePath;
	if (resolver && sourcePath) {
		s = s.replace(
			/(?<!!)\[([^\]\n]+)\]\((?!https?:|mailto:|tel:|#)([^)\s]+\.md(?:#[^)\s]*)?)\)/g,
			(_full, text: string, href: string) => {
				const hashIndex = href.indexOf('#');
				const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
				const anchor = hashIndex >= 0 ? tryDecode(href.slice(hashIndex + 1)) : '';
				let linkpath: string;
				try {
					linkpath = decodeURIComponent(pathPart);
				} catch {
					linkpath = pathPart;
				}
				if (!linkpath) return text;
				const resolved = normalizeWikilinkResolution(resolver(linkpath, sourcePath));
				if (resolved) {
					if (anchor && !anchor.startsWith('^')) {
						const title = resolved.title ?? inferPageTitle(linkpath);
						return makeAnchorLinkMarker(anchor, text, title);
					}
					return `[${escapeMarkdownLinkText(text)}](${resolved.url})`;
				}
				// Resolution failed: fall back to plain text to avoid Confluence rendering relative .md paths as invalid links
				return text;
			},
		);
	}

	// 3. callout header: `> [!info] Title` → private-area marker wrapped in PUA `> CALLOUT:INFO Title`
	//    Use PUA (U+E000/U+E001) instead of `__CALLOUT_X__` so markdown-it does not swallow the surrounding underscores as strong text (`__bold__`).
	s = s.replace(/^(> )\[!([a-zA-Z]+)\](.*)$/gm, (_full, prefix: string, type: string, rest: string) => {
		return `${prefix}CALLOUT:${type.toUpperCase()}${rest}`;
	});

	return restore(s);
}

/** In markdown inline link text, `]` and backslashes must be escaped to avoid breaking the `[text](url)` structure */
function escapeMarkdownLinkText(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

const ANCHOR_LINK_OPEN = '';
const ANCHOR_LINK_CLOSE = '';
const ANCHOR_LINK_RE = /ANCHOR:([^|]*)\|([^|]*)\|([^]*)/g;

function makeAnchorLinkMarker(anchor: string, text: string, pageTitle = ''): string {
	return `${ANCHOR_LINK_OPEN}ANCHOR:${encodeURIComponent(anchor)}|${encodeURIComponent(text)}|${encodeURIComponent(pageTitle)}${ANCHOR_LINK_CLOSE}`;
}

function normalizeWikilinkResolution(value: WikilinkResolution | null): ResolvedWikilink | null {
	if (!value) return null;
	if (typeof value === 'string') return value.trim() ? { url: value.trim() } : null;
	const url = value.url.trim();
	return url ? { url, title: value.title?.trim() || undefined } : null;
}

function inferPageTitle(linkpath: string): string {
	const filename = linkpath.split('/').pop() ?? linkpath;
	return filename.replace(/\.md$/i, '');
}

const CODE_MASK_OPEN = '';
const CODE_MASK_CLOSE = '';
const CODE_MASK_RE = /(\d+)/g;

/**
 * Mask code sections in markdown (fenced ```/~~~ and inline `…`) with placeholders to avoid later Obsidian syntax preprocessing
 * and attachment extraction regexes from corrupting code examples.
 * Returns the masked string and a restore function to put the original text back.
 */
function maskCodeRegions(md: string): { masked: string; restore: (s: string) => string } {
	const buf: string[] = [];
	const stash = (text: string): string => {
		const idx = buf.length;
		buf.push(text);
		return `${CODE_MASK_OPEN}${idx}${CODE_MASK_CLOSE}`;
	};

	// 1. fenced code (``` or ~~~, allowing the same-level indentation to close)
	let masked = md.replace(
		/(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*\n[\s\S]*?\n)\2\3[ \t]*(?=\n|$)/g,
		(_full, lead: string, indent: string, fence: string, body: string) => {
			return `${lead}${stash(`${indent}${fence}${body}${indent}${fence}`)}`;
		},
	);

	// 2. inline code: `...` / ``...`` (balanced backticks; content does not contain newlines)
	masked = masked.replace(/(`+)([^`\n]+?)\1(?!`)/g, (full) => stash(full));

	const restore = (s: string): string =>
		s.replace(CODE_MASK_RE, (_, idxStr: string) => buf[parseInt(idxStr, 10)] ?? '');

	return { masked, restore };
}

interface FenceBlock { lang: string; content: string; }

/** Extract all ``` fence blocks from the raw markdown. This is a simplified implementation; it may differ slightly from markdown-it's rules but is sufficient for this use case. */
function extractFenceBlocks(markdown: string): FenceBlock[] {
	const out: FenceBlock[] = [];
	// markdown-it normalizes \r\n / \r to \n (NEWLINES_RE) at the entrance, and we must do the same here;
	// otherwise, CRLF notes carry \r in the fence content, and the hash will never match the render-side token.content.
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		// Container prefix: a sequence of spaces / tabs / `>` (blockquote marker); fenced lines are allowed to be indented with list / blockquote markers.
		// lang portion: the first token (`[\w-]+`) is enough; it can be followed by an info string (attribute / metadata).
		const m = line.match(/^([\s>]*)(`{3,}|~{3,})\s*([\w-]+)?(?:\s.*?)?\s*$/);
		if (!m) { i += 1; continue; }
		const containerPrefix = m[1]!;
		const indent = containerPrefix.length;
		const fence = m[2]!;
		const lang = (m[3] ?? '').toLowerCase();
		const start = i + 1;
		i = start;
		while (i < lines.length) {
			const closing = lines[i]!.match(/^([\s>]*)(`{3,}|~{3,})\s*$/);
			if (closing && closing[2]!.startsWith(fence[0]!) && closing[2]!.length >= fence.length) {
				// The closing fence's container prefix length should match the opening one (or markdown-it may treat it as a lazy continuation; this is a relaxed check here)
				break;
			}
			i += 1;
		}
		// Per CommonMark / markdown-it rules, the container prefix on each line inside the fence (`>` / indentation) is stripped from the beginning,
		// so the content produced by extractFenceBlocks matches markdown-it's token.content and the fence hash can match.
		// This covers list indentation (spaces), tab indentation, blockquote (`> `), and nested combinations.
		const stripped = indent > 0
			? lines.slice(start, i).map((l) => {
				const lm = l.match(/^([\s>]*)/);
				const lineLen = lm?.[1]?.length ?? 0;
				return l.slice(Math.min(indent, lineLen));
			})
			: lines.slice(start, i);
		const content = stripped.join('\n');
		out.push({ lang, content });
		i += 1;
	}
	return out;
}

interface CalloutType { type: string; macro: string; }

/** Detect whether the first paragraph after blockquote_open is a callout prefix */
function detectCalloutType(tokens: ReadonlyArray<{ type: string; content?: string; children?: Array<{ content: string }> | null }>, openIdx: number): CalloutType | null {
	for (let i = openIdx + 1; i < tokens.length; i++) {
		const tk = tokens[i]!;
		if (tk.type === 'blockquote_close') return null;
		if (tk.type !== 'inline') continue;
		const text = (tk.children?.[0]?.content ?? tk.content ?? '');
		// PUA (U+E000/U+E001) wrapped callout marker — consistent with preprocessObsidianSyntax
		const m = text.match(/^CALLOUT:([A-Z]+)/);
		if (!m) return null;
		// Remove the prefix from the first text token and leave the title behind
		const stripRe = /^CALLOUT:[A-Z]+\s*/;
		if (tk.children?.[0]) {
			tk.children[0].content = tk.children[0].content.replace(stripRe, '');
		} else {
			tk.content = tk.content?.replace(stripRe, '') ?? '';
		}
		const type = m[1]!;
		return { type, macro: mapCalloutMacro(type) };
	}
	return null;
}

function mapCalloutMacro(type: string): string {
	switch (type) {
		case 'NOTE':
		case 'INFO':
		case 'TIP':
		case 'HINT': return 'info';
		case 'WARNING':
		case 'CAUTION':
		case 'ATTENTION': return 'warning';
		case 'DANGER':
		case 'ERROR':
		case 'FAILURE':
		case 'BUG': return 'note'; // Confluence has no danger style, so use a red note
		case 'SUCCESS':
		case 'CHECK':
		case 'DONE': return 'tip';
		case 'QUOTE': return 'expand';
		default: return 'info';
	}
}

function renderAcCode(language: string, code: string): string {
	const langPart = language ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>` : '';
	return `<ac:structured-macro ac:name="code">${langPart}<ac:plain-text-body><![CDATA[${cdataSafe(code)}]]></ac:plain-text-body></ac:structured-macro>`;
}

function renderAcImage(filename: string, alt: string, widthPx = 0): string {
	const altPart = alt ? ` ac:alt="${escapeAttr(alt)}"` : '';
	const width = normalizeImageWidth(widthPx);
	const widthPart = width > 0 ? ` ac:width="${width}"` : '';
	return `<ac:image${widthPart}${altPart}><ri:attachment ri:filename="${escapeAttr(filename)}" /></ac:image>`;
}

function normalizeImageWidth(value: number | undefined): number {
	if (!Number.isFinite(value) || value === undefined || value <= 0) return 0;
	return Math.floor(value);
}

function postProcessHtml(html: string, ctx: ConvertContext): string {
	// markdown-it xhtmlOut=true already handles br/hr/img, but as a safety fallback: all void elements in HTML
	// must self-close in Confluence storage (strict XHTML); otherwise a single unclosed tag causes the parser to treat
	// all subsequent tags as child elements until it reaches a mismatched closing tag and returns a 400 error.
	const voidElements = ['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'embed', 'source', 'track', 'wbr'];
	let out = html;
	for (const tag of voidElements) {
		const re = new RegExp(`<${tag}\\b([^>]*?)(?<!/)>`, 'gi');
		out = out.replace(re, `<${tag}$1 />`);
	}
	// The entire handwritten link list for `[!summary]+ Table of Contents` → official Confluence TOC (H2-H3).
	out = replaceTocMarkersWithMacros(out);
	// @[[Name]] mention sentinel → Confluence user link (embedded during preprocess to bypass markdown-it HTML escaping)
	out = out.replace(/MENTION:([^]*)/g, (_full, username: string) => {
		return `<ac:link><ri:user ri:username="${escapeAttr(username)}" /></ac:link>`;
	});
	// [[#Heading]] / [[note#Heading]] sentinel → Confluence native anchor links.
	// Confluence heading anchors remove whitespace but preserve case and punctuation.
	out = out.replace(ANCHOR_LINK_RE, (_full, anchorPart: string, textPart: string, titlePart: string) => {
		const anchor = tryDecode(anchorPart).replace(/\s+/g, '');
		const text = tryDecode(textPart);
		const pageTitle = tryDecode(titlePart);
		const pagePart = pageTitle ? `<ri:page ri:content-title="${escapeAttr(pageTitle)}" />` : '';
		return `<ac:link ac:anchor="${escapeAttr(anchor)}">${pagePart}<ac:plain-text-link-body><![CDATA[${cdataSafe(text)}]]></ac:plain-text-link-body></ac:link>`;
	});
	if (ctx.stripSupplementaryChars) {
		out = stripSupplementaryChars(out);
	}
	return out.trim();
}

/**
 * Confluence Server typically uses MySQL utf8 (3-byte), which cannot store code points above 0xFFFF
 * (emoji 🆕, Han extension characters like 𠮷, etc.), triggering 400 "Unsupported character found in content".
 *
 * Strategy: replace them with `[U+XXXX]` placeholders, which preserves information while keeping everything ASCII and avoiding the charset limitation.
 * Cloud / utf8mb4 sites support these characters natively, so this behavior is enabled only via settings when needed (issue #5).
 */
function stripSupplementaryChars(s: string): string {
	let out = '';
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		if (cp > 0xFFFF) {
			out += `[U+${cp.toString(16).toUpperCase()}]`;
		} else {
			out += ch;
		}
	}
	return out;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
	return escapeXml(s).replace(/"/g, '&quot;');
}

function cdataSafe(s: string): string {
	// The sequence "]] >" is not allowed inside CDATA, so split it apart
	return s.replace(/]]>/g, ']]]]><![CDATA[>');
}

function tryDecode(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}
