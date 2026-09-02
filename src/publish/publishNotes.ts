import { type App, TFile, TFile as TFileCtor } from 'obsidian';
import { ConfluenceApi, ConfluenceApiError } from '../confluence/api';
import { parsePageIdFromUrl } from '../confluence/urlParser';
import {
	computeContentHash,
	extractReferences,
	convert as convertMarkdown,
	ConvertContext,
	ExtractedReferences,
	DiagramBlock,
	ResolvedWikilink,
} from '../confluence/convertMarkdown';
import { publishAttachments, uploadBytes, type AttachmentUploadDeps } from '../confluence/uploadAttachments';
import { renderAllMermaid } from '../confluence/mermaidRenderer';
import { renderAllDrawio } from '../confluence/drawiorender';
import { readBindingFromCache, writeBinding, getLastHashForTarget, TargetBindingPatch } from '../frontmatter/handler';
import { scanBoundNotes } from './noteScanner';
import { Logger } from '../utils/logger';
import { PublishConfluenceSettings } from '../settings';
import { AttachmentRecord, BatchPublishResult, FilePublishResult, NoteBinding, PublishTarget, ConfluenceInstance, PerInstanceUsernameMap } from '../types';
import {
	partitionTargets,
	getRoutingUrl,
	resolveTargetInstance,
	findTargetUrlForInstance,
} from './resolveInstances';
import { collectAncestorIndexPaths, shouldReplaceRemotePageOnConflict } from './structureConflict';
import { t } from '../i18n';

export interface PublishContext {
	app: App;
	settings: PublishConfluenceSettings;
	logger: Logger;
	api: ConfluenceApi;
	/**
	 * The ConfluenceInstance this publish run targets — its credentials and API
	 * are used. Only targets whose URL longest-prefix matches this instance are
	 * published, taking every other configured instance into account
	 * (see `resolveInstances`). Required: after `migrateLegacySettings` the
	 * plugin always has at least one configured instance.
	 */
	instance: ConfluenceInstance;
	/**
	 * Full list of configured instances, required for longest-prefix routing:
	 * if A=`example.com` and B=`example.com/wiki`, a target at
	 * `example.com/wiki/pages/123` belongs to B, not A. Without this list the
	 * run for A would claim the target via its shorter prefix.
	 */
	instances: ConfluenceInstance[];
}

type RenderedDiagram = { block: DiagramBlock; png: ArrayBuffer };

interface TargetPublishSuccess {
	index: number;
	parentUrl?: string;
	pageId: string;
	url: string;
	success: true;
	skipped: boolean;
	uploadedAttachments: number;
	skippedAttachments: number;
	failedAttachments: number;
	attachments?: Record<string, AttachmentRecord>;
}

interface TargetPublishFailureResult {
	index: number;
	parentUrl?: string;
	pageId: string;
	url: string;
	success: false;
	error: string;
}

class TargetPublishFailure extends Error {
	constructor(
		message: string,
		public index: number,
		public target: PublishTarget,
		public pageId: string,
		public url: string,
	) {
		super(message);
		this.name = 'TargetPublishFailure';
	}
}

/**
 * Publish pipeline: scan → orchestrate single-file steps (attachment upload / diagram
 * rendering / markdown conversion / push / write back frontmatter).
 *
 * Reentrancy guard: publishFiles / publishOne share a per-instance lock (busyInstances,
 * keyed by instance id) so a timer-triggered publishAll cannot overlap a manual publish
 * for the same instance.
 */
const busyInstances = new Set<string>();

function makeAttachmentDeps(deps: PublishContext): AttachmentUploadDeps {
	return {
		app: deps.app,
		api: deps.api,
		logger: deps.logger,
		maxSizeBytes: Math.max(1, deps.settings.maxAttachmentSizeMB) * 1024 * 1024,
	};
}

/** Scan the entire vault and publish all bound notes. */
export async function publishAll(deps: PublishContext): Promise<BatchPublishResult | null> {
	const files = scanBoundNotes(deps.app, {
		frontmatterKey: deps.settings.frontmatterKey,
		scanFolders: deps.settings.scanFolders,
		ignorePatterns: deps.settings.ignorePatterns,
	});
	deps.logger.info(`Found ${files.length} bound notes`);
	return publishFiles(deps, files);
}

/** Publish a given set of files (shared by publishAll / publishFolder / future selection publish scenarios). */
export async function publishFiles(deps: PublishContext, files: TFile[]): Promise<BatchPublishResult | null> {
	if (busyInstances.has(deps.instance.id)) {
		deps.logger.warn('A publish task is already running; skipping this one');
		return null;
	}
	const orderedFiles = [...files].sort((a, b) => {
		const depthDelta = a.path.split('/').length - b.path.split('/').length;
		return depthDelta === 0 ? a.path.localeCompare(b.path) : depthDelta;
	});
	busyInstances.add(deps.instance.id);
	try {
		// Pass 1: pre-create placeholder pages for every target in the batch that does not yet have a pageId,
		// so that when Pass 2 converts markdown, `[[wikilink]]` can resolve the peer's confluence_url.
		await ensurePageIdsForBatch(deps, orderedFiles);

		const result: BatchPublishResult = { total: orderedFiles.length, updated: 0, skipped: 0, failed: 0, files: [] };
		for (const file of orderedFiles) {
			const r = await publishFileInternal(deps, file);
			result.files.push(r);
			if (r.skipped) result.skipped += 1;
			else if (r.success) result.updated += 1;
			else result.failed += 1;
		}
		deps.logger.info(
			`Publish complete: updated ${result.updated} / skipped ${result.skipped} / failed ${result.failed}`,
		);
		deps.logger.recordPublishTime();
		return result;
	} finally {
		busyInstances.delete(deps.instance.id);
	}
}

/** Publish a single file. */
export async function publishOne(deps: PublishContext, file: TFile): Promise<FilePublishResult | null> {
	if (busyInstances.has(deps.instance.id)) {
		deps.logger.warn('A publish task is already running; skipping this one');
		return null;
	}
	busyInstances.add(deps.instance.id);
	try {
		const r = await publishFileInternal(deps, file);
		deps.logger.recordPublishTime();
		return r;
	} finally {
		busyInstances.delete(deps.instance.id);
	}
}

async function publishFileInternal(deps: PublishContext, file: TFile): Promise<FilePublishResult> {
	const path = file.path;
	try {
		let binding = readBindingFromCache(deps.app, file, deps.settings.frontmatterKey);
		if (!binding) {
			const inheritedParentId = await resolveFolderParentPageId(deps, file);
			if (!inheritedParentId) {
				deps.logger.info(`No direct frontmatter binding and no ancestor _index parent found for ${path}`);
				return { path, skipped: true, success: false, error: 'Missing confluence_url / confluence_parent_url frontmatter and no ancestor _index.md parent was found' };
			}
			const inheritedTarget = await resolveInheritedTargetInfo(deps, file);
			deps.logger.info(`Leaf note ${path} has no direct binding; inherited parent page ${inheritedParentId} from nearest ancestor _index.md`);
			binding = {
				targets: [{
					url: '',
					parentUrl: inheritedTarget?.parentUrl ?? inheritedTarget?.url ?? '',
					pageId: '',
				}],
				_formats: { url: 'scalar', parentUrl: 'scalar', pageId: 'scalar' },
			};
		} else {
			deps.logger.info(`Leaf note ${path} has direct binding; publishing with explicit Confluence target metadata`);
		}

		const markdown = await deps.app.vault.cachedRead(file);
		const resolveWikilink = makeWikilinkResolver(deps);
		const resolveMention = makeMentionResolver(deps);
		const contentHash = await computeContentHash(deps.app, markdown, path, {
			resolveWikilink,
			resolveMention,
			stripSupplementaryChars: deps.instance.stripSupplementaryChars,
			defaultImageWidthPx: deps.settings.defaultImageWidthPx,
		});
		const refs = await extractReferences(deps.app, markdown, path);
		const mermaidRendered = await renderMermaidOnce(deps, refs);
		const drawioRendered = await renderDrawioOnce(deps, refs);
		const mermaidFilenameByHash = new Map<string, string>();
		for (const r of mermaidRendered) mermaidFilenameByHash.set(r.block.hash, r.block.filename);
		const drawioFilenameByHash = new Map<string, string>();
		const drawioFilenameByPath = new Map<string, string>();
		for (const r of drawioRendered) {
			drawioFilenameByHash.set(r.block.hash, r.block.filename);
			if (r.block.sourcePath) drawioFilenameByPath.set(r.block.sourcePath, r.block.filename);
		}
		const allAttachedFilenames = new Set<string>();
		if (deps.settings.uploadAttachments) {
			for (const ref of refs.attachments) {
				if (ref.tfile) allAttachedFilenames.add(ref.filename);
			}
		}
		for (const r of mermaidRendered) allAttachedFilenames.add(r.block.filename);
		for (const r of drawioRendered) allAttachedFilenames.add(r.block.filename);
		const ctx: ConvertContext = {
			attachedFilenames: allAttachedFilenames,
			mermaidFilenameByHash,
			drawioFilenameByHash,
			drawioFilenameByPath,
			renderMermaidToSvg: deps.settings.renderMermaidToSvg,
			renderDrawioToSvg: deps.settings.renderDrawioToSvg,
			defaultImageWidthPx: deps.settings.defaultImageWidthPx,
			stripSupplementaryChars: deps.instance.stripSupplementaryChars,
			resolveWikilink,
			resolveMention,
		};
		const storageXhtml = await convertMarkdown(deps.app, markdown, path, ctx);

		// Multi-instance: partition index-aligned targets for this engine.
		// Foreign targets do not count as failures; partially unmatched targets
		// are assigned to one matched engine so they cannot disappear silently.
		type PerTargetEntry = NonNullable<FilePublishResult['perTarget']>[number];
		const perTarget: PerTargetEntry[] = binding.targets.map(() => ({
			pageId: '',
			url: '',
			success: false,
		}));
		const partition = partitionTargets(
			deps.instances,
			binding.targets,
			deps.instance.id,
		);
		const filterIndex = partition.ownedIndices;
		for (const index of partition.foreignIndices) {
			const target = binding.targets[index]!;
			perTarget[index] = {
				parentUrl: target.parentUrl,
				pageId: target.pageId,
				url: target.url,
				success: false,
				foreign: true,
			};
		}
		for (const index of partition.ignoredIndices) {
			const target = binding.targets[index]!;
			perTarget[index] = {
				parentUrl: target.parentUrl,
				pageId: target.pageId,
				url: target.url,
				success: false,
				foreign: true,
			};
		}
		for (const index of partition.unmatchedIndices) {
			const target = binding.targets[index]!;
			const routingUrl = getRoutingUrl(target);
			perTarget[index] = {
				parentUrl: target.parentUrl,
				pageId: target.pageId,
				url: target.url,
				success: false,
				error: t('notice.unmatchedUrl', { url: routingUrl }),
			};
		}

		const settled = await Promise.allSettled(filterIndex.map((index) =>
			publishTarget(deps, file, binding, binding.targets[index]!, index, contentHash, refs, mermaidRendered, drawioRendered, storageXhtml),
		));

		const successful: TargetPublishSuccess[] = [];
		settled.forEach((result, index) => {
			const originalIndex = filterIndex[index]!;
			if (result.status === 'fulfilled') {
				successful.push(result.value);
				perTarget[originalIndex] = {
					parentUrl: result.value.parentUrl,
					pageId: result.value.pageId,
					url: result.value.url,
					success: true,
				};
				return;
			}
			const failed = toTargetFailureResult(result.reason, binding.targets[originalIndex]!, originalIndex);
			// toTargetFailureResult returns a plain failure record (no `foreign`
			// flag); assign it back to the matching target index.
			perTarget[originalIndex] = {
				parentUrl: failed.parentUrl,
				pageId: failed.pageId,
				url: failed.url,
				success: false,
				error: failed.error,
			};
		});

		// failures = targets that failed inside THIS engine. Foreign targets
		// are excluded — the foreign engine owns those and decides whether
		// its slice of the per-instance lastHash gets written.
		const failures = perTarget.filter((t) => t.success === false && !t.foreign);
		if (successful.length > 0) {
			const targetUpdates = binding.targets.map(() => ({}));
			const updatedHashEntries: Array<{ pageId: string; hash: string }> = [];
			const updatedAttachmentEntries: Array<{ pageId: string; attachments: Record<string, AttachmentRecord> }> = [];
			for (const target of successful) {
				// Only update targetInfo when something actually changed for
				// this target. Pure hash-match skips leave targetInfo at its
				// existing frontmatter values (no need to re-write).
				if (!target.skipped) {
					targetUpdates[target.index] = {
						parentUrl: target.parentUrl ?? '',
						url: target.url,
						pageId: target.pageId,
					};
					updatedHashEntries.push({ pageId: target.pageId, hash: contentHash });
				}
				if (target.attachments) {
					updatedAttachmentEntries.push({ pageId: target.pageId, attachments: target.attachments });
				}
			}
			const anyUpdated = updatedHashEntries.length > 0;
			const anyAttachmentUpdates = updatedAttachmentEntries.length > 0;
			// Did any non-foreign target touch confluence_url / parent_url /
			// pageId? (freshly created page → new id; user reassigned pageId
			// → different url). Pure skips produce no entry, so this is false
			// when every owned target was a hash-match skip.
			const anyTargetInfoChanged = targetUpdates.some((u) =>
				Object.keys(u).length > 0,
			);
			const needsWriteback = anyUpdated
				|| anyAttachmentUpdates
				|| anyTargetInfoChanged;
			if (!needsWriteback) {
				// All-owned-skipped pure hash-match: no frontmatter write. The
				// existing per-instance hash slice already records the cached
				// value, so future publishes continue to skip correctly.
			} else {
				const patch: Parameters<typeof writeBinding>[2] = { targetUpdates };
				patch._formats = binding._formats;
				const instanceId = deps.instance.id;
				if (anyUpdated) {
					if (failures.length === 0) patch.lastPublished = new Date().toISOString();
					const myHash: Record<string, string> = {};
					for (const e of updatedHashEntries) myHash[e.pageId] = e.hash;
					patch.lastHashDelta = { [instanceId]: myHash };
				}
				if (anyAttachmentUpdates) {
					const myAttachments: Record<string, Record<string, AttachmentRecord>> = {};
					for (const e of updatedAttachmentEntries) myAttachments[e.pageId] = e.attachments;
					patch.attachmentsDelta = { [instanceId]: myAttachments };
				}
				await writeBinding(deps.app, file, patch, deps.settings.frontmatterKey);
			}
		}

		const uploadedAttachments = successful.reduce((sum, target) => sum + target.uploadedAttachments, 0);
		const skippedAttachments = successful.reduce((sum, target) => sum + target.skippedAttachments, 0);
		const failedAttachments = successful.reduce((sum, target) => sum + target.failedAttachments, 0);
		const skipped = failures.length === 0 && successful.every((target) => target.skipped);
		if (failures.length === 0) {
			deps.logger.info(`Published: ${path}`, `targets ${successful.length}, attachments uploaded ${uploadedAttachments} / reused ${skippedAttachments} / failed ${failedAttachments}`);
		} else {
			deps.logger.warn(`Some target publishes failed: ${path}`, failures.map((target) => target.error ?? '').join('\n'));
		}
		return {
			path,
			skipped,
			success: failures.length === 0,
			error: failures.length > 0 ? failures.map((target) => target.error ?? '').join('; ') : undefined,
			uploadedAttachments,
			skippedAttachments,
			perTarget,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		deps.logger.error(`Publish failed: ${path}`, msg);
		return { path, skipped: false, success: false, error: msg };
	}
}

/**
 * Build a wikilink / standard markdown link → Confluence URL resolver.
 *
 * Resolution order (return on the first match):
 *   1. getFirstLinkpathDest exact lookup (works for wikilink form `[[note]]`, Obsidian shortest-path)
 *   2. Strip the `.md` suffix and look up again (works for standard links `[t](note.md)`, where Obsidian resolution is less stable when the suffix is present)
 *   3. Resolve by relative path (works for cross-directory paths like `../docs/foo.md`)
 *
 * After a match, select the URL belonging to the current instance from the target frontmatter; if none exists, return null and fall back to plain text.
 */
/**
 * `@[[Name]]` mention resolver (issue #3 Phase 1): reads the target
 * note's `confluence_username` frontmatter, a per-instance map
 * `{ instanceId: username }`. This engine reads only its own
 * `instance.id` slice; other instances' slices belong to their own
 * engines. Missing key → null → convertMarkdown degrades to plain
 * `@Name`.
 *
 * Intentionally does NOT hit the Confluence user API — publish is a
 * scheduled/batch background job, and inline network lookups or
 * interactive pickers would block the whole batch. Maintain
 * `confluence_username` once per person note and it works offline
 * from then on. Cloud mentions remain unsupported (require
 * `ri:account-id`).
 */
function makeMentionResolver(deps: PublishContext): (linkpath: string, sourcePath: string) => string | null {
	const { app } = deps;
	const instanceId = deps.instance.id;
	return (linkpath, sourcePath) => {
		const target = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		if (!target) return null;
		const fm = app.metadataCache.getFileCache(target)?.frontmatter as Record<string, unknown> | undefined;
		const raw = fm?.['confluence_username'];
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
		const map = raw as PerInstanceUsernameMap;
		const value = map[instanceId];
		if (typeof value !== 'string') return null;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	};
}

/**
 * Multi-instance routing inside the engine, relative to THIS engine.
 *
 * Returns true when `target.url` longest-prefix-matches THIS engine and
 * NOT a longer-prefix match in another instance. This is symmetric with
 * `resolveInstance()` at the per-file level: the engine knows
 * all configured instances (deps.instances), and if a particular URL
 * matches another instance with a longer base, we leave that URL alone
 * — the other engine will pick it up.
 *
 * confluence_url is authoritative once present. parentUrl participates
 * only while url is empty and the child page still needs to be created.
 *
 * Without instances[] the engine publishes every target (legacy single-
 * instance mode).
 */
function targetBelongsToInstance(deps: PublishContext, target: PublishTarget, instanceBaseUrl: string): boolean {
	if (!instanceBaseUrl) return true;
	return resolveTargetInstance(deps.instances, target)?.id === deps.instance.id;
}

function makeWikilinkResolver(deps: PublishContext): (linkpath: string, sourcePath: string) => ResolvedWikilink | null {
	const { app, settings } = deps;
	const findTarget = (linkpath: string, sourcePath: string): TFile | null => {
		const direct = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		if (direct) return direct;
		const stripped = linkpath.replace(/\.md$/i, '');
		if (stripped !== linkpath) {
			const t = app.metadataCache.getFirstLinkpathDest(stripped, sourcePath);
			if (t) return t;
		}
		// Relative path resolution (starts with ./ or ../, or contains /)
		if (linkpath.includes('/') || linkpath.startsWith('.')) {
			const sourceDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
			const joined = normalizeVaultPath(sourceDir, linkpath);
			const tryPaths = joined.endsWith('.md') ? [joined] : [joined + '.md', joined];
			for (const p of tryPaths) {
				const af = app.vault.getAbstractFileByPath(p);
				if (af instanceof TFileCtor) return af;
			}
		}
		return null;
	};
	return (linkpath, sourcePath) => {
		const target = findTarget(linkpath, sourcePath);
		if (!target) return null;
		const binding = readBindingFromCache(app, target, settings.frontmatterKey);
		if (!binding) return null;
		const url = findTargetUrlForInstance(
			deps.instances,
			binding.targets,
			deps.instance.id,
		);
		return url && url.length > 0 ? { url, title: target.basename } : null;
	};
}

/**
 * Batch pre-publish step: for each target that does not yet have a pageId, create a placeholder page in advance,
 * and write back confluence_url / confluence_page_id to frontmatter,
 * so the wikilink resolver can find the peer URL during the actual publish.
 *
 * Only creates placeholders; it does not update content (the placeholder "(publishing…)" is overwritten in the subsequent Pass 2).
 */
async function ensurePageIdsForBatch(deps: PublishContext, files: TFile[]): Promise<void> {
	const { app, api, settings, logger } = deps;
	const instanceBaseUrl = deps.instance.baseUrl;
	for (const file of files) {
		let binding = readBindingFromCache(app, file, settings.frontmatterKey);
		if (!binding) {
			const inheritedParentId = await resolveFolderParentPageId(deps, file);
			if (!inheritedParentId) continue;
			logger.info(`Batch pre-create: ${file.path} has no direct binding; using inherited parent ${inheritedParentId} from ancestor _index.md`);
			binding = {
				targets: [{ url: '', parentUrl: undefined, pageId: '' }],
				_formats: { url: 'scalar', parentUrl: 'scalar', pageId: 'scalar' },
			};
		} else {
			logger.info(`Batch pre-create: ${file.path} has direct binding; using explicit target metadata`);
		}

		const targetUpdates: TargetBindingPatch[] = [];
		let changed = false;
		for (const target of binding.targets) {
			// Multi-instance: this engine only owns targets whose URL prefix
			// matches its instanceBaseUrl. Foreign targets are left alone —
			// the matching engine will handle them.
			if (instanceBaseUrl && !targetBelongsToInstance(deps, target, instanceBaseUrl)) {
				targetUpdates.push({});
				continue;
			}
			let pageId = target.pageId || (target.url ? parsePageIdFromUrl(target.url) ?? '' : '');
			if (pageId === '0') pageId = '';
			if (pageId) {
				try {
					await api.getPage(pageId);
					targetUpdates.push({});
					continue;
				} catch (e) {
					if (!(e instanceof ConfluenceApiError) || e.code !== 'not_found') {
						targetUpdates.push({});
						continue;
					}
					logger.warn(`Confluence page ${pageId} for ${file.path} was not found; clearing stale binding so it can be recreated from the vault.`);
					target.pageId = '';
					target.url = '';
					pageId = '';
				}
			}
			const ensuredFolderParentId = await ensureImmediateFolderIndexPage(deps, file);
			if (ensuredFolderParentId) {
				deps.logger.info(`Ensured immediate folder index page for ${file.path}: ${ensuredFolderParentId}`);
			}
			const parentInfo = await resolveEffectiveParentInfo(deps, file, target);
			const resolvedParentId = parentInfo.parentId ?? '';
			deps.logger.info(`Resolved Confluence parent for ${file.path}: source=${parentInfo.source}, parentId=${resolvedParentId || '(none)'}`);
			if (!resolvedParentId) {
				targetUpdates.push({});
				continue;
			}
			try {
				const parent = await api.getPage(resolvedParentId);
				if (!parent.spaceKey) {
					targetUpdates.push({});
					continue;
				}
				const pageTitle = getConfluencePageTitle(file);
				logger.info(`Pre-creating child page: ${pageTitle} (parent=${resolvedParentId}, source=${parentInfo.source}, space=${parent.spaceKey})`);
				const created = await api.createPage({
					spaceKey: parent.spaceKey,
					parentId: resolvedParentId,
					title: pageTitle,
					storageXhtml: '<p>(publishing…)</p>',
				});
				targetUpdates.push({
					parentUrl: target.parentUrl || undefined,
					pageId: created.id,
					url: created.webUrl,
				});
				if (file.basename === '_index') {
					const fileParent = file.path.includes('/')
						? file.path.split('/').slice(0, -1).join('/')
						: '';
					const parentPath = fileParent && fileParent.includes('/')
						? fileParent.slice(0, fileParent.lastIndexOf('/'))
						: '';
					deps.logger.info(`Index page ${file.path} created at Confluence page ${created.id}; parent folder path=${fileParent || '(root)'}, ancestor parent path=${parentPath || '(root)'}`);
				}
				changed = true;
			} catch (e) {
				// Failure to pre-create a single target does not block the batch; the real Pass will try again and attach the error to that target.
				logger.warn(`Pre-creating child page failed: ${file.path}`, e instanceof Error ? e.message : String(e));
				targetUpdates.push({});
			}
		}
		if (changed) {
			await writeBinding(app, file, { targetUpdates, _formats: binding._formats }, settings.frontmatterKey);
		}
	}
}

function resolveFrontmatterPageId(fm: Record<string, unknown> | undefined): string | null {
	const candidates = [
		typeof fm?.confluence_page_id === 'string' ? fm.confluence_page_id.trim() : '',
		typeof fm?.confluence_url === 'string' ? parsePageIdFromUrl(fm.confluence_url) ?? '' : '',
		typeof fm?.confluence_parent_url === 'string' ? parsePageIdFromUrl(fm.confluence_parent_url) ?? '' : '',
	];
	const pageId = candidates.find((candidate) => candidate && candidate !== '0');
	return pageId ?? null;
}

async function resolveEffectiveParentInfo(deps: PublishContext, file: TFile, target: PublishTarget): Promise<{ parentId: string | null; source: 'folder' | 'target' | 'none' }> {
	const parentFromFolder = await resolveFolderParentPageId(deps, file);
	if (parentFromFolder) {
		return { parentId: parentFromFolder, source: 'folder' };
	}
	const parentFromTarget = target.parentUrl ? parsePageIdFromUrl(target.parentUrl) ?? null : null;
	if (parentFromTarget) {
		return { parentId: parentFromTarget, source: 'target' };
	}
	return { parentId: null, source: 'none' };
}

function getConfluencePageTitle(file: TFile): string {
	if (file.basename !== '_index') return file.basename;
	const folderPath = file.path.includes('/')
		? file.path.split('/').slice(0, -1).join('/')
		: '';
	const folderName = folderPath.includes('/')
		? folderPath.split('/').at(-1)
		: folderPath;
	return folderName && folderName.trim().length > 0 ? folderName : file.basename;
}

async function resolveInheritedTargetInfo(deps: PublishContext, file: TFile): Promise<{ url: string; parentUrl?: string } | null> {
	let current = file.path.includes('/')
		? file.path.split('/').slice(0, -1).join('/')
		: '';
	if (file.basename === '_index') {
		current = current.includes('/')
			? current.slice(0, current.lastIndexOf('/'))
			: '';
	}
	while (current.length > 0) {
		const indexPath = `${current}/_index.md`;
		const indexFile = deps.app.vault.getAbstractFileByPath(indexPath);
		if (indexFile && indexFile instanceof TFile) {
			const fm = deps.app.metadataCache.getFileCache(indexFile)?.frontmatter as Record<string, unknown> | undefined;
			if (!fm) {
				current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
				continue;
			}
			const url = typeof fm.confluence_url === 'string' ? fm.confluence_url.trim() : '';
			const parentUrl = typeof fm.confluence_parent_url === 'string' ? fm.confluence_parent_url.trim() : '';
			const effectiveParent = parentUrl || url;
			if (effectiveParent) return { url: '', parentUrl: effectiveParent };
		}
		current = current.includes('/')
			? current.slice(0, current.lastIndexOf('/'))
			: '';
	}
	return null;
}

async function ensureImmediateFolderIndexPage(deps: PublishContext, file: TFile): Promise<string | null> {
	const folderPath = file.path.includes('/')
		? file.path.split('/').slice(0, -1).join('/')
		: '';
	if (!folderPath) return null;

	const indexPath = `${folderPath}/_index.md`;
	const indexFile = deps.app.vault.getAbstractFileByPath(indexPath);
	if (!(indexFile instanceof TFile)) return null;

	const fm = deps.app.metadataCache.getFileCache(indexFile)?.frontmatter as Record<string, unknown> | undefined;
	const pageId = resolveFrontmatterPageId(fm);
	if (pageId) return pageId;

	const parentId = await resolveFolderParentPageId(deps, indexFile);
	if (!parentId) return null;

	const parent = await deps.api.getPage(parentId);
	if (!parent.spaceKey) return null;

	const created = await deps.api.createPage({
		spaceKey: parent.spaceKey,
		parentId,
		title: getConfluencePageTitle(indexFile),
		storageXhtml: '<p>(publishing…)</p>',
	});

	await writeBinding(deps.app, indexFile, {
		targetUpdates: [{
			parentUrl: '',
			pageId: created.id,
			url: created.webUrl,
		}],
		_formats: { url: 'scalar', parentUrl: 'scalar', pageId: 'scalar' },
	}, deps.settings.frontmatterKey);

	return created.id;
}

async function resolveFolderParentPageId(deps: PublishContext, file: TFile): Promise<string | null> {
	const filePath = file.path.replace(/\\/g, '/');
	for (const indexPath of collectAncestorIndexPaths(filePath)) {
		const indexFile = deps.app.vault.getAbstractFileByPath(indexPath);
		if (!(indexFile instanceof TFile)) continue;
		const fm = deps.app.metadataCache.getFileCache(indexFile)?.frontmatter as Record<string, unknown> | undefined;
		const pageId = resolveFrontmatterPageId(fm);
		if (pageId) return pageId;
	}
	return null;
}

function findExplicitSacredRootFile(deps: PublishContext): TFile | null {
	let sacredRoot: TFile | null = null;
	for (const candidate of deps.app.vault.getMarkdownFiles()) {
		const fm = deps.app.metadataCache.getFileCache(candidate)?.frontmatter as Record<string, unknown> | undefined;
		if (fm && fm.confluence_root === true) {
			if (sacredRoot) {
				deps.logger.warn(
					`Multiple sacred root files found: ${sacredRoot.path} and ${candidate.path}. Using ${sacredRoot.path} and ignoring the rest.`,
				);
				continue;
			}
			sacredRoot = candidate;
		}
	}
	return sacredRoot;
}

async function isSacredRootPage(deps: PublishContext, file: TFile, pageId: string): Promise<boolean> {
	if (!pageId) return false;
	const rootFile = findExplicitSacredRootFile(deps);
	if (!rootFile || rootFile.path !== file.path) return false;
	const rootFm = deps.app.metadataCache.getFileCache(rootFile)?.frontmatter as Record<string, unknown> | undefined;
	if (!rootFm || rootFm.confluence_root !== true) return false;
	const rootPageId = resolveFrontmatterPageId(rootFm);
	return rootPageId === pageId;
}

async function renderMermaidOnce(deps: PublishContext, refs: ExtractedReferences): Promise<RenderedDiagram[]> {
	if (!this.mermaidEnabled || refs.mermaid.length === 0) return [];
	const rendered = await renderAllMermaid(refs.mermaid, deps.app, deps.logger);
	return rendered.filter((r): r is RenderedDiagram => r !== null);
}

async function renderDrawioOnce(deps: PublishContext, refs: ExtractedReferences): Promise<RenderedDiagram[]> {
	if (!this.drawioEnabled || refs.drawio.length === 0) return [];
	const rendered = await renderAllDrawio(refs.drawio, deps.logger);
	return rendered.flatMap((r) => r ? [{ block: r.block, png: r.svg }] : []);
}

async function publishTarget(
	deps: PublishContext,
	file: TFile,
	binding: NoteBinding,
	target: PublishTarget,
	index: number,
	contentHash: string,
	refs: ExtractedReferences,
	mermaidRendered: RenderedDiagram[],
	drawioRendered: RenderedDiagram[],
	storageXhtml: string,
): Promise<TargetPublishSuccess> {
	let pageId = target.pageId || (target.url ? parsePageIdFromUrl(target.url) ?? '' : '');
	if (pageId === '0') pageId = '';
	let url = target.url;
	let createdNewPage = false;
	try {
		if (!pageId) {
			await ensureImmediateFolderIndexPage(deps, file);
			const parentInfo = await resolveEffectiveParentInfo(deps, file, target);
			const parentId = parentInfo.parentId;
			if (!parentId) {
				throw new Error(
					`No parent page found for ${file.path}. Add confluence_parent_url or create a parent _index.md in the folder hierarchy.`,
				);
			}
			deps.logger.info(`Resolved parent for ${file.path}: ${parentInfo.source} (${parentId})`);
			const parent = await deps.api.getPage(parentId);
			if (!parent.spaceKey) {
				throw new Error(`Parent page is missing spaceKey: ${parentId}`);
			}
			const title = getConfluencePageTitle(file);
			deps.logger.info(`Creating child page: ${title} (parent=${parentId}, space=${parent.spaceKey})`);
			const created = await deps.api.createPage({
				spaceKey: parent.spaceKey,
				parentId,
				title,
				storageXhtml: '<p>(publishing…)</p>',
			});
			pageId = created.id;
			url = created.webUrl;
			createdNewPage = true;
			deps.logger.info(`Created child page ${created.id}: ${created.webUrl}`);
		}

		if (pageId) {
			let currentPage: Awaited<ReturnType<typeof deps.api.getPage>> | null = null;
			try {
				currentPage = await deps.api.getPage(pageId);
			} catch (e) {
				if (!(e instanceof ConfluenceApiError) || e.code !== 'not_found') {
					throw e;
				}
				deps.logger.warn(`Confluence page ${pageId} for ${file.path} is missing; clearing stale page binding and recreating it from the vault.`);
				pageId = '';
				url = '';
				target.pageId = '';
				target.url = '';
			}
			if (currentPage) {
				const expectedParentId = (await resolveEffectiveParentInfo(deps, file, target)).parentId;
				const expectedTitle = getConfluencePageTitle(file);
				const rootFile = findExplicitSacredRootFile(deps);
				if (!rootFile) {
					deps.logger.warn(
						`No Confluence sacred root configured: no markdown file has confluence_root: true. Skipping destructive replace for ${file.path}.`,
					);
				} else {
					const sacredRootPage = await isSacredRootPage(deps, file, pageId);
					if (sacredRootPage) {
						deps.logger.warn(`Protecting sacred root Confluence page ${pageId} for ${file.path}; it will not be deleted or replaced.`);
					}
					if (shouldReplaceRemotePageOnConflict({
						currentParentId: currentPage.parentId,
						expectedParentId,
						currentTitle: currentPage.title,
						expectedTitle,
						sacredRootPage,
						defaultBehavior: true,
					})) {
						deps.logger.warn(
							`Remote page ${pageId} conflicts with vault structure; deleting and recreating from vault: current parent=${currentPage.parentId ?? '(none)'}, expected parent=${expectedParentId ?? '(none)'}, current title=${currentPage.title}, expected title=${expectedTitle}`,
						);
						await deps.api.deletePageTree(pageId);
						const parentInfo = await resolveEffectiveParentInfo(deps, file, target);
						const parentId = parentInfo.parentId;
						if (!parentId) {
							throw new Error(
								`No parent page found for ${file.path}. Add confluence_parent_url or create a parent _index.md in the folder hierarchy.`,
							);
						}
						const parent = await deps.api.getPage(parentId);
						if (!parent.spaceKey) {
							throw new Error(`Parent page is missing spaceKey: ${parentId}`);
						}
						const created = await deps.api.createPage({
							spaceKey: parent.spaceKey,
							parentId,
							title: expectedTitle,
							storageXhtml: '<p>(publishing…)</p>',
						});
						pageId = created.id;
						url = created.webUrl;
						createdNewPage = true;
						deps.logger.info(`Recreated child page ${created.id}: ${created.webUrl}`);
					}
				}
			}
		}

		if (!createdNewPage
			&& getLastHashForTarget(binding, deps.instance.id, pageId) === contentHash
			&& target.pageId === pageId
			&& target.url.trim().length > 0) {
			return {
				index,
				parentUrl: target.parentUrl,
				pageId,
				url,
				success: true,
				skipped: true,
				uploadedAttachments: 0,
				skippedAttachments: 0,
				failedAttachments: 0,
			};
		}

		const instanceId = deps.instance.id;
		// Attachment IDs are scoped per-Confluence-installation, so the
		// same filename uploaded to two instances gets two independent
		// attachment records. Reading back by [instanceId][pageId] is
		// intentional — a cross-instance lookup would return foreign
		// attachment IDs that aren't valid on this instance.
		const previousAttachments = binding.attachments?.[instanceId]?.[pageId] ?? {};
		const attachmentDeps = makeAttachmentDeps(deps);
		const attachmentResult = deps.settings.uploadAttachments
			? await publishAttachments(attachmentDeps, pageId, refs.attachments, previousAttachments)
			: { map: {} as Record<string, AttachmentRecord>, uploaded: 0, skipped: 0, failed: 0 };

		const mermaidRecords: Record<string, AttachmentRecord> = {};
		for (const r of mermaidRendered) {
			const rec = await uploadBytes(attachmentDeps, pageId, r.block.filename, r.png, previousAttachments);
			if (rec) mermaidRecords[r.block.filename] = rec;
		}

		const drawioRecords: Record<string, AttachmentRecord> = {};
		for (const r of drawioRendered) {
			const rec = await uploadBytes(attachmentDeps, pageId, r.block.filename, r.png, previousAttachments);
			if (rec) drawioRecords[r.block.filename] = rec;
		}

		const page = await deps.api.getPage(pageId);
		await updatePageWithRetry(deps, pageId, getConfluencePageTitle(file), storageXhtml, page.version, file.path);

		const mergedAttachments: Record<string, AttachmentRecord> = {
			...previousAttachments,
			...attachmentResult.map,
			...mermaidRecords,
			...drawioRecords,
		};
		const stillReferenced = new Set<string>([
			...Object.keys(attachmentResult.map),
			...Object.keys(mermaidRecords),
			...Object.keys(drawioRecords),
		]);
		for (const k of Object.keys(mergedAttachments)) {
			if (!stillReferenced.has(k)) delete mergedAttachments[k];
		}

		return {
			index,
			parentUrl: target.parentUrl,
			pageId,
			url,
			success: true,
			skipped: false,
			uploadedAttachments: attachmentResult.uploaded,
			skippedAttachments: attachmentResult.skipped,
			failedAttachments: attachmentResult.failed,
			attachments: mergedAttachments,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new TargetPublishFailure(msg, index, target, pageId, url);
	}
}

async function retryWithFreshPageVersion<T>(
	deps: PublishContext,
	pageId: string,
	action: (pageVersion: number) => Promise<T>,
	label: string,
): Promise<T> {
	let page = await deps.api.getPage(pageId);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await action(page.version);
		} catch (e) {
			if (!(e instanceof ConfluenceApiError) || e.code !== 'version_conflict') {
				throw e;
			}
			deps.logger.warn(`${label} hit a version conflict; refreshing the page version and retrying: ${pageId}`);
			page = await deps.api.getPage(pageId);
		}
	}
	return await action(page.version);
}

async function updatePageWithRetry(
	deps: PublishContext,
	pageId: string,
	title: string,
	storageXhtml: string,
	currentVersion: number,
	path: string,
): Promise<void> {
	await retryWithFreshPageVersion(
		deps,
		pageId,
		async (pageVersion) => {
			await deps.api.updatePage(pageId, {
				title,
				storageXhtml,
				newVersion: pageVersion + 1,
			});
		},
		`Updating page ${path}`,
	);
}

function toTargetFailureResult(reason: unknown, target: PublishTarget, index: number): TargetPublishFailureResult {
	if (reason instanceof TargetPublishFailure) {
		return {
			index: reason.index,
			parentUrl: reason.target.parentUrl,
			pageId: reason.pageId,
			url: reason.url,
			success: false,
			error: reason.message,
		};
	}
	return {
		index,
		parentUrl: target.parentUrl,
		pageId: target.pageId,
		url: target.url,
		success: false,
		error: reason instanceof Error ? reason.message : String(reason),
	};
}


/** Combine the base directory (which may be empty) with a relative or absolute linkpath into a normalized vault path, handling ./ and ../. */
function normalizeVaultPath(baseDir: string, linkpath: string): string {
	const parts: string[] = [];
	const push = (segs: string[]) => {
		for (const seg of segs) {
			if (!seg || seg === '.') continue;
			if (seg === '..') {
				if (parts.length > 0) parts.pop();
				continue;
			}
			parts.push(seg);
		}
	};
	push(baseDir.split('/'));
	push(linkpath.split('/'));
	return parts.join('/');
}

// Prevent eslint from complaining that NoteBinding is unused (re-exported for convenience to upper layers)
export type { NoteBinding };
