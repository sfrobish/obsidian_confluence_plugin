import { PublishStatus, PublishStatusText } from '../types';
import type PublishConfluencePlugin from '../main';
import { t } from '../i18n';

export class StatusBarManager {
	private plugin: PublishConfluencePlugin;
	private el: HTMLElement | null = null;
	private current: PublishStatus = PublishStatus.Idle;
	private resetTimeoutToken: number | null = null;

	constructor(plugin: PublishConfluencePlugin) {
		this.plugin = plugin;
	}

	create(): HTMLElement {
		this.el = this.plugin.addStatusBarItem();
		this.el.addClass('publish-confluence-status');
		this.update(PublishStatus.Idle);
		return this.el;
	}

	update(status: PublishStatus, tooltip?: string): void {
		if (!this.el) return;
		this.current = status;
		this.el.removeClass('idle', 'publishing', 'success', 'failed', 'partial');
		this.el.addClass(status);
		this.el.setText(PublishStatusText[status]);
		this.el.setAttribute('aria-label', tooltip ?? this.defaultTooltip(status));
		this.el.setAttribute('aria-label-position', 'top');
	}

	private defaultTooltip(status: PublishStatus): string {
		const last = this.plugin.logger?.getLastPublishTime();
		const localeTag = 'en-US';
		const lastSuffix = last ? t('status.tooltipLastPublish', { time: last.toLocaleString(localeTag) }) : '';
		switch (status) {
			case PublishStatus.Idle: return t('status.tooltipIdle', { lastSuffix });
			case PublishStatus.Publishing: return t('status.tooltipPublishing');
			case PublishStatus.Success: return t('status.tooltipSuccess', { time: new Date().toLocaleTimeString(localeTag) });
			case PublishStatus.Failed: return t('status.tooltipFailed');
			case PublishStatus.Partial: return t('status.tooltipPartial');
			default: return 'Publish Confluence';
		}
	}

	showPublishing(text?: string): void {
		this.update(PublishStatus.Publishing);
		if (this.el && text) this.el.setText(t('status.publishingLabelPrefix', { text }));
	}

	showSuccess(summary?: string): void {
		this.update(PublishStatus.Success, summary);
		if (this.resetTimeoutToken !== null) window.clearTimeout(this.resetTimeoutToken);
		this.resetTimeoutToken = window.setTimeout(() => {
			this.resetTimeoutToken = null;
			if (this.current === PublishStatus.Success) this.update(PublishStatus.Idle);
		}, 4000);
	}

	showPartial(summary?: string): void {
		if (this.resetTimeoutToken !== null) {
			window.clearTimeout(this.resetTimeoutToken);
			this.resetTimeoutToken = null;
		}
		this.update(PublishStatus.Partial, summary);
		// Partial results carry a multi-line summary the user typically wants
		// to read; don't auto-reset. The pill stays visible until the next
		// publish attempt overwrites it.
	}

	showFailed(error?: string): void {
		this.update(PublishStatus.Failed, error ? t('status.tooltipFailedWithError', { error }) : undefined);
	}

	destroy(): void {
		if (this.resetTimeoutToken !== null) {
			window.clearTimeout(this.resetTimeoutToken);
			this.resetTimeoutToken = null;
		}
		this.el?.remove();
		this.el = null;
	}
}
