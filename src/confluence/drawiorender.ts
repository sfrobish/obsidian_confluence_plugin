import { DiagramBlock } from './markdownConverter';
import { Logger } from '../utils/logger';

function getRuntimeLocationInfo(): string {
	const bits: string[] = [];
	try {
		const runtimeDir = typeof __dirname !== 'undefined' ? __dirname : '(no __dirname)';
		bits.push(`__dirname=${runtimeDir}`);
	} catch {
		bits.push('__dirname=unavailable');
	}
	try {
		const currentDir = typeof process !== 'undefined' && process.cwd ? process.cwd() : '(no process.cwd)';
		bits.push(`process.cwd=${currentDir}`);
	} catch {
		bits.push('process.cwd=unavailable');
	}
	try {
		const mainFile = typeof require !== 'undefined' && require.main ? require.main.filename : '(no require.main)';
		bits.push(`require.main=${mainFile}`);
	} catch {
		bits.push('require.main=unavailable');
	}
	try {
		const winLoc = typeof window !== 'undefined' ? window.location?.href : '(no window)';
		bits.push(`window.location=${winLoc}`);
	} catch {
		bits.push('window.location=unavailable');
	}
	return bits.join(' | ');
}

function ensureOfflineViewerLoaded(): void {
	if (typeof window === 'undefined') return;
	if ((window as any).GraphViewer && (window as any).mxUtils) return;

	const path = require('path');
	const runtimeHints = [] as string[];
	if (typeof __dirname !== 'undefined') {
		runtimeHints.push(path.resolve(__dirname, 'viewer-static.min.cjs'));
		runtimeHints.push(path.resolve(__dirname, '..', 'viewer-static.min.cjs'));
		runtimeHints.push(path.resolve(__dirname, '..', '..', 'assets', 'viewer-static.min.cjs'));
	}
	const candidatePaths = [
		...runtimeHints,
		'./viewer-static.min.cjs',
		'../viewer-static.min.cjs',
		'../../assets/viewer-static.min.cjs',
	];

	const runtimeInfo = getRuntimeLocationInfo();
	console.info('[Draw.io] Offline viewer load context:', runtimeInfo);
	console.info('[Draw.io] Loading viewer with candidate paths:', candidatePaths.join(', '));

	for (const candidate of candidatePaths) {
		try {
			// In the packaged plugin, the asset is copied next to main.js in dist/. In source builds,
			// the repo asset path is also valid. The viewer script mutates window and exposes GraphViewer/mxUtils.
			const resolved = path.isAbsolute(candidate) ? candidate : require.resolve(candidate);
			console.info('[Draw.io] Trying viewer path:', resolved);
			require(resolved);
			if ((window as any).GraphViewer && (window as any).mxUtils) return;
		} catch (error) {
			console.debug('[Draw.io] viewer candidate failed:', candidate, error);
		}
	}

	console.warn('[Draw.io] viewer script is not available in this Obsidian session; runtime context:', runtimeInfo, 'checked:', candidatePaths.join(', '));
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
