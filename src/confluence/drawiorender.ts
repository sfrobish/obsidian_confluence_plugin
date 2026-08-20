import { createRequire } from 'node:module';
import { DiagramBlock } from './markdownConverter';
import { Logger } from '../utils/logger';

const requireFromModule = createRequire(import.meta.url);

function ensureOfflineViewerLoaded(): void {
	if (typeof window === 'undefined') return;
	if ((window as any).GraphViewer && (window as any).mxUtils) return;
	try {
		requireFromModule('../../assets/viewer-static.min.cjs');
	} catch (err) {
		// In the bundled plugin, the asset may still be reachable via the repo-root path.
		// The render path checks the globals explicitly below and will fail fast if the viewer is unavailable.
		const msg = err instanceof Error ? err.message : String(err);
		console.warn('Draw.io viewer load failed via CJS require:', msg);
	}
}

export type RenderedDrawio = { block: DiagramBlock; svg: ArrayBuffer };

export class OfflineDrawioRenderer {
	constructor(
		private logger: Logger,
	) {}

	async renderAll(blocks: DiagramBlock[]): Promise<Array<RenderedDrawio | null>> {
		const results: Array<RenderedDrawio | null> = [];
		for (const b of blocks) {
			try {
				const svg = await this.renderOne(b.source);
				results.push({ block: b, svg });
			} catch (e) {
				const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
				this.logger.warn(`Draw.io rendering failed; falling back to a code block: ${b.filename}`, msg);
				results.push(null);
			}
		}
		return results;
	}

	private async renderOne(source: string): Promise<ArrayBuffer> {
		ensureOfflineViewerLoaded();
		if (typeof window === 'undefined' || !(window as any).GraphViewer || !(window as any).mxUtils) {
			throw new Error('Draw.io viewer script is not available in this Obsidian session');
		}

		const doc = window.document ?? (globalThis as any).document ?? null;
		if (!doc) throw new Error('No DOM is available to render the Draw.io diagram');
		const host = doc.createElement('div');
		host.setCssStyles({
			position: 'absolute',
			left: '-99999px',
			top: '0',
			width: '1200px',
			height: '900px',
			visibility: 'hidden',
			pointerEvents: 'none',
			overflow: 'hidden',
		});
		doc.body.appendChild(host);

		let viewer: any = null;
		try {
			const xmlDoc = (window as any).mxUtils.parseXml(source);
			viewer = new (window as any).GraphViewer(host, xmlDoc.documentElement, {
				toolbar: '',
				nav: 0,
				resize: 0,
				border: 0,
				autoFit: true,
				autoCrop: true,
				autoOrigin: true,
				center: false,
				responsive: false,
				title: '',
			});

			const getSvg = () => (viewer.graph && typeof viewer.graph.getSvg === 'function')
				? viewer.graph.getSvg()
				: host.querySelector('svg');

			// The offline GraphViewer does not reliably fire the "render" event in all
			// embedded contexts, and the event may already be missed before we attach a listener.
			// Poll the DOM directly instead: as soon as the viewer materializes the SVG, we use it.
			const started = Date.now();
			let svg = getSvg();
			while (!svg && Date.now() - started < 30000) {
				await new Promise((resolve) => window.setTimeout(resolve, 100));
				svg = getSvg();
			}
			if (!svg || svg.nodeName.toLowerCase() !== 'svg') {
				throw new Error('Draw.io produced no SVG output after 30s');
			}

			if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
			if (!svg.getAttribute('xmlns:xlink')) svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
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

			return new TextEncoder().encode(new XMLSerializer().serializeToString(svg)).buffer;
		} finally {
			if (viewer && typeof viewer.destroy === 'function') viewer.destroy();
			host.remove();
		}
	}
}
