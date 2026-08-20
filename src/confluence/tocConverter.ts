const TOC_MARKER = 'CONFLUENCE_TOC';

const TOC_CALLOUT_RE =
	/^>[ \t]*\[!summary\][+-]?[ \t]+Table of Contents[ \t]*(?:\r?\n|$)(?:^>[^\r\n]*(?:\r?\n|$))*/gim;

const WIKILINK_HEADING_RE = /\[\[#(?!\^)[^\]\r\n]+\]\]/;
const MARKDOWN_HEADING_RE = /\[[^\]\r\n]+\]\((?:<#[^>\r\n]+>|#[^\s)\r\n]+)\)/;
const TOC_PARAGRAPH_RE = new RegExp(`<p>\\s*${TOC_MARKER}\\s*</p>`, 'g');

const CONFLUENCE_TOC_MACRO =
	'<ac:structured-macro ac:name="toc">' +
	'<ac:parameter ac:name="minLevel">2</ac:parameter>' +
	'<ac:parameter ac:name="maxLevel">3</ac:parameter>' +
	'</ac:structured-macro>';

/**
 * Replace the handwritten table-of-contents callout used for local reading in Obsidian with a private marker.
 *
 * Only matches a summary callout whose title is "Table of Contents" and whose body must include a link to the same-page heading;
 * this prevents ordinary summary callouts from being misidentified. Callers should block code sections first to avoid converting
 * callout syntax in code examples.
 */
export function replaceMarkdownTocCallouts(markdown: string): string {
	return markdown.replace(TOC_CALLOUT_RE, (block) => {
		if (!WIKILINK_HEADING_RE.test(block) && !MARKDOWN_HEADING_RE.test(block)) {
			return block;
		}
		const trailingNewline = block.endsWith('\r\n') ? '\r\n' : block.endsWith('\n') ? '\n' : '';
		return TOC_MARKER + trailingNewline;
	});
}

/** Replace the table-of-contents marker after markdown-it renders it with the official Confluence TOC macro. */
export function replaceTocMarkersWithMacros(html: string): string {
	return html.replace(TOC_PARAGRAPH_RE, CONFLUENCE_TOC_MACRO);
}
