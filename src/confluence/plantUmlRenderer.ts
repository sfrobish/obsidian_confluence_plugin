import { requestUrl } from 'obsidian';
import { DiagramBlock } from './markdownConverter';
import { Logger } from '../utils/logger';

/**
 * PlantUML text encoding + remote PNG retrieval.
 *
 * Encoding algorithm (official PlantUML):
 *   utf-8 bytes → raw deflate → custom base64 alphabet
 *
 * Alphabet (note: differs from standard base64):
 *   0-9A-Za-z plus '-' '_', in the official PlantUML order.
 *
 * raw deflate uses the browser-native CompressionStream('deflate-raw');
 * Electron / Chrome ≥ 80 support this, and Obsidian desktop works out of the box.
 */
export class PlantUmlRenderer {
	constructor(
		private serverUrl: string,
		private logger: Logger,
	) {}

	async renderAll(blocks: DiagramBlock[]): Promise<Array<{ block: DiagramBlock; png: ArrayBuffer } | null>> {
		const out: Array<{ block: DiagramBlock; png: ArrayBuffer } | null> = [];
		for (const b of blocks) {
			try {
				const png = await this.renderOne(b.source);
				out.push({ block: b, png });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.logger.warn(`PlantUML rendering failed; falling back to a code block: ${b.filename}`, msg);
				out.push(null);
			}
		}
		return out;
	}

	private async renderOne(source: string): Promise<ArrayBuffer> {
		const encoded = await encodePlantUml(source);
		const base = this.serverUrl.replace(/\/+$/, '');
		const url = `${base}/png/${encoded}`;
		const res = await requestUrl({ url, method: 'GET', throw: false });
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`PlantUML server returned ${res.status}`);
		}
		return res.arrayBuffer;
	}
}

const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

async function encodePlantUml(source: string): Promise<string> {
	const utf8 = new TextEncoder().encode(source);
	const deflated = await deflateRaw(utf8);
	return encode64(deflated);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const CS = (window as unknown as { CompressionStream?: typeof CompressionStream }).CompressionStream;
	if (!CS) throw new Error('CompressionStream is unavailable; cannot encode PlantUML');
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS('deflate-raw'));
	const buf = await new Response(stream).arrayBuffer();
	return new Uint8Array(buf);
}

function encode64(data: Uint8Array): string {
	let r = '';
	for (let i = 0; i < data.length; i += 3) {
		const a = data[i]!;
		const b = i + 1 < data.length ? data[i + 1]! : 0;
		const c = i + 2 < data.length ? data[i + 2]! : 0;
		r += PLANTUML_ALPHABET[a >> 2];
		r += PLANTUML_ALPHABET[((a & 0x3) << 4) | (b >> 4)];
		r += PLANTUML_ALPHABET[((b & 0xF) << 2) | (c >> 6)];
		r += PLANTUML_ALPHABET[c & 0x3F];
	}
	return r;
}
