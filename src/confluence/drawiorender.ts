import '../../assets/viewer-static.min.js';
import { DiagramBlock } from './markdownConverter';
import { Logger } from '../utils/logger';

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
				const msg = e instanceof Error ? e.message : String(e);
				this.logger.warn(`Draw.io rendering failed; falling back to a code block: ${b.filename}`, msg);
				results.push(null);
			}
		}
		return results;
	}

	private async renderOne(source: string): Promise<ArrayBuffer> {
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

			await new Promise<void>((resolve, reject) => {
				const timer = window.setTimeout(() => reject(new Error('Draw.io render timed out after 15s')), 15000);
				const done = () => {
					window.clearTimeout(timer);
					resolve();
				};
				try {
					viewer.addListener('render', done);
				} catch (e) {
					window.clearTimeout(timer);
					reject(e);
				}
			});

			const svg = (viewer.graph && typeof viewer.graph.getSvg === 'function')
				? viewer.graph.getSvg()
				: host.querySelector('svg');
			if (!svg || svg.nodeName.toLowerCase() !== 'svg') {
				throw new Error('Draw.io produced no SVG output');
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
