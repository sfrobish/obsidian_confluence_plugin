import { App, Component, MarkdownRenderer, requestUrl } from 'obsidian';
import { DiagramBlock } from './markdownConverter';
import { Logger } from '../utils/logger';

export type RenderedMermaid = { block: DiagramBlock; png: ArrayBuffer };

export interface IMermaidRenderer {
	renderAll(blocks: DiagramBlock[]): Promise<Array<RenderedMermaid | null>>;
	/** Extension used during upload — kroki uses png, Obsidian native uses svg. */
	extension(): 'svg' | 'png';
}

/**
 * Mermaid source → PNG (via kroki HTTP service).
 *
 * By default uses the public https://kroki.io instance (internal mermaid-cli + headless Chrome,
 * with a complete font set and support for Chinese / emoji rendering). Users can also point to a self-hosted instance.
 *
 * Pros: complete font fallback, best compatibility with older Confluence (PNG raster always renders), consistent cross-platform behavior.
 * Cons: requires network access (self-host in enterprise intranets), timeline diagrams (gantt / timeline) render at a smaller size and dates can crowd together.
 */
export class KrokiMermaidRenderer implements IMermaidRenderer {
	constructor(
		private serverUrl: string,
		private logger: Logger,
	) {}

	extension(): 'svg' | 'png' {
		return /\/svg(\b|\/?$)/i.test(this.serverUrl) ? 'svg' : 'png';
	}

	async renderAll(blocks: DiagramBlock[]): Promise<Array<RenderedMermaid | null>> {
		const results: Array<RenderedMermaid | null> = [];
		for (const b of blocks) {
			try {
				const png = await this.renderWithRetry(b.source);
				results.push({ block: b, png });
				// The public kroki instance throttles bursts; leave a small pause between blocks to avoid rate limiting
				await delay(200);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.logger.warn(`Mermaid rendering failed; falling back to a code block: ${b.filename}`, msg);
				results.push(null);
			}
		}
		return results;
	}

	private async renderWithRetry(source: string): Promise<ArrayBuffer> {
		let lastErr: unknown = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await this.renderOne(source);
			} catch (e) {
				lastErr = e;
				const msg = e instanceof Error ? e.message : String(e);
				// 429 rate limiting / 5xx temporary service unavailability → retry after backoff; other errors (syntax errors, etc.) are thrown immediately
				if (!/\b(429|5\d{2})\b/.test(msg)) throw e;
				const backoff = 500 * Math.pow(2, attempt); // 500ms / 1s / 2s
				this.logger.warn(`kroki is temporarily unavailable; retrying in ${backoff}ms (${attempt + 1}/3)`, msg);
				await delay(backoff);
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	}

	private async renderOne(source: string): Promise<ArrayBuffer> {
		const res = await requestUrl({
			method: 'POST',
			url: this.serverUrl,
			contentType: 'text/plain; charset=utf-8',
			body: source,
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`kroki returned ${res.status}: ${(res.text ?? '').slice(0, 200)}`);
		}
		return res.arrayBuffer;
	}
}

/**
 * Mermaid source → SVG (using Obsidian's built-in mermaid engine + MarkdownRenderer rendering).
 *
 * Pros: matches the note preview pixel-for-pixel, has no network dependency, and the mermaid version tracks Obsidian updates,
 *      so timeline diagram widths expand naturally with content and do not crowd together.
 * Cons: output is SVG (older Confluence 5.x and below may not render inline and may require download links),
 *      fonts follow the Obsidian theme (exported graphics reference local fonts, and remote Confluence users fall back to the system default),
 *      and some advanced mermaid features (such as wikilink in node) are not clickable on the Confluence side.
 */
export class ObsidianMermaidRenderer implements IMermaidRenderer {
	constructor(
		private app: App,
		private logger: Logger,
	) {}

	extension(): 'svg' | 'png' { return 'svg'; }

	async renderAll(blocks: DiagramBlock[]): Promise<Array<RenderedMermaid | null>> {
		const results: Array<RenderedMermaid | null> = [];
		for (const b of blocks) {
			try {
				const svgText = await this.renderOne(b.source);
				const bytes = new TextEncoder().encode(svgText).buffer;
				results.push({ block: b, png: bytes });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.logger.warn(`Mermaid rendering failed; falling back to a code block: ${b.filename}`, msg);
				results.push(null);
			}
		}
		return results;
	}

	private async renderOne(source: string): Promise<string> {
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
			await MarkdownRenderer.render(this.app, '```mermaid\n' + source + '\n```', host, '', comp);
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
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
