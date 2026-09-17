import type { TFile } from 'obsidian';
import { t } from './i18n';

export interface LogEntry {
	timestamp: Date;
	level: 'info' | 'warn' | 'error';
	message: string;
	details?: string;
}

export enum PublishStatus {
	Idle = 'idle',
	Publishing = 'publishing',
	Success = 'success',
	Failed = 'failed',
	Partial = 'partial',
}

/**
 * Label shown in the status-bar pill. Evaluated lazily via getters so the
 * active locale (resolved once at i18n load time) is applied at read time.
 */
export const PublishStatusText: Record<PublishStatus, string> = {
	get [PublishStatus.Idle]() { return t('status.idle'); },
	get [PublishStatus.Publishing]() { return t('status.publishing'); },
	get [PublishStatus.Success]() { return t('status.success'); },
	get [PublishStatus.Failed]() { return t('status.failed'); },
	get [PublishStatus.Partial]() { return t('status.partial'); },
} as Record<PublishStatus, string>;

export interface AttachmentRecord {
	hash: string;
	id: string;
}

export interface PublishTarget {
	/** confluence_url. Empty string means the page has not been created yet; use parentUrl with the createPage flow. */
	url: string;
	/** confluence_parent_url. Only used when url is empty; specifies which parent page the new page should be attached to. */
	parentUrl?: string;
	/** resolved or created page ID; empty string when not yet created */
	pageId: string;
}

export type FrontmatterFieldFormat = 'scalar' | 'csv' | 'array';

export interface NoteBindingFormats {
	url: FrontmatterFieldFormat;
	parentUrl: FrontmatterFieldFormat;
	pageId: FrontmatterFieldFormat;
}

/** Confluence binding information for a single note (read from frontmatter). */
export interface NoteBinding {
	/** index-aligned Confluence target slots; at least one entry */
	targets: PublishTarget[];
	/** in-memory only; used to preserve scalar/csv/array frontmatter style on write */
	_formats?: NoteBindingFormats;
	lastPublished?: string;
	/**
	 * Cached content hash used for the per-target skip check. Shape:
	 * `instanceId → pageId → hash`. The instanceId layer is required because
	 * Confluence pageIds are local to a Server/DC installation — two
	 * instances can have the same pageId, and a single pageId key would let
	 * engine A's stamp vouch for engine B's target. Each engine owns only
	 * its own instance slot; foreign slots are preserved verbatim. Pre-
	 * multi-instance string form was migrated to this shape by
	 * `migrateLegacyFrontmatter` on plugin load.
	 */
	lastHash?: Record<string, Record<string, string>>;
	/**
	 * Attachment cache. Same nested shape: `instanceId → pageId → filename →
	 * { hash, id }`. Pre-multi-instance flat form
	 * `{ filename: { hash, id } }` was migrated by `migrateLegacyFrontmatter`.
	 */
	attachments?: Record<string, Record<string, Record<string, AttachmentRecord>>>;
}

/** Local attachment references extracted from markdown. */
export interface AttachmentRef {
	/** The source markdown string fragment inside Obsidian; used later for replacement. */
	rawMatch: string;
	/** Link or path text. */
	linkpath: string;
	/** alt text (optional). */
	alt: string;
	/** The actual file resolved by Obsidian; may be null if the link is broken. */
	tfile: TFile | null;
	/** Display name used for the Confluence attachment filename. */
	filename: string;
}

/** Result of publishing a single file. */
export interface FilePublishResult {
	path: string;
	skipped: boolean;
	success: boolean;
	error?: string;
	uploadedAttachments?: number;
	skippedAttachments?: number;
	perTarget?: Array<{
			parentUrl?: string;
			pageId: string;
			url: string;
			success: boolean;
			error?: string;
			/**
			 * Multi-instance: true means the target belongs to a different
			 * instance and was not handled by this engine. It does NOT count as a
			 * failure — only this engine's owned targets decide whether to write
			 * its slice of the per-instance lastHash. Foreign slices stay
			 * untouched so the other engine's hash-skip invariant stays correct.
			 */
			foreign?: boolean;
		}>;
}

/** Summary for a single publishAll run. */
export interface BatchPublishResult {
	total: number;
	updated: number;
	skipped: number;
	failed: number;
	files: FilePublishResult[];
}

// ========== Multi-Confluence Support Types ==========

/**
 * Per-instance identity map for `@[[Name]]` mentions. With multiple
 * instances the same person can have different usernames on different
 * Confluence installations (e.g. SSO vs. legacy domain account), so the
 * value is keyed by `ConfluenceInstance.id`.
 */
export type PerInstanceUsernameMap = Record<string, string>;

/** Configuration for a single Confluence instance. */
export interface ConfluenceInstance {
	/** Stable identifier (used for SecretStorage key derivation and UI references). */
	id: string;
	/** Display name. */
	name: string;
	/** Example: https://your-domain.atlassian.net/wiki */
	baseUrl: string;
	/** Auth mode: basic (username + password/token) or bearer (PAT). */
	authType: 'basic' | 'bearer';
	/** Required for basic mode. */
	username: string;
	/** Key name in SecretStorage (the secret value is never stored in plain text). */
	apiToken: string;
	/**
	 * Legacy-confluence-server compatibility: replace emoji and other
	 * supplementary characters with [U+XXXX] placeholders so pages publish
	 * successfully when the server's MySQL still uses 3-byte utf8 (issue #5).
	 * Default off; emoji publish natively on Cloud and utf8mb4 servers. Per-instance
	 * because users may maintain a mix of legacy Server and modern Cloud.
	 */
	stripSupplementaryChars: boolean;
}

/** Publish result for a single instance. */
export interface PerInstancePublishResult {
	instanceName: string;
	instanceId: string;
	total: number;
	updated: number;
	skipped: number;
	failed: number;
	files: FilePublishResult[];
}

/** Aggregate result across all configured instances. */
export interface MultiInstanceBatchResult {
	instances: PerInstancePublishResult[];
	total: number;
	updated: number;
	skipped: number;
	failed: number;
	/** Files that matched no configured instance. */
	unmatched: FilePublishResult[];
}
