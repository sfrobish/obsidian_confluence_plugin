import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import * as obsidianModule from 'obsidian';
import type PublishConfluencePlugin from './main';
import { ConfluenceApi, ConfluenceAuthType } from './confluence/api';
import { t } from './i18n';
import { ConfluenceInstance } from './types';

export interface PublishConfluenceSettings {
	// ========== Multi-instance configuration ==========
	instances: ConfluenceInstance[];

	// ========== Scheduling ==========
	/** Minutes; 0 disables scheduled publish */
	publishInterval: number;
	publishOnStartup: boolean;

	// ========== Scan scope ==========
	/** Only scan these directories (relative to vault root); empty array = the full vault */
	scanFolders: string[];
	/** List of glob patterns; matching files are skipped */
	ignorePatterns: string[];

	// ========== Templates ==========
	templateFolderPath: string;
	autoInstallTemplate: boolean;

	// ========== Behavior ==========
	showStatusBar: boolean;
	showNotice: boolean;
	frontmatterKey: string;

	// ========== Attachments ==========
	uploadAttachments: boolean;
	maxAttachmentSizeMB: number;
	/** Default display width for ordinary images on the Confluence page (px); 0 = original size */
	defaultImageWidthPx: number;

	// ========== Diagram rendering ==========
	renderMermaidToPng: boolean;
	/** kroki = use an external HTTP service to render PNG; obsidian = use Obsidian's built-in mermaid engine to render SVG */
	mermaidRenderer: 'kroki' | 'obsidian';
	mermaidRenderUrl: string;
	renderDrawioToSvg: boolean;
}

export const DEFAULT_SETTINGS: PublishConfluenceSettings = {
	instances: [],

	publishInterval: 30,
	publishOnStartup: false,

	scanFolders: [],
	// Note: the Obsidian config directory (default .obsidian, user-customizable) is implicitly ignored by scanBoundNotes,
	// so we only list the common extra ignore items users typically need.
	ignorePatterns: ['.trash/**', 'templates/**'],

	templateFolderPath: 'templates',
	autoInstallTemplate: true,

	showStatusBar: true,
	showNotice: true,
	frontmatterKey: 'confluence_url',

	uploadAttachments: true,
	maxAttachmentSizeMB: 10,
	defaultImageWidthPx: 192,

	renderMermaidToPng: true,
	mermaidRenderer: 'kroki',
	mermaidRenderUrl: 'https://kroki.io/mermaid/png',
	renderDrawioToSvg: true,
};

export class PublishConfluenceSettingTab extends PluginSettingTab {
	plugin: PublishConfluencePlugin;
	private authResultEls: Map<string, HTMLElement> = new Map();

	constructor(app: App, plugin: PublishConfluencePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();
		this.authResultEls.clear();

		// ===== Auth / multi-instance =====
		this.renderSection(containerEl, t('settings.section.auth'), (el) => {
			// Ensure at least one instance
			if (!s.instances || s.instances.length === 0) {
				s.instances = [this.createDefaultInstance()];
			}

			s.instances.forEach((inst, idx) => {
				this.renderInstanceCard(el, inst, idx);
			});

			new Setting(el)
				.addButton((btn) => btn
					.setButtonText(t('settings.instances.add'))
					.setCta()
					.setDisabled(s.instances.length >= 10)
					.onClick(async () => {
						if (s.instances.length >= 10) {
							new Notice(t('settings.instances.maxReached'));
							return;
						}
						s.instances.push(this.createDefaultInstance());
						await this.plugin.saveSettings();
						this.display();
					}));
		});

		// ===== Publish scheduling =====
		this.renderSection(containerEl, t('settings.section.schedule'), (el) => {
			new Setting(el)
				.setName(t('settings.interval.name'))
				.setDesc(t('settings.interval.desc'))
				.addText((tx) => tx
					.setPlaceholder('30')
					.setValue(String(s.publishInterval))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.publishInterval = isNaN(n) || n < 0 ? 0 : n;
						await this.plugin.saveSettings();
						this.plugin.restartPublishInterval();
					}));

			new Setting(el)
				.setName(t('settings.publishOnStartup.name'))
				.setDesc(t('settings.publishOnStartup.desc'))
				.addToggle((tx) => tx.setValue(s.publishOnStartup).onChange(async (v) => {
					s.publishOnStartup = v;
					await this.plugin.saveSettings();
				}));

			new Setting(el)
				.addButton((btn) => btn.setButtonText(t('settings.publishNow')).setCta().onClick(async () => {
					await this.plugin.publishAll();
				}));
		});

		// ===== Scan scope =====
		this.renderSection(containerEl, t('settings.section.scope'), (el) => {
			new Setting(el)
				.setName(t('settings.scanFolders.name'))
				.setDesc(t('settings.scanFolders.desc'))
				.then((setting) => {
					const ta = setting.controlEl.createEl('textarea', { cls: 'publish-confluence-textarea' });
					ta.value = s.scanFolders.join('\n');
					ta.addEventListener('change', () => {
						s.scanFolders = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
						void this.plugin.saveSettings();
					});
				});

			new Setting(el)
				.setName(t('settings.ignore.name'))
				.setDesc(t('settings.ignore.desc'))
				.then((setting) => {
					const ta = setting.controlEl.createEl('textarea', { cls: 'publish-confluence-textarea' });
					ta.value = s.ignorePatterns.join('\n');
					ta.addEventListener('change', () => {
						s.ignorePatterns = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
						void this.plugin.saveSettings();
					});
				});
		});

		// ===== Templates =====
		this.renderSection(containerEl, t('settings.section.template'), (el) => {
			new Setting(el)
				.setName(t('settings.templateFolder.name'))
				.setDesc(t('settings.templateFolder.desc'))
				.addText((tx) => tx
					.setPlaceholder('templates')
					.setValue(s.templateFolderPath)
					.onChange(async (v) => {
						s.templateFolderPath = v.trim() || 'templates';
						await this.plugin.saveSettings();
					}));

			new Setting(el)
				.setName(t('settings.autoInstallTemplate.name'))
				.setDesc(t('settings.autoInstallTemplate.desc'))
				.addToggle((tx) => tx.setValue(s.autoInstallTemplate).onChange(async (v) => {
					s.autoInstallTemplate = v;
					await this.plugin.saveSettings();
				}));

			new Setting(el)
				.addButton((btn) => btn.setButtonText(t('settings.writeTemplateNow')).onClick(async () => {
					const ok = await this.plugin.installTemplateFile(true);
					new Notice(ok ? t('notice.templateWritten') : t('notice.templateWriteFailed'));
				}));
		});

		// ===== Attachments =====
		this.renderSection(containerEl, t('settings.section.attachments'), (el) => {
			new Setting(el)
				.setName(t('settings.uploadAttachments.name'))
				.setDesc(t('settings.uploadAttachments.desc'))
				.addToggle((tx) => tx.setValue(s.uploadAttachments).onChange(async (v) => {
					s.uploadAttachments = v;
					await this.plugin.saveSettings();
				}));

			new Setting(el)
				.setName(t('settings.maxAttachmentSize.name'))
				.setDesc(t('settings.maxAttachmentSize.desc'))
				.addText((tx) => tx
					.setValue(String(s.maxAttachmentSizeMB))
					.onChange(async (v) => {
						const n = parseFloat(v);
						s.maxAttachmentSizeMB = isNaN(n) || n <= 0 ? 10 : n;
						await this.plugin.saveSettings();
					}));

			new Setting(el)
				.setName(t('settings.defaultImageWidth.name'))
				.setDesc(t('settings.defaultImageWidth.desc'))
				.addText((tx) => tx
					.setPlaceholder('192')
					.setValue(String(s.defaultImageWidthPx))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.defaultImageWidthPx = isNaN(n) ? DEFAULT_SETTINGS.defaultImageWidthPx : Math.max(0, n);
						await this.plugin.saveSettings();
					}));
		});

		// ===== Diagram rendering =====
		this.renderSection(containerEl, t('settings.section.diagrams'), (el) => {
			el.createEl('p', {
				text: t('settings.diagramsIntro'),
				cls: 'setting-item-description',
			});

			new Setting(el)
				.setName(t('settings.drawio.toggleName'))
				.setDesc(t('settings.drawio.toggleDesc'))
				.addToggle((tx) => tx.setValue(s.renderDrawioToSvg).onChange(async (v) => {
					s.renderDrawioToSvg = v;
					await this.plugin.saveSettings();
					void this.plugin.rebuildPublishEngine();
					this.display();
				}));

			new Setting(el)
				.setName(t('settings.mermaid.toggleName'))
				.setDesc(t('settings.mermaid.toggleDesc'))
				.addToggle((tx) => tx.setValue(s.renderMermaidToPng).onChange(async (v) => {
					s.renderMermaidToPng = v;
					await this.plugin.saveSettings();
					void this.plugin.rebuildPublishEngine();
					this.display();
				}));

			if (s.renderMermaidToPng) {
				new Setting(el)
					.setName(t('settings.mermaid.rendererName'))
					.setDesc(t('settings.mermaid.rendererDesc'))
					.addDropdown((d) => d
						.addOption('kroki', t('settings.mermaid.rendererKroki'))
						.addOption('obsidian', t('settings.mermaid.rendererObsidian'))
						.setValue(s.mermaidRenderer)
						.onChange(async (v) => {
							s.mermaidRenderer = (v === 'obsidian' ? 'obsidian' : 'kroki');
							await this.plugin.saveSettings();
							void this.plugin.rebuildPublishEngine();
							this.display();
						}));

				const rendererHint = el.createEl('div', { cls: 'publish-confluence-renderer-hint setting-item-description' });
				if (s.mermaidRenderer === 'kroki') {
					rendererHint.createEl('p', { text: t('settings.mermaid.krokiPros') });
					rendererHint.createEl('p', { text: t('settings.mermaid.krokiCons') });
				} else {
					rendererHint.createEl('p', { text: t('settings.mermaid.obsidianPros') });
					rendererHint.createEl('p', { text: t('settings.mermaid.obsidianCons') });
				}

				if (s.mermaidRenderer === 'kroki') {
					new Setting(el)
						.setName(t('settings.mermaid.urlName'))
						.setDesc(t('settings.mermaid.urlDesc'))
						.addText((tx) => tx
							.setPlaceholder('https://kroki.io/mermaid/png')
							.setValue(s.mermaidRenderUrl)
							.onChange(async (v) => {
								s.mermaidRenderUrl = v.trim() || DEFAULT_SETTINGS.mermaidRenderUrl;
								await this.plugin.saveSettings();
								void this.plugin.rebuildPublishEngine();
							}));
				}
			}
		});

		// ===== UI behavior =====
		this.renderSection(containerEl, t('settings.section.ui'), (el) => {
			new Setting(el)
				.setName(t('settings.showStatusBar.name'))
				.addToggle((tx) => tx.setValue(s.showStatusBar).onChange(async (v) => {
					s.showStatusBar = v;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBarVisibility();
				}));

			new Setting(el)
				.setName(t('settings.showNotice.name'))
				.setDesc(t('settings.showNotice.desc'))
				.addToggle((tx) => tx.setValue(s.showNotice).onChange(async (v) => {
					s.showNotice = v;
					await this.plugin.saveSettings();
				}));

			new Setting(el)
				.setName(t('settings.frontmatterKey.name'))
				.setDesc(t('settings.frontmatterKey.desc'))
				.addText((tx) => tx
					.setPlaceholder('confluence_url')
					.setValue(s.frontmatterKey)
					.onChange(async (v) => {
						s.frontmatterKey = v.trim() || 'confluence_url';
						await this.plugin.saveSettings();
					}));
		});
	}

	private renderSection(parent: HTMLElement, title: string, build: (el: HTMLElement) => void): void {
		const section = parent.createDiv({ cls: 'publish-confluence-section' });
		new Setting(section).setName(title).setHeading();
		build(section);
	}

	private renderInstanceTokenSetting(parent: HTMLElement, inst: ConfluenceInstance): void {
		const isBearer = inst.authType === 'bearer';
		const setting = new Setting(parent)
			.setName(isBearer ? t('settings.token.nameBearer') : t('settings.token.nameBasic'))
			.setDesc(isBearer ? t('settings.token.descBearer') : t('settings.token.descBasic'));
		const SecretComponentCtor = (obsidianModule as unknown as {
			SecretComponent?: new (app: App, el: HTMLElement) => { setValue(v: string): unknown; onChange(fn: (v: string) => void): unknown };
		}).SecretComponent;
		// `addComponent` is intentionally cast: it's not part of the public
		// Setting type in older Obsidian versions, but the runtime method is
		// needed to mount the SecretComponent. The optional-chained typeof
		// check below makes the cast safe (we never call addComponent on
		// Obsidian versions that don't expose it).
		const addComponent = (setting as unknown as { addComponent?: (fn: (el: HTMLElement) => unknown) => Setting }).addComponent;

		if (typeof addComponent === 'function' && SecretComponentCtor) {
			// SecretComponent path: SecretComponent.setValue / .onChange work with
			// the KEY NAME in the vault (e.g. "my-confluence-token"). We persist
			// that name in inst.apiToken; getApiTokenValueForInstance reads it
			// directly.
			addComponent.call(setting, (compEl: HTMLElement) => {
				const comp = new SecretComponentCtor(this.app, compEl);
				comp.setValue(inst.apiToken);
				comp.onChange((value: string) => {
					const name = value.trim();
					if (!name) return;
					inst.apiToken = name;
					void this.plugin.saveSettings();
					// Rebuild API+engine so the new key is picked up.
					void this.plugin.refreshCredentials();
				});
				return comp;
			});
		} else {
		// Fallback for older Obsidian versions where SecretComponent is not
		// available: accept a freshly entered token and copy its value into
		// the derived `publish-confluence-token-<instId>` key. Saving on every
		// keystroke would issue one `setSecret` + `saveSettings` + engine
		// rebuild per character; debounce so paste-style entry is a single
		// write, and ensure a final flush on blur.
		{
			let pendingValue: string | null = null;
			let saveTimer: number | null = null;
			const flush = async (raw: string): Promise<void> => {
				const trimmed = raw.trim();
				if (!trimmed) return;
				const key = `publish-confluence-token-${inst.id}`;
				const storage = (this.app as unknown as { secretStorage?: { setSecret?(key: string, value: string): unknown } }).secretStorage;
				if (storage && typeof storage.setSecret === 'function') {
					try {
						const res = storage.setSecret(key, trimmed);
						if (res && typeof (res as { then?: unknown }).then === 'function') await (res as Promise<unknown>);
						inst.apiToken = key;
						await this.plugin.saveSettings();
						void this.plugin.refreshCredentials();
					} catch (e) {
						this.plugin.logger?.error('Failed to save token', e instanceof Error ? e.message : String(e));
						new Notice(t('settings.token.saveFailed'));
					}
				}
			};
			setting.addText((tx) => {
				tx.setPlaceholder(t('settings.token.placeholderPasteToken'))
					.setValue('')
					.onChange((v) => {
						pendingValue = v;
						if (saveTimer !== null) window.clearTimeout(saveTimer);
						saveTimer = window.setTimeout(() => {
							saveTimer = null;
							if (pendingValue !== null) void flush(pendingValue);
						}, 400);
					})
					.inputEl.addEventListener('blur', () => {
						if (saveTimer !== null) {
							window.clearTimeout(saveTimer);
							saveTimer = null;
						}
						if (pendingValue !== null) void flush(pendingValue);
					});
			});
		}
	}

		// Show which key is currently selected for the instance.
		if (inst.apiToken) {
			const saved = parent.createDiv({ cls: 'publish-confluence-instance-token-saved' });
			saved.setText(t('settings.token.savedLabel', { key: inst.apiToken }));
		}

		const hint = parent.createDiv({ cls: 'publish-confluence-keyvault-hint' });
		hint.createEl('span', { text: t('settings.token.hintLabel'), cls: 'publish-confluence-keyvault-hint-label' });
		hint.createSpan({ text: t('settings.token.hintBody') });
	}

	private async runValidateAuthForInstance(inst: ConfluenceInstance): Promise<void> {
		const resultEl = this.authResultEls.get(inst.id);
		if (!resultEl) return;
		resultEl.removeClass('ok', 'error');
		resultEl.setText(t('settings.validate.pending'));
		try {
			const tokenValue = await this.plugin.getApiTokenValueForInstance(inst.id);
			const needsUsername = inst.authType === 'basic';
			if (!inst.baseUrl || (needsUsername && !inst.username) || !tokenValue) {
				resultEl.addClass('error');
				resultEl.setText(needsUsername ? t('settings.validate.missingBasic') : t('settings.validate.missingBearer'));
				return;
			}
			const api = new ConfluenceApi({
				baseUrl: inst.baseUrl,
				authType: inst.authType,
				username: inst.username,
				apiToken: tokenValue,
			});
			const authResult = await api.validateAuth();
			if (authResult.ok === true) {
				resultEl.addClass('ok');
				resultEl.setText(t('settings.validate.ok', { name: authResult.displayName ?? '' }));
			} else {
				const errorText = 'error' in authResult ? authResult.error ?? '' : '';
				resultEl.addClass('error');
				resultEl.setText(t('settings.validate.fail', { error: errorText }));
			}
		} catch (e) {
			resultEl.addClass('error');
			resultEl.setText(t('settings.validate.exception', { error: e instanceof Error ? e.message : String(e) }));
		}
	}

	private createDefaultInstance(): ConfluenceInstance {
		return {
			id: this.generateInstanceId(),
			name: 'New Instance',
			baseUrl: '',
			authType: 'basic',
			username: '',
			apiToken: '',
			stripSupplementaryChars: false,
		};
	}

	private generateInstanceId(): string {
		return 'inst-' + Math.random().toString(36).slice(2, 9);
	}

	private renderInstanceCard(parent: HTMLElement, inst: ConfluenceInstance, idx: number): void {
		const card = parent.createDiv({ cls: 'publish-confluence-instance-card' });
		card.dataset.cardIndex = String(idx);
		const isSingle = this.plugin.settings.instances.length <= 1;

		// Header with name + actions
		const headerSetting = new Setting(card)
			.setName(inst.name || t('settings.instances.name'))
			.setHeading()
			.addButton((btn) => btn.setIcon('arrow-up').setTooltip(t('settings.instances.moveUp')).onClick(async () => {
				if (idx <= 0) return;
				const arr = this.plugin.settings.instances;
				const a = arr[idx - 1]!;
				const b = arr[idx]!;
				arr[idx - 1] = b;
				arr[idx] = a;
				await this.plugin.saveSettings();
				this.display();
			}))
			.addButton((btn) => btn.setIcon('arrow-down').setTooltip(t('settings.instances.moveDown')).onClick(async () => {
				const arr = this.plugin.settings.instances;
				if (idx >= arr.length - 1) return;
				const a = arr[idx]!;
				const b = arr[idx + 1]!;
				arr[idx] = b;
				arr[idx + 1] = a;
				await this.plugin.saveSettings();
				this.display();
			}))
			.addButton((btn) => btn.setIcon('trash').setTooltip(t('settings.instances.remove')).setDisabled(isSingle).onClick(async () => {
				if (isSingle) return;
				// Only delete the SecretStorage entry when this instance
				// owns the key. Plugin-derived keys (`publish-confluence-token-<id>`)
				// are unique per instance and safe to remove. User-picked
				// keychain entries (SecretComponent selection) might be
				// shared with another instance or used by an unrelated tool —
				// never delete those, since we can't know what else relies on
				// the same keychain entry.
				const derivedKey = `publish-confluence-token-${inst.id}`;
				// Instances created before the sync→publish rename still have
				// apiToken set to the old `sync-confluence-token-<id>` derived
				// key; recognize it too so upgrading doesn't orphan the secret.
				const legacyDerivedKey = `sync-confluence-token-${inst.id}`;
				if (inst.apiToken && (inst.apiToken === derivedKey || inst.apiToken === legacyDerivedKey)) {
					const storage = (this.app as unknown as { secretStorage?: { deleteSecret?(key: string): unknown } }).secretStorage;
					if (storage && typeof storage.deleteSecret === 'function') {
						try {
							const raw = storage.deleteSecret(inst.apiToken);
							if (raw && typeof (raw as { then?: unknown }).then === 'function') await (raw as Promise<unknown>);
						} catch { /* ignore */ }
					}
				}
				this.plugin.settings.instances.splice(idx, 1);
				await this.plugin.saveSettings();
				this.display();
			}));
		// Keep a handle on the heading for in-place updates on keystroke.
		const headerNameEl = headerSetting.nameEl;

		// Expose the stable key needed by `confluence_username.<instanceId>`.
		// It is intentionally read-only: changing it would orphan SecretStorage
		// and every per-instance cache slice already written to frontmatter.
		new Setting(card)
			.setName(t('settings.instances.id'))
			.setDesc(`${inst.id} — ${t('settings.instances.idDesc')}`);

		// Name
		new Setting(card)
			.setName(t('settings.instances.name'))
			.setDesc(t('settings.instances.nameDesc'))
			.addText((tx) => tx
				.setPlaceholder('Company A')
				.setValue(inst.name)
				.onChange(async (v) => {
					inst.name = v.trim();
					if (headerNameEl) headerNameEl.setText(inst.name || t('settings.instances.name'));
					await this.plugin.saveSettings();
					this.updateDuplicateWarnings(card, inst);
				}));

		// Base URL
		new Setting(card)
			.setName(t('settings.baseUrl.name'))
			.setDesc(t('settings.baseUrl.desc'))
			.addText((tx) => tx
				.setPlaceholder('https://xxx.atlassian.net/wiki')
				.setValue(inst.baseUrl)
				.onChange(async (v) => {
					inst.baseUrl = v.trim().replace(/\/+$/, '');
					await this.plugin.saveSettings();
					this.updateDuplicateWarnings(card, inst);
					void this.plugin.refreshCredentials();
				}));

		// Auth type
		new Setting(card)
			.setName(t('settings.authType.name'))
			.setDesc(t('settings.authType.desc'))
			.addDropdown((d) => d
				.addOption('basic', t('settings.authType.basic'))
				.addOption('bearer', t('settings.authType.bearer'))
				.setValue(inst.authType)
				.onChange(async (v) => {
					inst.authType = v as ConfluenceAuthType;
					await this.plugin.saveSettings();
					void this.plugin.refreshCredentials();
					// Re-render so the username field appears/disappears for
					// basic/bearer respectively.
					this.display();
				}));

		if (inst.authType === 'basic') {
			new Setting(card)
				.setName(t('settings.username.name'))
				.setDesc(t('settings.username.desc'))
				.addText((tx) => tx
					.setPlaceholder(t('settings.username.placeholder'))
					.setValue(inst.username)
					.onChange(async (v) => {
						inst.username = v.trim();
						await this.plugin.saveSettings();
						void this.plugin.refreshCredentials();
					}));
		}

		// Token
		this.renderInstanceTokenSetting(card, inst);

		// Validate
		new Setting(card)
			.addButton((btn) => btn.setButtonText(t('settings.validate.button')).setCta().onClick(async () => {
				await this.runValidateAuthForInstance(inst);
			}));

		const resultEl = card.createDiv({ cls: 'publish-confluence-auth-result' });
		this.authResultEls.set(inst.id, resultEl);

		// Legacy-confluence-server compatibility: replace emoji with [U+XXXX].
		// Per-instance so users with a mixed fleet (Cloud + old-MySQL Server) can
		// enable it only where needed. No engine rebuild required — the toggle
		// is read fresh on every publish.
		new Setting(card)
			.setName(t('settings.stripSupplementary.name'))
			.setDesc(t('settings.stripSupplementary.desc'))
			.addToggle((tx) => tx.setValue(inst.stripSupplementaryChars).onChange(async (v) => {
				inst.stripSupplementaryChars = v;
				await this.plugin.saveSettings();
			}));

		// Uniqueness errors are updated in-place via updateDuplicateWarnings().
		card.createDiv({ cls: 'publish-confluence-instance-dups' });
		this.updateDuplicateWarnings(card, inst);
	}

	/**
	 * Recompute duplicate-warning blocks inside the card without re-rendering
	 * the whole settings panel. Names and baseUrls are compared with
	 * case-insensitive trimmed normalization so "Acme" / "acme" are treated
	 * as duplicates.
	 */
	private updateDuplicateWarnings(card: HTMLElement, inst: ConfluenceInstance): void {
		const host = card.querySelector('.publish-confluence-instance-dups');
		if (!host) return;
		host.replaceChildren();
		const norm = (s: string) => s.trim().toLowerCase();
		const nameDup = this.plugin.settings.instances.some(
			(other) => other !== inst && norm(other.name) === norm(inst.name) && norm(inst.name) !== '',
		);
		const urlDup = this.plugin.settings.instances.some(
			(other, oi) => {
				if (other === inst) return false;
				if (!other.baseUrl || !inst.baseUrl) return false;
				return norm(other.baseUrl.replace(/\/+$/, '')) === norm(inst.baseUrl.replace(/\/+$/, ''));
			},
		);
		if (nameDup) host.createDiv({ cls: 'publish-confluence-error', text: t('settings.instances.duplicateName') });
		if (urlDup) host.createDiv({ cls: 'publish-confluence-error', text: t('settings.instances.duplicateBaseUrl') });
	}
}
