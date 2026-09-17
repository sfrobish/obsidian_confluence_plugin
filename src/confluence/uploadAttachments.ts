import type { App, TFile } from 'obsidian';
import { ConfluenceApi } from './api';
import { AttachmentRecord, AttachmentRef } from '../types';
import { sha1Hex } from '../utils/hash';
import { Logger } from '../utils/logger';

export interface AttachmentUploadDeps {
	app: App;
	api: ConfluenceApi;
	logger: Logger;
	maxSizeBytes: number;
}

export interface AttachmentUploadResult {
	/** filename -> final attachment record already present in Confluence */
	map: Record<string, AttachmentRecord>;
	uploaded: number;
	skipped: number;
	failed: number;
}

/** Known extension → MIME. Confluence accepts any MIME, but declaring it explicitly avoids guessing errors. */
const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	bmp: 'image/bmp',
	pdf: 'application/pdf',
	zip: 'application/zip',
	json: 'application/json',
	txt: 'text/plain',
	md: 'text/markdown',
};

/**
 * Publish a set of attachments to a given page.
 *
 * Flow for each ref →
 *  1. Read binary → sha1
 *  2. Compare with previous[filename]; same hash → reuse and skip upload
 *  3. Different → check whether Confluence already has an attachment with the same name → decide create vs updateData
 *  4. Append to the new map; failures are not added (they will retry next time)
 *
 * Confluence attachments are keyed by filename, so the filename must be unique.
 */
export async function publishAttachments(
	deps: AttachmentUploadDeps,
	pageId: string,
	refs: AttachmentRef[],
	previous: Record<string, AttachmentRecord> = {},
): Promise<AttachmentUploadResult> {
	const result: AttachmentUploadResult = { map: {}, uploaded: 0, skipped: 0, failed: 0 };
	const seen = new Set<string>();

	for (const ref of refs) {
		if (!ref.tfile) {
			deps.logger.warn(`Attachment reference could not be resolved: ${ref.linkpath}`);
			result.failed += 1;
			continue;
		}
		const filename = ref.filename;
		if (seen.has(filename)) continue;
		seen.add(filename);

		try {
			const bytes = await deps.app.vault.readBinary(ref.tfile);
			if (bytes.byteLength > deps.maxSizeBytes) {
				deps.logger.warn(
					`Skipping oversized attachment: ${filename}`,
					`${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB > ${(deps.maxSizeBytes / 1024 / 1024).toFixed(2)} MB`,
				);
				result.skipped += 1;
				continue;
			}

			const hash = await sha1Hex(bytes);
			const prev = previous[filename];
			if (prev && prev.hash === hash) {
				result.map[filename] = prev;
				result.skipped += 1;
				continue;
			}

			const mime = guessMime(filename);
			const record = await upload(deps.api, pageId, filename, bytes, mime, prev?.id);
			result.map[filename] = { hash, id: record.id };
			result.uploaded += 1;
			deps.logger.info(`Attachment uploaded: ${filename}`, `${(bytes.byteLength / 1024).toFixed(1)} KB`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			deps.logger.error(`Attachment upload failed: ${filename}`, msg);
			result.failed += 1;
		}
	}

	return result;
}

/**
 * Publish arbitrary binary attachments (used by mermaid renderers; data is in memory and has no TFile).
 */
export async function uploadBytes(
	deps: AttachmentUploadDeps,
	pageId: string,
	filename: string,
	data: ArrayBuffer,
	previous: Record<string, AttachmentRecord> = {},
): Promise<AttachmentRecord | null> {
	try {
		const hash = await sha1Hex(data);
		const prev = previous[filename];
		if (prev && prev.hash === hash) return prev;
		const mime = guessMime(filename);
		const record = await upload(deps.api, pageId, filename, data, mime, prev?.id);
		return { hash, id: record.id };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		deps.logger.error(`Diagram attachment upload failed: ${filename}`, msg);
		return null;
	}
}

async function upload(
	api: ConfluenceApi,
	pageId: string,
	filename: string,
	data: ArrayBuffer,
	mime: string,
	knownAttachmentId: string | undefined,
): Promise<{ id: string }> {
	// Prefer the cached attachmentId and use updateData; if 404, fall back to find + create.
	if (knownAttachmentId) {
		try {
			const r = await api.updateAttachment(pageId, knownAttachmentId, filename, data, mime);
			return { id: r.id };
		} catch {
			// The attachment may have been deleted on the Confluence side; continue with the find/create flow.
		}
	}
	const existing = await api.findAttachmentByFilename(pageId, filename);
	if (existing) {
		const r = await api.updateAttachment(pageId, existing.id, filename, data, mime);
		return { id: r.id };
	}
	const r = await api.createAttachment(pageId, filename, data, mime);
	return { id: r.id };
}

function guessMime(filename: string): string {
	const idx = filename.lastIndexOf('.');
	if (idx < 0) return 'application/octet-stream';
	const ext = filename.slice(idx + 1).toLowerCase();
	return MIME[ext] ?? 'application/octet-stream';
}

/** Helper: use Obsidian metadataCache to resolve link → TFile; if that fails, fall back to a full-vault filename search. */
export function resolveAttachmentFile(app: App, linkpath: string, sourcePath: string): TFile | null {
	const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
	if (dest) return dest;
	const base = linkpath.split('/').pop() ?? linkpath;
	const all = app.vault.getFiles();
	return all.find((f) => f.name === base) ?? null;
}
