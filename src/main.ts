import {
	Editor,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	TFile,
	TFolder,
	normalizePath,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	PublishConfluenceSettings,
	PublishConfluenceSettingTab,
} from './settings';
import { ConfluenceApi } from './confluence/api';
import { MarkdownConverter } from './confluence/markdownConverter';
import { PublishEngine } from './publish/publishEngine';
import { scanBoundNotes } from './publish/noteScanner';
import { InstanceResolver } from './publish/instanceResolver';
import { Logger } from './utils/logger';
import { StatusBarManager } from './ui/statusBar';
import { PropertyActionsManager } from './ui/propertyActions';
import { CreateBoundNoteModal } from './ui/createBoundNoteModal';
import { frontmatterHasBinding, insertTemplateFrontmatter, type Frontmatter } from './frontmatter/handler';
import { extractFirstTargetUrl } from './confluence/urlMatch';
import { LEGACY_MIGRATION_VERSION, migrateLegacySettings, migrateLegacyFrontmatter, migrateLegacyUsernames } from './migration';
import {
	PublishStatus,
	type ConfluenceInstance,
	type MultiInstanceBatchResult,
	type PerInstancePublishResult,
} from './types';
import { t } from './i18n';

const TEMPLATE_FILENAME = 'confluence-note.md';

function buildTemplateContent(): string {
	return `---
confluence_url:
confluence_parent_url:
confluence_page_id:
confluence_last_published:
confluence_last_hash:
---

${t('template.title')}

${t('template.usage')}

${t('template.bodyHeading')}

${t('template.bodyPlaceholder')}
`;
}

export default class PublishConfluencePlugin extends Plugin {
	declare settings: PublishConfluenceSettings;
	logger!: Logger;
	statusBar: StatusBarManager | null = null;
	propertyActions: PropertyActionsManager | null = null;

	private engines: Map<string, PublishEngine> = new Map();
	private publishIntervalToken: number | null = null;
	private startupTimeoutToken: number | null = null;
	/**
	 * Tracks the last plugin version that ran both `migrateLegacySettings`
	 * and `migrateLegacyFrontmatter`. When this mismatches
	 * `LEGACY_MIGRATION_VERSION`, both migrations run once on plugin load
	 * (each is idempotent for already-migrated data); once the marker is
	 * at `LEGACY_MIGRATION_VERSION`, both migrations are bypassed entirely.
	 */
	private legacyMigrationVersion: string | null = null;

	async onload() {
		this.logger = new Logger();
		this.logger.info(t('plugin.loading'));

		await this.loadSettings();

		await this.ensureEngines();

		this.addRibbonIcon('cloud-upload', t('plugin.ribbonTooltip'), async () => {
			await this.publishAll();
		});

		this.addSettingTab(new PublishConfluenceSettingTab(this.app, this));
		this.registerCommands();
		this.registerMenuIntegrations();

		if (this.settings.showStatusBar) {
			this.statusBar = new StatusBarManager(this);
			this.statusBar.create();
		}

		this.propertyActions = new PropertyActionsManager(this);
		this.propertyActions.start();

		this.restartPublishInterval();

		if (this.settings.autoInstallTemplate) {
			await this.installTemplateFile(false);
		}

		if (this.settings.publishOnStartup) {
			this.startupTimeoutToken = window.setTimeout(() => {
				this.startupTimeoutToken = null;
				void this.publishAll();
			}, 5000);
		}

		this.logger.info(t('plugin.loaded'));
	}

	onunload() {
		this.stopPublishInterval();
		if (this.startupTimeoutToken !== null) {
			window.clearTimeout(this.startupTimeoutToken);
			this.startupTimeoutToken = null;
		}
		this.propertyActions?.destroy();
		this.propertyActions = null;
		this.statusBar?.destroy();
		this.logger?.info(t('plugin.unloaded'));
	}

	async loadSettings() {
		const data = (await this.loadData()) as (Partial<PublishConfluenceSettings> & {
			legacyMigrationVersion?: string;
			/** Pre-rename field names (plugin used to call this "sync"); read as a fallback below. */
			syncInterval?: number;
			syncOnStartup?: boolean;
			/** Pre-refactor field name (kroki/PNG rendering was removed; Mermaid is always rendered to SVG now). */
			renderMermaidToPng?: boolean;
		}) | null;
		const { legacyMigrationVersion, syncInterval, syncOnStartup, renderMermaidToPng, ...rest } = data ?? {};
		if (rest.publishInterval === undefined && syncInterval !== undefined) rest.publishInterval = syncInterval;
		if (rest.publishOnStartup === undefined && syncOnStartup !== undefined) rest.publishOnStartup = syncOnStartup;
		if (rest.renderMermaidToSvg === undefined && renderMermaidToPng !== undefined) rest.renderMermaidToSvg = renderMermaidToPng;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rest);
		this.legacyMigrationVersion = legacyMigrationVersion ?? null;
		if (this.legacyMigrationVersion !== LEGACY_MIGRATION_VERSION) {
			migrateLegacySettings(this.settings, this.logger);
			// `getMarkdownFiles()` returns 0 at plugin onload on large vaults —
			// Obsidian hasn't finished indexing yet. Run inline when the vault
			// is already populated (small vaults), otherwise defer 5s (same
			// window as `publishOnStartup`) so the vault has time to settle.
			const files = this.app.vault.getMarkdownFiles();
			if (files.length > 0) {
				await this.runFrontmatterMigrations();
			} else {
				window.setTimeout(() => { void this.runFrontmatterMigrations(); }, 5000);
			}
		}
	}

	private async runFrontmatterMigrations(): Promise<void> {
		try {
			await migrateLegacyFrontmatter(this.app, this.settings, this.logger);
			await migrateLegacyUsernames(this.app, this.settings, this.logger);
			this.legacyMigrationVersion = LEGACY_MIGRATION_VERSION;
			await this.saveSettings();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.logger?.error('Frontmatter migrations failed', msg);
		}
	}

	async saveSettings() {
		const data: Record<string, unknown> = {
			...this.settings as unknown as Record<string, unknown>,
		};
		if (this.legacyMigrationVersion !== null) {
			data.legacyMigrationVersion = this.legacyMigrationVersion;
		}
		await this.saveData(data);
	}

	/**
	 * Resolve the secret token value for a given instance from SecretStorage.
	 * `instances[i].apiToken` stores the KEY NAME in the vault (selected by the
	 * user via SecretComponent). Legacy migration preserves the existing key
	 * name so the current SecretStorage entry remains valid.
	 */
	async getApiTokenValueForInstance(instanceId: string): Promise<string | null> {
		const inst = this.settings.instances.find((i) => i.id === instanceId);
		if (!inst) return null;
		if (!inst.apiToken) return null;
		return this.getSecretValue(inst.apiToken);
	}

	private async getSecretValue(key: string): Promise<string | null> {
		if (!key) return null;
		const storage = (this.app as unknown as { secretStorage?: { getSecret?(key: string): unknown } }).secretStorage;
		if (!storage || typeof storage.getSecret !== 'function') return null;
		try {
			const raw = storage.getSecret(key);
			const value = raw && typeof (raw as { then?: unknown }).then === 'function'
				? await (raw as Promise<unknown>)
				: raw;
			return typeof value === 'string' ? value : null;
		} catch {
			return null;
		}
	}

	private async ensureEngines(): Promise<void> {
		this.engines.clear();
		for (const inst of this.settings.instances) {
			const tokenValue = await this.getApiTokenValueForInstance(inst.id);
			const needsUsername = inst.authType === 'basic';
			console.log('[Publish Confluence] auth debug', {
				instanceId: inst.id,
				baseUrl: inst.baseUrl,
				authType: inst.authType,
				username: inst.username,
				apiTokenKey: inst.apiToken,
				tokenResolved: !!tokenValue,
				tokenLength: tokenValue?.length ?? 0,
				hasBaseUrl: !!inst.baseUrl,
				hasUsername: !!inst.username,
			});
			if (!inst.baseUrl || (needsUsername && !inst.username) || !tokenValue) {
				continue;
			}
			const api = new ConfluenceApi({
				baseUrl: inst.baseUrl,
				authType: inst.authType,
				username: inst.username,
				apiToken: tokenValue,
			});
			const engine = new PublishEngine({
				app: this.app,
				settings: this.settings,
				logger: this.logger,
				api,
				instance: inst,
				instances: this.settings.instances,
			});
			this.engines.set(inst.id, engine);
		}
	}

	/** Called when settings change, such as rebuilding the renderer. */
	async rebuildPublishEngine(): Promise<void> {
		for (const engine of this.engines.values()) {
			engine.rebuildRenderers();
		}
		if (this.engines.size === 0) {
			await this.ensureEngines();
		}
	}

	/** Called when settings change token / baseUrl / username; forcibly rebuild the API and engine. */
	async refreshCredentials(): Promise<void> {
		await this.ensureEngines();
	}

	// =========== Publish entry points ==========

	/**
	 * Run a single instance's bound-note group and return its
	 * `PerInstancePublishResult`. Used by both publishAll and publishFolder — the
	 * two flows differ only in how they build the group list, not in how
	 * each group is processed.
	 */
	private async runInstanceGroup(
		instance: ConfluenceInstance,
		files: TFile[],
	): Promise<PerInstancePublishResult> {
		const engine = this.engines.get(instance.id);
		const baseResult = {
			instanceName: instance.name,
			instanceId: instance.id,
		};
		if (!engine) {
			return {
				...baseResult,
				total: files.length,
				updated: 0,
				skipped: 0,
				failed: files.length,
				files: files.map((f) => ({
					path: f.path,
					skipped: false,
					success: false,
					error: t('notice.fillAuthFirst'),
				})),
			};
		}
		const r = await engine.publishFiles(files);
		if (!r) {
			return {
				...baseResult,
				total: files.length,
				updated: 0,
				skipped: 0,
				failed: files.length,
				files: files.map((f) => ({
					path: f.path,
					skipped: false,
					success: false,
					error: 'Engine busy',
				})),
			};
		}
		return {
			...baseResult,
			total: r.total,
			updated: r.updated,
			skipped: r.skipped,
			failed: r.failed,
			files: r.files,
		};
	}

	async publishAll(): Promise<void> {
		await this.ensureEngines();
		if (this.engines.size === 0) {
			new Notice(t('notice.fillAuthFirst'));
			return;
		}
		const files = scanBoundNotes(this.app, {
			frontmatterKey: this.settings.frontmatterKey,
			scanFolders: this.settings.scanFolders,
			ignorePatterns: this.settings.ignorePatterns,
		});
		if (files.length === 0) {
			this.statusBar?.update(PublishStatus.Idle);
			return;
		}
		this.statusBar?.showPublishing(t('status.publishing'));
		const resolver = new InstanceResolver({ instances: this.settings.instances });
		const { groups, unmatched } = resolver.groupByInstance(files, this.app, this.settings.frontmatterKey);

		const result: MultiInstanceBatchResult = {
			instances: [],
			total: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			unmatched: unmatched.map((f) => ({
				path: f.path,
				skipped: false,
				success: false,
				error: t('notice.unmatchedUrl', { url: this.getFileUrl(f) }),
			})),
		};

		for (const [, group] of groups) {
			const perInst = await this.runInstanceGroup(group.instance, group.files);
			result.instances.push(perInst);
			result.total += perInst.total;
			result.updated += perInst.updated;
			result.skipped += perInst.skipped;
			result.failed += perInst.failed;
		}

		result.total += unmatched.length;
		result.failed += unmatched.length;

		this.showMultiInstanceResult(result);
	}

	async publishCurrentFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) { new Notice(t('notice.noteNotOpen')); return; }
		await this.publishFile(file);
	}

	/** Publish all bound notes under the specified folder (recursive). */
	async publishFolder(folder: TFolder): Promise<void> {
		await this.ensureEngines();
		if (this.engines.size === 0) {
			new Notice(t('notice.fillAuthFirst'));
			return;
		}
		const files = this.collectBoundFilesUnder(folder);
		if (files.length === 0) {
			new Notice(t('notice.folderNoBoundNotes', { folder: folder.name }));
			return;
		}
		this.statusBar?.showPublishing(folder.name + '/');
		this.logger.info(`Publish folder ${folder.path}: ${files.length} bound notes`);
		const resolver = new InstanceResolver({ instances: this.settings.instances });
		const { groups, unmatched } = resolver.groupByInstance(files, this.app, this.settings.frontmatterKey);

		const result: MultiInstanceBatchResult = {
			instances: [],
			total: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			unmatched: unmatched.map((f) => ({
				path: f.path,
				skipped: false,
				success: false,
				error: t('notice.unmatchedUrl', { url: this.getFileUrl(f) }),
			})),
		};

		for (const [, group] of groups) {
			const perInst = await this.runInstanceGroup(group.instance, group.files);
			result.instances.push(perInst);
			result.total += perInst.total;
			result.updated += perInst.updated;
			result.skipped += perInst.skipped;
			result.failed += perInst.failed;
		}

		result.total += unmatched.length;
		result.failed += unmatched.length;
		this.showMultiInstanceResult(result, folder.name + '/');
	}

	async publishFile(file: TFile): Promise<void> {
		if (!this.fileIsBound(file)) {
			new Notice(t('notice.noteNotBound'));
			return;
		}
		await this.ensureEngines();
		if (this.engines.size === 0) {
			new Notice(t('notice.fillAuthFirst'));
			return;
		}
		this.statusBar?.showPublishing(t('status.publishing'));
		const resolver = new InstanceResolver({ instances: this.settings.instances });

		// Multi-target files may span instances — route to every matched engine,
		// not just the first. Each engine independently filters binding.targets
		// to the subset it owns (see PublishEngine.targetBelongsToInstance).
		const { groups } = resolver.groupByInstance([file], this.app, this.settings.frontmatterKey);
		const matchedInstances = new Map<string, ConfluenceInstance>();
		for (const group of groups.values()) {
			matchedInstances.set(group.instance.id, group.instance);
		}
		if (matchedInstances.size === 0) {
			this.statusBar?.update(PublishStatus.Idle);
			new Notice(t('notice.unmatchedUrl', { url: this.getFileUrl(file) }));
			return;
		}

		const result: MultiInstanceBatchResult = {
			instances: [],
			total: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			unmatched: [],
		};
		for (const inst of matchedInstances.values()) {
			const engine = this.engines.get(inst.id);
			if (!engine) {
				result.instances.push({
					instanceName: inst.name,
					instanceId: inst.id,
					total: 1,
					updated: 0,
					skipped: 0,
					failed: 1,
					files: [{
						path: file.path,
						skipped: false,
						success: false,
						error: t('notice.fillAuthFirst'),
					}],
				});
				result.total += 1;
				result.failed += 1;
				continue;
			}
			const r = await engine.publishOne(file);
			if (!r) {
				result.instances.push({
					instanceName: inst.name,
					instanceId: inst.id,
					total: 1,
					updated: 0,
					skipped: 0,
					failed: 1,
					files: [{
						path: file.path,
						skipped: false,
						success: false,
						error: 'Engine busy',
					}],
				});
				result.total += 1;
				result.failed += 1;
				continue;
			}
			const updated = r.success && !r.skipped ? 1 : 0;
			const skipped = r.skipped ? 1 : 0;
			const failed = !r.success ? 1 : 0;
			result.instances.push({
				instanceName: inst.name,
				instanceId: inst.id,
				total: 1,
				updated,
				skipped,
				failed,
				files: [r],
			});
			result.total += 1;
			result.updated += updated;
			result.skipped += skipped;
			result.failed += failed;
		}

		this.showMultiInstanceResult(result);
	}

	private showMultiInstanceResult(result: MultiInstanceBatchResult, title?: string): void {
		const anyFailed = result.failed > 0 || result.unmatched.length > 0;
		// all-failed = nothing was successfully published or skipped. Previously we
		// required `instances.length > 0`, which mis-classified the case where
		// every scanned note landed in `unmatched` (instances empty, but still
		// wholly failed).
		const allFailed = result.updated === 0 && result.skipped === 0 && result.failed > 0;
		const lines = result.instances.map((i) => t('notice.instanceSummary', {
			name: i.instanceName,
			updated: String(i.updated),
			skipped: String(i.skipped),
			failed: String(i.failed),
		}));
		if (result.unmatched.length > 0) {
			lines.push(`Unmatched: ${result.unmatched.length}`);
		}
		const summary = (title ? `${title}\n` : '') + lines.join('\n');
		if (anyFailed) {
			if (allFailed) {
				this.statusBar?.showFailed(summary);
			} else {
				this.statusBar?.showPartial(summary);
			}
			if (this.settings.showNotice) {
				const noticeKey = allFailed ? 'notice.publishFailed' : 'notice.publishPartialFail';
				new Notice(t(noticeKey, { summary }));
			}
		} else {
			this.statusBar?.showSuccess(summary);
			if (this.settings.showNotice) new Notice(t('notice.publishResult', { summary }));
		}
	}

	/**
	 * Read the binding frontmatter for a file (or empty if unbound).
	 */
	private readFileFrontmatter(file: TFile): Frontmatter {
		return (this.app.metadataCache.getFileCache(file)?.frontmatter as Frontmatter | undefined) ?? {};
	}

	/**
	 * First non-empty target URL from a file's binding (used for error
	 * messages). Empty string when the file has no URL.
	 */
	private getFileUrl(file: TFile): string {
		return extractFirstTargetUrl(this.readFileFrontmatter(file), this.settings.frontmatterKey);
	}

	// =========== Scheduling ==========

	restartPublishInterval(): void {
		this.stopPublishInterval();
		if (this.settings.publishInterval > 0) {
			const ms = this.settings.publishInterval * 60 * 1000;
			const id = window.setInterval(() => { void this.publishAll(); }, ms);
			this.registerInterval(id);
			this.publishIntervalToken = id;
			this.logger.info(`Scheduled publish started, interval ${this.settings.publishInterval} min`);
		}
	}

	private stopPublishInterval(): void {
		if (this.publishIntervalToken !== null) {
			window.clearInterval(this.publishIntervalToken);
			this.publishIntervalToken = null;
		}
	}

	// =========== Template ===========

	/** Write confluence-note.md to the template directory. force=true overwrites it. */
	async installTemplateFile(force: boolean): Promise<boolean> {
		try {
			const folder = normalizePath(this.settings.templateFolderPath || 'templates');
			await this.ensureFolder(folder);
			const fullPath = folder + '/' + TEMPLATE_FILENAME;
			const existing = this.app.vault.getAbstractFileByPath(fullPath);
			const content = buildTemplateContent();
			if (existing instanceof TFile) {
				if (!force) return true;
				await this.app.vault.modify(existing, content);
			} else {
				try {
					await this.app.vault.create(fullPath, content);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (/already exists/i.test(msg)) return true;
					throw e;
				}
			}
			this.logger.info(`Template written: ${fullPath}`);
			return true;
		} catch (e) {
			this.logger.error('Failed to write template', e instanceof Error ? e.message : String(e));
			return false;
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		if (!path) return;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		try {
			await this.app.vault.createFolder(path);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/already exists/i.test(msg)) return;
			throw e;
		}
	}

	// =========== UI ===========

	updateStatusBarVisibility(): void {
		if (this.settings.showStatusBar && !this.statusBar) {
			this.statusBar = new StatusBarManager(this);
			this.statusBar.create();
		} else if (!this.settings.showStatusBar && this.statusBar) {
			this.statusBar.destroy();
			this.statusBar = null;
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'publish-all',
			name: t('command.publishAll'),
			callback: () => { void this.publishAll(); },
		});
		this.addCommand({
			id: 'publish-current-file',
			name: t('command.publishCurrent'),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.publishFile(file);
				return true;
			},
		});
		this.addCommand({
			id: 'insert-template',
			name: t('command.insertTemplate'),
			editorCallback: async (_editor: Editor, view: MarkdownView) => {
				if (!view.file) { new Notice(t('notice.noteNotOpen')); return; }
				const ok = await insertTemplateFrontmatter(this.app, view.file, '', this.settings.frontmatterKey);
				new Notice(ok ? t('notice.frontmatterInsertedShort') : t('notice.frontmatterAlreadyExists'));
			},
		});
		this.addCommand({
			id: 'create-bound-note',
			name: t('command.createBoundNote'),
			callback: () => {
				const modal = new CreateBoundNoteModal(
					this.app,
					this.settings.scanFolders[0] ?? '',
					this.settings.instances,
					async (path, url) => {
						await this.ensureFolder(parentOf(path));
						const file = await this.app.vault.create(path, buildTemplateContent());
						await insertTemplateFrontmatter(this.app, file, url, this.settings.frontmatterKey);
						await this.app.workspace.openLinkText(file.path, '', false);
						return file;
					},
				);
				modal.open();
			},
		});
		this.addCommand({
			id: 'export-storage-preview',
			name: t('command.exportStoragePreview'),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.exportStoragePreview(file);
				return true;
			},
		});
		this.addCommand({
			id: 'validate-auth',
			name: t('command.validateAuth'),
			callback: async () => {
				if (this.settings.instances.length === 0) {
					new Notice(t('notice.fillAuthFirst'));
					return;
				}
				const results: string[] = [];
				for (const inst of this.settings.instances) {
					const tokenValue = await this.getApiTokenValueForInstance(inst.id);
					const needsUsername = inst.authType === 'basic';
					if (!inst.baseUrl || (needsUsername && !inst.username) || !tokenValue) {
						results.push(`${inst.name}: ${needsUsername ? t('settings.validate.missingBasic') : t('settings.validate.missingBearer')}`);
						continue;
					}
					const api = new ConfluenceApi({
						baseUrl: inst.baseUrl,
						authType: inst.authType,
						username: inst.username,
						apiToken: tokenValue,
					});
					const authResult = await api.validateAuth();
					if (authResult.ok === true) {
						results.push(`${inst.name}: ${t('notice.authOk', { name: authResult.displayName ?? '' })}`);
					} else {
						const errorText = 'error' in authResult ? authResult.error ?? '' : '';
						results.push(`${inst.name}: ${t('notice.authFail', { error: errorText })}`);
					}
				}
				new Notice(results.join('\n'));
			},
		});
	}

	private registerMenuIntegrations(): void {
		// Editor context menu: bound → publish; unbound → insert frontmatter
		this.registerEvent(this.app.workspace.on('editor-menu', (menu: Menu, _editor: Editor, view: MarkdownView) => {
			const file = view.file;
			if (!file || file.extension !== 'md') return;
			if (this.fileIsBound(file)) {
				menu.addItem((item) => item
					.setTitle(t('menu.publishToConfluence'))
					.setIcon('cloud-upload')
					.onClick(() => { void this.publishFile(file); }));
			} else {
				menu.addItem((item) => item
					.setTitle(t('menu.insertFrontmatter'))
					.setIcon('cloud')
					.onClick(async () => {
							const ok = await insertTemplateFrontmatter(this.app, file, '', this.settings.frontmatterKey);
						new Notice(ok ? t('notice.frontmatterInserted') : t('notice.frontmatterAlreadyExists'));
					}));
			}
		}));

		// File tree context menu: file → same rule; folder → publish all bound notes underneath
		this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, fileOrFolder) => {
			if (fileOrFolder instanceof TFolder) {
				if (!this.folderHasBoundFile(fileOrFolder)) return;
				menu.addItem((item) => item
					.setTitle(t('menu.publishFolder'))
					.setIcon('cloud-upload')
					.onClick(() => { void this.publishFolder(fileOrFolder); }));
				return;
			}
			if (!(fileOrFolder instanceof TFile) || fileOrFolder.extension !== 'md') return;
			const file = fileOrFolder;
			if (this.fileIsBound(file)) {
				menu.addItem((item) => item
					.setTitle(t('menu.publishToConfluence'))
					.setIcon('cloud-upload')
					.onClick(() => { void this.publishFile(file); }));
			} else {
				menu.addItem((item) => item
					.setTitle(t('menu.insertFrontmatter'))
					.setIcon('cloud')
					.onClick(async () => {
							const ok = await insertTemplateFrontmatter(this.app, file, '', this.settings.frontmatterKey);
						new Notice(ok ? t('notice.frontmatterInsertedFileMenu') : t('notice.frontmatterAlreadyExists'));
					}));
			}
		}));
	}

	/**
	 * Run the current note through the full markdown → storage conversion path (but do not actually call Confluence and do not upload attachments/diagrams),
	 * then write the result to a sibling *.preview.xml file to diagnose XHTML parsing errors.
	 */
	async exportStoragePreview(file: TFile): Promise<void> {
		try {
			const converter = new MarkdownConverter(this.app);
			const markdown = await this.app.vault.cachedRead(file);
			const refs = await converter.extractReferences(markdown, file.path);
			// `stripSupplementaryChars` is per-instance. For the preview we pick
			// the instance whose baseUrl matches the note's confluence_url —
			// that's the one that would actually consume the output. Fall back
			// to the first configured instance, then to `false` for users with
			// no instances yet.
			const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Frontmatter;
			const fallbackUrl = extractFirstTargetUrl(fm, this.settings.frontmatterKey);
			const resolver = new InstanceResolver({ instances: this.settings.instances });
			const matchedInst = this.settings.instances.length > 0
				? (resolver.resolve(fallbackUrl) ?? this.settings.instances[0]!)
				: null;
			const xhtml = await converter.convert(markdown, file.path, {
				attachedFilenames: new Set(refs.attachments.map((r) => r.filename)),
				mermaidFilenameByHash: new Map(refs.mermaid.map((b) => [b.hash, b.filename])),
				drawioFilenameByHash: new Map(refs.drawio.map((b) => [b.hash, b.filename])),
				drawioFilenameByPath: new Map(refs.drawio.filter((b) => b.sourcePath).map((b) => [b.sourcePath!, b.filename])),
				renderMermaidToSvg: this.settings.renderMermaidToSvg,
				renderDrawioToSvg: this.settings.renderDrawioToSvg,
				defaultImageWidthPx: this.settings.defaultImageWidthPx,
				stripSupplementaryChars: matchedInst?.stripSupplementaryChars ?? false,
			});
			const lines = xhtml.split('\n').map((l, i) => `${String(i + 1).padStart(5, ' ')}  ${l}`).join('\n');
			const previewPath = file.path.replace(/\.md$/i, '.preview.xml');
			const existing = this.app.vault.getAbstractFileByPath(previewPath);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, lines);
			} else {
				await this.app.vault.create(previewPath, lines);
			}
			new Notice(t('notice.exportPreviewOk', { path: previewPath }));
		} catch (e) {
			new Notice(t('notice.exportPreviewFailed', { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	/** Recursively collect all "bound" markdown files under the folder (including confluence_url or confluence_parent_url). */
	private collectBoundFilesUnder(folder: TFolder): TFile[] {
		const out: TFile[] = [];
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFolder) walk(child);
				else if (child instanceof TFile && child.extension === 'md' && this.fileIsBound(child)) {
					out.push(child);
				}
			}
		};
		walk(folder);
		return out;
	}

	/** Whether the folder contains at least one bound note (used by file-menu to decide whether to show the menu item). */
	private folderHasBoundFile(folder: TFolder): boolean {
		const stack: TFolder[] = [folder];
		while (stack.length > 0) {
			const f = stack.pop()!;
			for (const child of f.children) {
				if (child instanceof TFolder) stack.push(child);
				else if (child instanceof TFile && child.extension === 'md' && this.fileIsBound(child)) {
					return true;
				}
			}
		}
		return false;
	}

	private fileIsBound(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Frontmatter | undefined;
		if (!fm) return false;
		return frontmatterHasBinding(fm, this.settings.frontmatterKey);
	}
}

function parentOf(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx > 0 ? path.slice(0, idx) : '';
}
