import { App, Component, MarkdownRenderer } from 'obsidian';
import { DiagramBlock } from './convertMarkdown';
import { Logger } from '../utils/logger';

export type RenderedMermaid = { block: DiagramBlock; png: ArrayBuffer };

/**
 * Mermaid source → SVG (using Obsidian's built-in mermaid engine + MarkdownRenderer rendering).
 *
 * Matches the note preview pixel-for-pixel, has no network dependency, and the mermaid version tracks Obsidian
 * updates, so timeline diagram widths expand naturally with content and do not crowd together. Output is always
 * SVG: fonts follow the Obsidian theme (exported graphics reference local fonts, and remote Confluence users
 * fall back to the system default), and some advanced mermaid features (such as wikilink in node) are not
 * clickable on the Confluence side.
 */
export async function renderAllMermaid(blocks: DiagramBlock[], app: App, logger: Logger): Promise<Array<RenderedMermaid | null>> {
	const results: Array<RenderedMermaid | null> = [];
	for (const b of blocks) {
		try {
			const svgText = await renderOneMermaid(app, b.source);
			const bytes = new TextEncoder().encode(svgText).buffer;
			results.push({ block: b, png: bytes });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logger.warn(`Mermaid rendering failed; falling back to a code block: ${b.filename}`, msg);
			results.push(null);
		}
	}
	return results;
}

async function renderOneMermaid(app: App, source: string): Promise<string> {
	// Hidden mount point. Give it a wide width so when mermaid uses useMaxWidth=true, the SVG can use the full container width
	// and calculate a natural layout that fits the content (especially important for gantt chart horizontal-axis density, which depends on container width).
	const host = activeDocument.createElement('div');
	host.setCssStyles({
		position: 'absolute',
		left: '-99999px',
		top: '0',
		width: '2000px',
		visibility: 'hidden',
		pointerEvents: 'none',
	});
	activeDocument.body.appendChild(host);
	const comp = new Component();
	comp.load();
	try {
		await MarkdownRenderer.render(app, '```mermaid\n' + source + '\n```', host, '', comp);
		// Mermaid rendering is asynchronous (the DOM placeholder is ready when the promise resolves; the actual SVG is inserted by mermaid in a microtask later)
		let svg: SVGSVGElement | null = null;
		for (let i = 0; i < 200; i++) {
			const el = host.querySelector('svg');
			if (el) {
				// Mermaid occasionally inserts an empty SVG placeholder first and replaces it after internal rendering completes.
				// Validate that the viewBox / child nodes are all present before accepting it.
				if (el.querySelector('g, path, rect, text')) {
					svg = el;
					break;
				}
			}
			await delay(25);
		}
		if (!svg) throw new Error('SVG did not render within 5s');

		// Self-containment: freeze the inline dimensions derived from viewBox into width / height,
		// so the Confluence server can parse them correctly instead of failing to resolve width="100%".
		const vb = svg.viewBox?.baseVal;
		if (vb && vb.width > 0) {
			const widthAttr = svg.getAttribute('width') ?? '';
			if (!widthAttr || widthAttr.includes('%') || widthAttr === 'auto') {
				svg.setAttribute('width', String(Math.ceil(vb.width)));
			}
			const heightAttr = svg.getAttribute('height') ?? '';
			if (!heightAttr || heightAttr.includes('%') || heightAttr === 'auto') {
				svg.setAttribute('height', String(Math.ceil(vb.height)));
			}
		}
		// Fill in the default xmlns when missing; otherwise some XML parsers do not recognize the SVG.
		if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
		if (!svg.getAttribute('xmlns:xlink')) svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

		return new XMLSerializer().serializeToString(svg);
	} finally {
		comp.unload();
		host.remove();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
