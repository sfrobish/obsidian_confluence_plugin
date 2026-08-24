import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { URL as NodeURL } from 'url';

const ElectronApi = (() => {
	try {
		const candidates = [
			typeof require === 'function' ? require('electron') : null,
			typeof window !== 'undefined' && (window as any).require ? (window as any).require('electron') : null,
			typeof globalThis !== 'undefined' && (globalThis as any).require ? (globalThis as any).require('electron') : null,
		];

		return candidates.find((candidate) => Boolean(candidate)) ?? null;
	} catch {
		return null;
	}
})();

type ElectronRuntimeStatus =
	| 'not-electron'
	| 'electron-session-ready'
	| 'electron-module-unavailable'
	| 'electron-session-unavailable'
	| 'electron-detection-error';

function getElectronRuntimeStatus(): ElectronRuntimeStatus {
	const hasElectronProcess = typeof process !== 'undefined' && !!process.versions?.electron;
	const hasWindowRequire = typeof window !== 'undefined' && typeof (window as any).require === 'function';
	const hasGlobalRequire = typeof globalThis !== 'undefined' && typeof (globalThis as any).require === 'function';
	const hasElectronUA = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent || '');

	if (!hasElectronProcess && !hasWindowRequire && !hasGlobalRequire && !hasElectronUA) {
		return 'not-electron';
	}
	if (!ElectronApi) return 'electron-module-unavailable';
	if (ElectronApi.net && ElectronApi.session) return 'electron-session-ready';
	if (ElectronApi) return 'electron-session-unavailable';
	return 'electron-detection-error';
}

export class ConfluenceApiError extends Error {
	constructor(public status: number, public code: ConfluenceErrorCode, message: string, public details?: string) {
		super(message);
		this.name = 'ConfluenceApiError';
	}
}

export type ConfluenceErrorCode =
	| 'auth_failed'
	| 'not_found'
	| 'version_conflict'
	| 'rate_limited'
	| 'network'
	| 'invalid_response'
	| 'unknown';

export interface PageInfo {
	id: string;
	title: string;
	version: number;
	type: string;
	spaceKey?: string;
}

export interface UpdatePagePayload {
	title: string;
	storageXhtml: string;
	newVersion: number;
}

export interface AttachmentMeta {
	id: string;
	filename: string;
	version: number;
	mediaType?: string;
}

export type ConfluenceAuthType = 'basic' | 'bearer';

export interface ConfluenceApiConfig {
	baseUrl: string;
	authType: ConfluenceAuthType;
	/** Required when authType=basic: Cloud uses email, Server uses the domain account; ignored for authType=bearer. */
	username: string;
	/** For authType=basic: Cloud API token or Server domain password; for authType=bearer: PAT. */
	apiToken: string;
}

/**
 * Confluence REST v1 client using Obsidian requestUrl (avoids CORS and automatically includes Electron UA).
 *
 * Key design points:
 * - Normalize baseUrl to a form without a trailing slash, e.g. https://xxx.atlassian.net/wiki
 * - Basic Auth: Authorization: Basic base64(username:token)
 * - Standardize errors as ConfluenceApiError with categorized codes so callers can handle them differently
 */
export class ConfluenceApi {
	private baseUrl: string;
	private authHeader: string;

	constructor(config: ConfluenceApiConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, '');
		if (config.authType === 'bearer') {
			this.authHeader = `Bearer ${config.apiToken}`;
		} else {
			this.authHeader = `Basic ${encodeBase64Utf8(`${config.username}:${config.apiToken}`)}`;
		}
	}

	/** GET /rest/api/user/current — used to validate the token. Returns the current user displayName. */
	async validateAuth(): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
		try {
			const res = await this.sessionRequest({
				method: 'GET',
				url: `${this.baseUrl}/rest/api/user/current`,
			});
			const data = JSON.parse(res.text) as { displayName?: string; email?: string };
			return { ok: true, displayName: data.displayName ?? data.email ?? '<unknown>' };
		} catch (e) {
			const err = e as ConfluenceApiError;
			return { ok: false, error: err.message };
		}
	}

	/** GET a single page's metadata (version + title). */
	async getPage(pageId: string): Promise<PageInfo> {
		const res = await this.sessionRequest({
			method: 'GET',
			url: `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}?expand=version,space`,
		});
		const data = JSON.parse(res.text) as {
			id: string;
			title: string;
			type: string;
			version?: { number: number };
			space?: { key: string };
		};
		return {
			id: data.id,
			title: data.title,
			version: data.version?.number ?? 1,
			type: data.type,
			spaceKey: data.space?.key,
		};
	}

	/** POST to create a child page. Returns the new page ID and webui URL (used to write back frontmatter). */
	async createPage(opts: {
		spaceKey: string;
		parentId: string;
		title: string;
		storageXhtml: string;
	}): Promise<{ id: string; title: string; webUrl: string }> {
		const body = JSON.stringify({
			type: 'page',
			title: opts.title,
			space: { key: opts.spaceKey },
			ancestors: [{ id: opts.parentId }],
			body: {
				storage: {
					value: opts.storageXhtml,
					representation: 'storage',
				},
			},
		});
		const url = `${this.baseUrl}/rest/api/content`;
		const { status, text } = await this.sessionRequest({
			method: 'POST',
			url,
			contentType: 'application/json',
			body,
		});
		if (status < 200 || status >= 300) {
			const code = classifyError(status);
			const details = truncate(text, 500);
			throw new ConfluenceApiError(status, code, buildErrorMessage('POST', url, status, details), details);
		}
		const data = JSON.parse(text) as {
			id: string;
			title: string;
			_links?: { base?: string; webui?: string };
		};
		const base = data._links?.base ?? this.baseUrl;
		const webui = data._links?.webui ?? `/pages/viewpage.action?pageId=${data.id}`;
		return { id: data.id, title: data.title, webUrl: base + webui };
	}

	/** PUT to update a page. If it fails with 409, throw version_conflict so the caller can retry. */
	async updatePage(pageId: string, payload: UpdatePagePayload): Promise<void> {
		const body = JSON.stringify({
			id: pageId,
			type: 'page',
			title: payload.title,
			version: { number: payload.newVersion },
			body: {
				storage: {
					value: payload.storageXhtml,
					representation: 'storage',
				},
			},
		});
		await this.sessionRequest({
			method: 'PUT',
			url: `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`,
			contentType: 'application/json',
			body,
		});
	}

	/** List attachments for a specific filename to decide whether to create or update a version. */
	async findAttachmentByFilename(pageId: string, filename: string): Promise<AttachmentMeta | null> {
		const url = `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?filename=${encodeURIComponent(filename)}`;
		const res = await this.sessionRequest({ method: 'GET', url });
		const data = JSON.parse(res.text) as {
			results?: Array<{
				id: string;
				title: string;
				version?: { number: number };
				metadata?: { mediaType?: string };
			}>;
		};
		const first = data.results?.[0];
		if (!first) return null;
		return {
			id: first.id,
			filename: first.title,
			version: first.version?.number ?? 1,
			mediaType: first.metadata?.mediaType,
		};
	}

	/** Create an attachment: POST /rest/api/content/{pageId}/child/attachment (multipart) */
	async createAttachment(pageId: string, filename: string, data: ArrayBuffer, mimeType: string): Promise<AttachmentMeta> {
		const url = `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
		const res = await this.uploadMultipart(url, filename, data, mimeType);
		const parsed = JSON.parse(res.text) as { results: Array<{ id: string; title: string; version?: { number: number } }> };
		const r = parsed.results[0];
		if (!r) throw new ConfluenceApiError(500, 'invalid_response', 'Confluence returned an empty results array');
		return { id: r.id, filename: r.title, version: r.version?.number ?? 1 };
	}

	/** Update the binary content of an existing attachment: POST /rest/api/content/{pageId}/child/attachment/{attId}/data */
	async updateAttachment(pageId: string, attachmentId: string, filename: string, data: ArrayBuffer, mimeType: string): Promise<AttachmentMeta> {
		const url = `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(attachmentId)}/data`;
		const res = await this.uploadMultipart(url, filename, data, mimeType);
		const parsed = JSON.parse(res.text) as { id: string; title: string; version?: { number: number } };
		return { id: parsed.id ?? attachmentId, filename: parsed.title ?? filename, version: parsed.version?.number ?? 1 };
	}

	private async uploadMultipart(url: string, filename: string, data: ArrayBuffer, mimeType: string): Promise<{ status: number; text: string }> {
		const electronStatus = getElectronRuntimeStatus();
		if (electronStatus !== 'electron-session-ready') {
			const reason = `Electron session is unavailable (${electronStatus}); Confluence write requests must use the authenticated desktop session.`;
			console.warn(`[ConfluenceApi] ${reason}`);
			throw new ConfluenceApiError(0, 'network', reason);
		}

		console.info('[ConfluenceApi] Using Electron session.fetch for attachment request');
		const boundary = `----obsidian-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const body = new Blob([
			`--${boundary}\r\n`,
			`Content-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, '\\"')}"\r\n`,
			`Content-Type: ${mimeType}\r\n\r\n`,
			new Uint8Array(data),
			`\r\n--${boundary}--\r\n`,
		], { type: 'application/octet-stream' });

		const response = await this.sessionRequest({
			method: 'POST',
			url,
			contentType: `multipart/form-data; boundary=${boundary}`,
			body,
		});
		return response;
	}

	private async getSessionCookieHeader(url: string): Promise<string> {
		if (!ElectronApi || !ElectronApi.session || !ElectronApi.session.defaultSession) return '';
		try {
			const origin = new NodeURL(url).origin;
			const cookies = await ElectronApi.session.defaultSession.cookies.get({ url: origin });
			return cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
		} catch {
			return '';
		}
	}

	private async sessionRequest(opts: {
		method: string;
		url: string;
		body?: string | ArrayBuffer | Blob;
		contentType?: string;
	}): Promise<{ status: number; text: string }> {
		const status = getElectronRuntimeStatus();
		if (status !== 'electron-session-ready') {
			const reason = `Confluence request attempted without a valid Electron session (${status}).`;
			throw new ConfluenceApiError(0, 'network', reason);
		}

		const cookieHeader = await this.getSessionCookieHeader(opts.url);
		const cookieCount = cookieHeader ? cookieHeader.split(';').filter(Boolean).length : 0;
		if (opts.method !== 'GET' && cookieCount === 0) {
			console.warn('[ConfluenceApi] No Confluence cookies found in Electron session before write request', {
				method: opts.method,
				url: opts.url,
				origin: new NodeURL(opts.url).origin,
			});
		}
		const headers: Record<string, string> = {
			Authorization: this.authHeader,
			Accept: 'application/json',
			...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
			...(cookieHeader ? { Cookie: cookieHeader } : {}),
		};

		console.info('[ConfluenceApi] Session request', {
			method: opts.method,
			url: opts.url,
			hasCookieHeader: !!cookieHeader,
			cookieCount,
			status,
		});
		const response = await ElectronApi.session.defaultSession.fetch(opts.url, {
			method: opts.method,
			headers,
			body: opts.body,
		});

		const text = await response.text();
		const responseStatus = response.status;
		if (responseStatus >= 200 && responseStatus < 300) {
			return { status: responseStatus, text };
		}

		const code = classifyError(responseStatus);
		const details = truncate(text, 500);
		const message = buildErrorMessage(opts.method, opts.url, responseStatus, details);
		throw new ConfluenceApiError(responseStatus, code, message, details);
	}
}

function classifyError(status: number): ConfluenceErrorCode {
	if (status === 401 || status === 403) return 'auth_failed';
	if (status === 404) return 'not_found';
	if (status === 409) return 'version_conflict';
	if (status === 429) return 'rate_limited';
	return 'unknown';
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + '...';
}

function buildErrorMessage(method: string, url: string, status: number, details: string): string {
	const path = url.replace(/^https?:\/\/[^/]+/, '');
	return `Confluence ${method} ${path} → ${status}${details ? ': ' + details : ''}`;
}


/** UTF-8-safe Base64 encoding; Obsidian desktop runs in Electron, where btoa is available in the browser side but only accepts latin1. */
function encodeBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}
