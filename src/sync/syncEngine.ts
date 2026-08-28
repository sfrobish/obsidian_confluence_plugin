import { type App, TFile, TFile as TFileCtor } from 'obsidian';
import { ConfluenceApi, ConfluenceApiError } from '../confluence/api';
import { parsePageIdFromUrl } from '../confluence/urlParser';
import {
	MarkdownConverter,
	ConvertContext,
	ExtractedReferences,
	DiagramBlock,
	ResolvedWikilink,
} from '../confluence/markdownConverter';
import { AttachmentUploader } from '../confluence/attachmentUploader';
import { IMermaidRenderer, KrokiMermaidRenderer, ObsidianMermaidRenderer } from '../confluence/mermaidRenderer';
import { PlantUmlRenderer } from '../confluence/plantUmlRenderer';
import { OfflineDrawioRenderer } from '../confluence/drawiorender';
import { readBindingFromCache, writeBinding, getLastHashForTarget, TargetBindingPatch } from '../frontmatter/handler';
import { scanBoundNotes } from './noteScanner';
import { Logger } from '../utils/logger';
import { SyncConfluenceSettings } from '../settings';
import { AttachmentRecord, BatchSyncResult, FileSyncResult, NoteBinding, SyncTarget, ConfluenceInstance, PerInstanceUsernameMap } from '../types';
import { InstanceResolver } from './instanceResolver';
import { t } from '../i18n';

export interface SyncEngineDeps {
	app: App;
	settings: SyncConfluenceSettings;
	logger: Logger;
	api: ConfluenceApi;
	/**
	 * The ConfluenceInstance this engine owns — its credentials and API are
	 * used. The engine only syncs targets whose URL longest-prefix matches
	 * this instance, taking every other configured instance into account
	 * (see `instanceResolver`). Required: after `migrateLegacySettings` the
	 * plugin always has at least one configured instance.
	 */
	instance: ConfluenceInstance;
	/**
	 * Full list of configured instances, required for longest-prefix routing
	 * inside the engine: if A=`example.com` and B=`example.com/wiki`, a target
	 * at `example.com/wiki/pages/123` belongs to B, not A. Without this list
	 * engine A would claim the target via its shorter prefix.
	 */
	instances: ConfluenceInstance[];
}

type RenderedDiagram = { block: DiagramBlock; png: ArrayBuffer };

interface TargetSyncSuccess {
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

interface TargetSyncFailureResult {
	index: number;
	parentUrl?: string;
	pageId: string;
	url: string;
	success: false;
	error: string;
}

class TargetSyncFailure extends Error {
	constructor(
		message: string,
		public index: number,
		public target: SyncTarget,
		public pageId: string,
		public url: string,
	) {
		super(message);
		this.name = 'TargetSyncFailure';
	}
}

/**
 * Sync engine. Responsible for: scan → orchestrate single-file pipeline (attachment upload / diagram rendering / markdown conversion / push / write back frontmatter)
 *
 * Reentrancy guard: isSyncing flag. SyncAll and SyncOne share the same lock to avoid timer and manual-trigger overlap.
 */
export class SyncEngine {
	private converter: MarkdownConverter;
	private uploader: AttachmentUploader;
	private mermaid: IMermaidRenderer | null = null;
	private plantUml: PlantUmlRenderer | null = null;
	private drawio: OfflineDrawioRenderer | null = null;
	private busy = false;
	private instanceResolver: InstanceResolver;

	constructor(private deps: SyncEngineDeps) {
		this.instanceResolver = new InstanceResolver({ instances: deps.instances });
		this.converter = new MarkdownConverter(deps.app);
		this.uploader = new AttachmentUploader(deps.app, deps.api, deps.logger, {
			maxSizeBytes: Math.max(1, deps.settings.maxAttachmentSizeMB) * 1024 * 1024,
		});
		if (deps.settings.renderMermaidToPng) {
			this.mermaid = deps.settings.mermaidRenderer === 'obsidian'
				? new ObsidianMermaidRenderer(deps.app, deps.logger)
				: new KrokiMermaidRenderer(deps.settings.mermaidRenderUrl, deps.logger);
		}
		if (deps.settings.renderPlantUmlToPng) {
			this.plantUml = new PlantUmlRenderer(deps.settings.plantUmlServerUrl, deps.logger);
		}
		if (deps.settings.renderDrawioToSvg) {
			this.drawio = new OfflineDrawioRenderer(deps.logger);
		}
	}

	isBusy(): boolean { return this.busy; }

	/** Scan the entire vault and sync all bound notes. */
	async syncAll(): Promise<BatchSyncResult | null> {
		const files = scanBoundNotes(this.deps.app, {
			frontmatterKey: this.deps.settings.frontmatterKey,
			scanFolders: this.deps.settings.scanFolders,
			ignorePatterns: this.deps.settings.ignorePatterns,
		});
		this.deps.logger.info(`Found ${files.length} bound notes`);
		return this.syncFiles(files);
	}

	/** Sync a given set of files (shared by syncAll / syncFolder / future selection sync scenarios). */
	async syncFiles(files: TFile[]): Promise<BatchSyncResult | null> {
		if (this.busy) {
			this.deps.logger.warn('A sync task is already running; skipping this one');
			return null;
		}
		const orderedFiles = [...files].sort((a, b) => {
			const depthDelta = a.path.split('/').length - b.path.split('/').length;
			return depthDelta === 0 ? a.path.localeCompare(b.path) : depthDelta;
		});
		this.busy = true;
		try {
			// Pass 1: pre-create placeholder pages for every target in the batch that does not yet have a pageId,
			// so that when Pass 2 converts markdown, `[[wikilink]]` can resolve the peer's confluence_url.
			await this.ensurePageIdsForBatch(orderedFiles);

			const result: BatchSyncResult = { total: orderedFiles.length, updated: 0, skipped: 0, failed: 0, files: [] };
			for (const file of orderedFiles) {
				const r = await this.syncFileInternal(file);
				result.files.push(r);
				if (r.skipped) result.skipped += 1;
				else if (r.success) result.updated += 1;
				else result.failed += 1;
			}
			this.deps.logger.info(
				`Sync complete: updated ${result.updated} / skipped ${result.skipped} / failed ${result.failed}`,
			);
			this.deps.logger.recordSyncTime();
			return result;
		} finally {
			this.busy = false;
		}
	}

	/** Sync a single file. */
	async syncOne(file: TFile): Promise<FileSyncResult | null> {
		if (this.busy) {
			this.deps.logger.warn('A sync task is already running; skipping this one');
			return null;
		}
		this.busy = true;
		try {
			const r = await this.syncFileInternal(file);
			this.deps.logger.recordSyncTime();
			return r;
		} finally {
			this.busy = false;
		}
	}

	private async syncFileInternal(file: TFile): Promise<FileSyncResult> {
		const path = file.path;
		try {
			let binding = readBindingFromCache(this.deps.app, file, this.deps.settings.frontmatterKey);
			if (!binding) {
				const inheritedParentId = await this.resolveFolderParentPageId(file);
				if (!inheritedParentId) {
					this.deps.logger.info(`No direct frontmatter binding and no ancestor _index parent found for ${path}`);
					return { path, skipped: true, success: false, error: 'Missing confluence_url / confluence_parent_url frontmatter and no ancestor _index.md parent was found' };
				}
				const inheritedTarget = await this.resolveInheritedTargetInfo(file);
				this.deps.logger.info(`Leaf note ${path} has no direct binding; inherited parent page ${inheritedParentId} from nearest ancestor _index.md`);
				binding = {
					targets: [{
						url: '',
						parentUrl: inheritedTarget?.parentUrl ?? inheritedTarget?.url ?? '',
						pageId: '',
					}],
					_formats: { url: 'scalar', parentUrl: 'scalar', pageId: 'scalar' },
				};
			} else {
				this.deps.logger.info(`Leaf note ${path} has direct binding; syncing with explicit Confluence target metadata`);
			}

			const markdown = await this.deps.app.vault.cachedRead(file);
			const resolveWikilink = this.makeWikilinkResolver();
			const resolveMention = this.makeMentionResolver();
			const contentHash = await this.converter.computeContentHash(markdown, path, {
				resolveWikilink,
				resolveMention,
				stripSupplementaryChars: this.deps.instance.stripSupplementaryChars,
				defaultImageWidthPx: this.deps.settings.defaultImageWidthPx,
			});
			const refs = await this.converter.extractReferences(markdown, path, {
				mermaidExt: this.mermaid?.extension(),
			});
			const mermaidRendered = await this.renderMermaidOnce(refs);
			const plantUmlRendered = await this.renderPlantUmlOnce(refs);
			const drawioRendered = await this.renderDrawioOnce(refs);
			const mermaidFilenameByHash = new Map<string, string>();
			for (const r of mermaidRendered) mermaidFilenameByHash.set(r.block.hash, r.block.filename);
			const plantUmlFilenameByHash = new Map<string, string>();
			for (const r of plantUmlRendered) plantUmlFilenameByHash.set(r.block.hash, r.block.filename);
			const drawioFilenameByHash = new Map<string, string>();
			const drawioFilenameByPath = new Map<string, string>();
			for (const r of drawioRendered) {
				drawioFilenameByHash.set(r.block.hash, r.block.filename);
				if (r.block.sourcePath) drawioFilenameByPath.set(r.block.sourcePath, r.block.filename);
			}
			const allAttachedFilenames = new Set<string>();
			if (this.deps.settings.uploadAttachments) {
				for (const ref of refs.attachments) {
					if (ref.tfile) allAttachedFilenames.add(ref.filename);
				}
			}
			for (const r of mermaidRendered) allAttachedFilenames.add(r.block.filename);
			for (const r of plantUmlRendered) allAttachedFilenames.add(r.block.filename);
			for (const r of drawioRendered) allAttachedFilenames.add(r.block.filename);
			const ctx: ConvertContext = {
				attachedFilenames: allAttachedFilenames,
				mermaidFilenameByHash,
				plantUmlFilenameByHash,
				drawioFilenameByHash,
				drawioFilenameByPath,
				renderMermaidToPng: this.deps.settings.renderMermaidToPng,
				renderPlantUmlToPng: this.deps.settings.renderPlantUmlToPng,
				renderDrawioToSvg: this.deps.settings.renderDrawioToSvg,
				defaultImageWidthPx: this.deps.settings.defaultImageWidthPx,
				stripSupplementaryChars: this.deps.instance.stripSupplementaryChars,
				resolveWikilink,
				resolveMention,
			};
			const storageXhtml = await this.converter.convert(markdown, path, ctx);

			// Multi-instance: partition index-aligned targets for this engine.
			// Foreign targets do not count as failures; partially unmatched targets
			// are assigned to one matched engine so they cannot disappear silently.
			type PerTargetEntry = NonNullable<FileSyncResult['perTarget']>[number];
			const perTarget: PerTargetEntry[] = binding.targets.map(() => ({
				pageId: '',
				url: '',
				success: false,
			}));
			const partition = this.instanceResolver.partitionTargets(
				binding.targets,
				this.deps.instance.id,
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
				const routingUrl = this.instanceResolver.getRoutingUrl(target);
				perTarget[index] = {
					parentUrl: target.parentUrl,
					pageId: target.pageId,
					url: target.url,
					success: false,
					error: t('notice.unmatchedUrl', { url: routingUrl }),
				};
			}

			const settled = await Promise.allSettled(filterIndex.map((index) =>
				this.syncTarget(file, binding, binding.targets[index]!, index, contentHash, refs, mermaidRendered, plantUmlRendered, drawioRendered, storageXhtml),
			));

			const successful: TargetSyncSuccess[] = [];
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
				const failed = this.toTargetFailureResult(result.reason, binding.targets[originalIndex]!, originalIndex);
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
					// value, so future syncs continue to skip correctly.
				} else {
					const patch: Parameters<typeof writeBinding>[2] = { targetUpdates };
					patch._formats = binding._formats;
					const instanceId = this.deps.instance.id;
					if (anyUpdated) {
						if (failures.length === 0) patch.lastSynced = new Date().toISOString();
						const myHash: Record<string, string> = {};
						for (const e of updatedHashEntries) myHash[e.pageId] = e.hash;
						patch.lastHashDelta = { [instanceId]: myHash };
					}
					if (anyAttachmentUpdates) {
						const myAttachments: Record<string, Record<string, AttachmentRecord>> = {};
						for (const e of updatedAttachmentEntries) myAttachments[e.pageId] = e.attachments;
						patch.attachmentsDelta = { [instanceId]: myAttachments };
					}
					await writeBinding(this.deps.app, file, patch, this.deps.settings.frontmatterKey);
				}
			}

			const uploadedAttachments = successful.reduce((sum, target) => sum + target.uploadedAttachments, 0);
			const skippedAttachments = successful.reduce((sum, target) => sum + target.skippedAttachments, 0);
			const failedAttachments = successful.reduce((sum, target) => sum + target.failedAttachments, 0);
			const skipped = failures.length === 0 && successful.every((target) => target.skipped);
			if (failures.length === 0) {
				this.deps.logger.info(`Synced: ${path}`, `targets ${successful.length}, attachments uploaded ${uploadedAttachments} / reused ${skippedAttachments} / failed ${failedAttachments}`);
			} else {
				this.deps.logger.warn(`Some target syncs failed: ${path}`, failures.map((target) => target.error ?? '').join('\n'));
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
			this.deps.logger.error(`Sync failed: ${path}`, msg);
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
	 * engines. Missing key → null → markdownConverter degrades to plain
	 * `@Name`.
	 *
	 * Intentionally does NOT hit the Confluence user API — sync is a
	 * scheduled/batch background job, and inline network lookups or
	 * interactive pickers would block the whole batch. Maintain
	 * `confluence_username` once per person note and it works offline
	 * from then on. Cloud mentions remain unsupported (require
	 * `ri:account-id`).
	 */
	private makeMentionResolver(): (linkpath: string, sourcePath: string) => string | null {
		const { app } = this.deps;
		const instanceId = this.deps.instance.id;
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
	 * `InstanceResolver.resolve()` at the per-file level: the engine knows
	 * all configured instances (deps.instances), and if a particular URL
	 * matches another instance with a longer base, we leave that URL alone
	 * — the other engine will pick it up.
	 *
	 * confluence_url is authoritative once present. parentUrl participates
	 * only while url is empty and the child page still needs to be created.
	 *
	 * Without instances[] the engine syncs every target (legacy single-
	 * instance mode).
	 */
	private targetBelongsToInstance(target: SyncTarget, instanceBaseUrl: string): boolean {
		if (!instanceBaseUrl) return true;
		return this.instanceResolver.resolveTarget(target)?.id === this.deps.instance.id;
	}

	private makeWikilinkResolver(): (linkpath: string, sourcePath: string) => ResolvedWikilink | null {
		const { app, settings } = this.deps;
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
			const url = this.instanceResolver.findTargetUrlForInstance(
				binding.targets,
				this.deps.instance.id,
			);
			return url && url.length > 0 ? { url, title: target.basename } : null;
		};
	}

	/**
	 * Batch pre-sync step: for each target that does not yet have a pageId, create a placeholder page in advance,
	 * and write back confluence_url / confluence_page_id to frontmatter,
	 * so the wikilink resolver can find the peer URL during the actual sync.
	 *
	 * Only creates placeholders; it does not update content (the placeholder "(syncing…)" is overwritten in the subsequent Pass 2).
	 */
	private async ensurePageIdsForBatch(files: TFile[]): Promise<void> {
		const { app, api, settings, logger } = this.deps;
		const instanceBaseUrl = this.deps.instance.baseUrl;
		for (const file of files) {
			let binding = readBindingFromCache(app, file, settings.frontmatterKey);
			if (!binding) {
				const inheritedParentId = await this.resolveFolderParentPageId(file);
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
				if (instanceBaseUrl && !this.targetBelongsToInstance(target, instanceBaseUrl)) {
					targetUpdates.push({});
					continue;
				}
				let pageId = target.pageId || (target.url ? parsePageIdFromUrl(target.url) ?? '' : '');
				if (pageId === '0') pageId = '';
				if (pageId) {
					targetUpdates.push({});
					continue;
				}
				const parentInfo = await this.resolveEffectiveParentInfo(file, target);
				const resolvedParentId = parentInfo.parentId ?? '';
				this.deps.logger.info(`Resolved Confluence parent for ${file.path}: source=${parentInfo.source}, parentId=${resolvedParentId || '(none)'}`);
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
					const pageTitle = this.getConfluencePageTitle(file);
					logger.info(`Pre-creating child page: ${pageTitle} (parent=${resolvedParentId}, source=${parentInfo.source}, space=${parent.spaceKey})`);
					const created = await api.createPage({
						spaceKey: parent.spaceKey,
						parentId: resolvedParentId,
						title: pageTitle,
						storageXhtml: '<p>(syncing…)</p>',
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
						this.deps.logger.info(`Index page ${file.path} created at Confluence page ${created.id}; parent folder path=${fileParent || '(root)'}, ancestor parent path=${parentPath || '(root)'}`);
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

	private resolveFrontmatterPageId(fm: Record<string, unknown> | undefined): string | null {
		const candidates = [
			typeof fm?.confluence_page_id === 'string' ? fm.confluence_page_id.trim() : '',
			typeof fm?.confluence_url === 'string' ? parsePageIdFromUrl(fm.confluence_url) ?? '' : '',
			typeof fm?.confluence_parent_url === 'string' ? parsePageIdFromUrl(fm.confluence_parent_url) ?? '' : '',
		];
		const pageId = candidates.find((candidate) => candidate && candidate !== '0');
		return pageId ?? null;
	}

	private async resolveEffectiveParentInfo(file: TFile, target: SyncTarget): Promise<{ parentId: string | null; source: 'folder' | 'target' | 'none' }> {
		const parentFromFolder = await this.resolveFolderParentPageId(file);
		if (parentFromFolder) {
			return { parentId: parentFromFolder, source: 'folder' };
		}
		const parentFromTarget = target.parentUrl ? parsePageIdFromUrl(target.parentUrl) ?? null : null;
		if (parentFromTarget) {
			return { parentId: parentFromTarget, source: 'target' };
		}
		return { parentId: null, source: 'none' };
	}

	private getConfluencePageTitle(file: TFile): string {
		if (file.basename !== '_index') return file.basename;
		const folderPath = file.path.includes('/')
			? file.path.split('/').slice(0, -1).join('/')
			: '';
		const folderName = folderPath.includes('/')
			? folderPath.split('/').at(-1)
			: folderPath;
		return folderName && folderName.trim().length > 0 ? folderName : file.basename;
	}

	private async resolveInheritedTargetInfo(file: TFile): Promise<{ url: string; parentUrl?: string } | null> {
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
			const indexFile = this.deps.app.vault.getAbstractFileByPath(indexPath);
			if (indexFile && indexFile instanceof TFile) {
				const fm = this.deps.app.metadataCache.getFileCache(indexFile)?.frontmatter as Record<string, unknown> | undefined;
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

	private async resolveFolderParentPageId(file: TFile): Promise<string | null> {
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
			const indexFile = this.deps.app.vault.getAbstractFileByPath(indexPath);
			if (indexFile && indexFile instanceof TFile) {
				const fm = this.deps.app.metadataCache.getFileCache(indexFile)?.frontmatter as Record<string, unknown> | undefined;
				const pageId = this.resolveFrontmatterPageId(fm);
				if (pageId) return pageId;
			}
			current = current.includes('/')
				? current.slice(0, current.lastIndexOf('/'))
				: '';
		}
		return null;
	}

	private async renderMermaidOnce(refs: ExtractedReferences): Promise<RenderedDiagram[]> {
		if (!this.mermaid || refs.mermaid.length === 0) return [];
		const rendered = await this.mermaid.renderAll(refs.mermaid);
		return rendered.filter((r): r is RenderedDiagram => r !== null);
	}

	private async renderPlantUmlOnce(refs: ExtractedReferences): Promise<RenderedDiagram[]> {
		if (!this.plantUml || refs.plantUml.length === 0) return [];
		const rendered = await this.plantUml.renderAll(refs.plantUml);
		return rendered.filter((r): r is RenderedDiagram => r !== null);
	}

	private async renderDrawioOnce(refs: ExtractedReferences): Promise<RenderedDiagram[]> {
		if (!this.drawio || refs.drawio.length === 0) return [];
		const rendered = await this.drawio.renderAll(refs.drawio);
		return rendered.flatMap((r) => r ? [{ block: r.block, png: r.svg }] : []);
	}

	private async syncTarget(
		file: TFile,
		binding: NoteBinding,
		target: SyncTarget,
		index: number,
		contentHash: string,
		refs: ExtractedReferences,
		mermaidRendered: RenderedDiagram[],
		plantUmlRendered: RenderedDiagram[],
		drawioRendered: RenderedDiagram[],
		storageXhtml: string,
	): Promise<TargetSyncSuccess> {
		let pageId = target.pageId || (target.url ? parsePageIdFromUrl(target.url) ?? '' : '');
		if (pageId === '0') pageId = '';
		let url = target.url;
		let createdNewPage = false;
		try {
			if (!pageId) {
				const parentInfo = await this.resolveEffectiveParentInfo(file, target);
				const parentId = parentInfo.parentId;
				if (!parentId) {
					throw new Error(
						`No parent page found for ${file.path}. Add confluence_parent_url or create a parent _index.md in the folder hierarchy.`,
					);
				}
				this.deps.logger.info(`Resolved parent for ${file.path}: ${parentInfo.source} (${parentId})`);
				const parent = await this.deps.api.getPage(parentId);
				if (!parent.spaceKey) {
					throw new Error(`Parent page is missing spaceKey: ${parentId}`);
				}
				const title = this.getConfluencePageTitle(file);
				this.deps.logger.info(`Creating child page: ${title} (parent=${parentId}, space=${parent.spaceKey})`);
				const created = await this.deps.api.createPage({
					spaceKey: parent.spaceKey,
					parentId,
					title,
					storageXhtml: '<p>(syncing…)</p>',
				});
				pageId = created.id;
				url = created.webUrl;
				createdNewPage = true;
				this.deps.logger.info(`Created child page ${created.id}: ${created.webUrl}`);
			}

			if (pageId) {
				const currentPage = await this.deps.api.getPage(pageId);
				const expectedParentId = (await this.resolveEffectiveParentInfo(file, target)).parentId;
				if (expectedParentId && currentPage.parentId && currentPage.parentId !== expectedParentId) {
					this.deps.logger.warn(
						`Reparenting stale Confluence page ${pageId}: current parent=${currentPage.parentId}, expected parent=${expectedParentId}`,
					);
					await this.retryWithFreshPageVersion(
						pageId,
						(version) => this.deps.api.movePage(pageId, expectedParentId, this.getConfluencePageTitle(file), version),
						'Reparenting page',
					);
					url = target.url || `${this.deps.instance.baseUrl}/pages/viewpage.action?pageId=${pageId}`;
				}
			}

			if (!createdNewPage
				&& getLastHashForTarget(binding, this.deps.instance.id, pageId) === contentHash
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

			const instanceId = this.deps.instance.id;
			// Attachment IDs are scoped per-Confluence-installation, so the
			// same filename uploaded to two instances gets two independent
			// attachment records. Reading back by [instanceId][pageId] is
			// intentional — a cross-instance lookup would return foreign
			// attachment IDs that aren't valid on this instance.
			const previousAttachments = binding.attachments?.[instanceId]?.[pageId] ?? {};
			const attachmentResult = this.deps.settings.uploadAttachments
				? await this.uploader.syncAttachments(pageId, refs.attachments, previousAttachments)
				: { map: {} as Record<string, AttachmentRecord>, uploaded: 0, skipped: 0, failed: 0 };

			const mermaidRecords: Record<string, AttachmentRecord> = {};
			for (const r of mermaidRendered) {
				const rec = await this.uploader.uploadBytes(pageId, r.block.filename, r.png, previousAttachments);
				if (rec) mermaidRecords[r.block.filename] = rec;
			}

			const plantUmlRecords: Record<string, AttachmentRecord> = {};
			for (const r of plantUmlRendered) {
				const rec = await this.uploader.uploadBytes(pageId, r.block.filename, r.png, previousAttachments);
				if (rec) plantUmlRecords[r.block.filename] = rec;
			}

			const drawioRecords: Record<string, AttachmentRecord> = {};
			for (const r of drawioRendered) {
				const rec = await this.uploader.uploadBytes(pageId, r.block.filename, r.png, previousAttachments);
				if (rec) drawioRecords[r.block.filename] = rec;
			}

			const page = await this.deps.api.getPage(pageId);
			await this.updatePageWithRetry(pageId, this.getConfluencePageTitle(file), storageXhtml, page.version, file.path);

			const mergedAttachments: Record<string, AttachmentRecord> = {
				...previousAttachments,
				...attachmentResult.map,
				...mermaidRecords,
				...plantUmlRecords,
				...drawioRecords,
			};
			const stillReferenced = new Set<string>([
				...Object.keys(attachmentResult.map),
				...Object.keys(mermaidRecords),
				...Object.keys(plantUmlRecords),
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
			throw new TargetSyncFailure(msg, index, target, pageId, url);
		}
	}

	private async retryWithFreshPageVersion<T>(
		pageId: string,
		action: (pageVersion: number) => Promise<T>,
		label: string,
	): Promise<T> {
		let page = await this.deps.api.getPage(pageId);
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				return await action(page.version);
			} catch (e) {
				if (!(e instanceof ConfluenceApiError) || e.code !== 'version_conflict') {
					throw e;
				}
				this.deps.logger.warn(`${label} hit a version conflict; refreshing the page version and retrying: ${pageId}`);
				page = await this.deps.api.getPage(pageId);
			}
		}
		return await action(page.version);
	}

	private async updatePageWithRetry(
		pageId: string,
		title: string,
		storageXhtml: string,
		currentVersion: number,
		path: string,
	): Promise<void> {
		await this.retryWithFreshPageVersion(
			pageId,
			async (pageVersion) => {
				await this.deps.api.updatePage(pageId, {
					title,
					storageXhtml,
					newVersion: pageVersion + 1,
				});
			},
			`Updating page ${path}`,
		);
	}

	private toTargetFailureResult(reason: unknown, target: SyncTarget, index: number): TargetSyncFailureResult {
		if (reason instanceof TargetSyncFailure) {
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

	/** Called after re-reading settings to rebuild the renderer instances. */
	rebuildRenderers(): void {
		if (this.deps.settings.renderMermaidToPng) {
			this.mermaid = this.deps.settings.mermaidRenderer === 'obsidian'
				? new ObsidianMermaidRenderer(this.deps.app, this.deps.logger)
				: new KrokiMermaidRenderer(this.deps.settings.mermaidRenderUrl, this.deps.logger);
		} else {
			this.mermaid = null;
		}
		this.plantUml = this.deps.settings.renderPlantUmlToPng
			? new PlantUmlRenderer(this.deps.settings.plantUmlServerUrl, this.deps.logger)
			: null;
		this.uploader = new AttachmentUploader(this.deps.app, this.deps.api, this.deps.logger, {
			maxSizeBytes: Math.max(1, this.deps.settings.maxAttachmentSizeMB) * 1024 * 1024,
		});
	}
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
