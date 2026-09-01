import { setIcon } from 'obsidian';
import type PublishConfluencePlugin from '../main';
import { t } from '../i18n';

const ACTIONS_CLS = 'publish-confluence-prop-actions';

/**
 * Inject action icons inline in the confluence_url row in the properties panel (issue #2):
 *  - cloud-upload: publish the current note
 *  - external-link: open the bound Confluence page (or show a menu for multiple targets)
 *
 * This follows the Share Note plugin pattern: the properties panel renders asynchronously,
 * and after active-leaf-change we use MutationObserver to inject the buttons once the target row appears.
 * Intentionally no "unbind" button — destructive actions should not be one click away in the properties panel.
 */
export class PropertyActionsManager {
	private observer: MutationObserver | null = null;
	private injectPending = false;

	constructor(private plugin: PublishConfluencePlugin) {}

	start(): void {
		const { plugin } = this;
		plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', () => this.scheduleInject()));
		plugin.registerEvent(plugin.app.workspace.on('layout-change', () => this.scheduleInject()));
		plugin.registerEvent(plugin.app.metadataCache.on('changed', (file) => {
			if (file.path === plugin.app.workspace.getActiveFile()?.path) this.scheduleInject();
		}));
		this.scheduleInject();
	}

	destroy(): void {
		this.stopObserver();
		for (const el of Array.from(activeDocument.querySelectorAll(`.${ACTIONS_CLS}`))) el.remove();
	}

	/** Every trigger keeps a persistent observer on activeView: when the properties panel enters edit mode, Obsidian rebuilds the inline DOM, so it must be re-injected automatically */
	private scheduleInject(): void {
		this.stopObserver();
		this.tryInject();

		const container = this.activeViewContainer();
		if (!container) return;
		this.observer = new MutationObserver(() => this.requestInject());
		this.observer.observe(container, { childList: true, subtree: true });
	}

	/** rAF coalesces frequent mutations (fires on every keystroke while editing) */
	private requestInject(): void {
		if (this.injectPending) return;
		this.injectPending = true;
		window.requestAnimationFrame(() => {
			this.injectPending = false;
			this.tryInject();
		});
	}

	private stopObserver(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	private activeViewContainer(): HTMLElement | null {
		const leaf = this.plugin.app.workspace.getMostRecentLeaf();
		return (leaf?.view as { containerEl?: HTMLElement } | undefined)?.containerEl ?? null;
	}

	/** @returns true = already injected or not needed (the row exists) / false = the target row has not appeared yet */
	private tryInject(): boolean {
		const container = this.activeViewContainer();
		const file = this.plugin.app.workspace.getActiveFile();
		if (!container || !file) return true;

		const urlKey = this.plugin.settings.frontmatterKey || 'confluence_url';
		const row = container.querySelector(`.metadata-property[data-property-key="${urlKey}"]`);
		if (!row) return false;

		// Duplicate injection guard: if the row already has buttons, do nothing
		if (row.querySelector(`.${ACTIONS_CLS}`)) return true;

		const valueEl = row.querySelector('.metadata-property-value') ?? row;
		const wrap = activeDocument.createElement('span');
		wrap.className = ACTIONS_CLS;

		this.addButton(wrap, 'cloud-upload', t('propertyActions.publish'), () => {
			void this.plugin.publishFile(file);
		});

		valueEl.appendChild(wrap);
		return true;
	}

	private addButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: (evt: MouseEvent) => void,
	): void {
		const btn = activeDocument.createElement('span');
		btn.className = 'publish-confluence-prop-btn clickable-icon';
		btn.setAttribute('aria-label', label);
		setIcon(btn, icon);
		this.plugin.registerDomEvent(btn, 'click', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			onClick(evt);
		});
		parent.appendChild(btn);
	}

}
