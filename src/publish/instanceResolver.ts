import { App, TFile } from 'obsidian';
import { ConfluenceInstance, PublishTarget } from '../types';
import { tryParseUrl, urlMatchesBaseUrl } from '../confluence/urlMatch';
import { readTargetsFromFrontmatter, type Frontmatter } from '../frontmatter/handler';

export interface InstanceResolverDeps {
	instances: ConfluenceInstance[];
}

export interface TargetPartition {
	ownedIndices: number[];
	foreignIndices: number[];
	unmatchedIndices: number[];
	ignoredIndices: number[];
}

/**
 * Resolve a note URL to its owning Confluence instance.
 *
 * Longest-prefix-match with host-boundary safety: target and base must share
 * the same protocol and host, and the path must be either equal to the base
 * or start with `base + '/'`. This protects against
 * `https://example.com` / `https://example.com.evil.test` style attacks.
 */
export class InstanceResolver {
	constructor(private deps: InstanceResolverDeps) {}

	resolve(url: string): ConfluenceInstance | null {
		if (!url || typeof url !== 'string') return null;
		if (!tryParseUrl(url)) return null;

		let best: ConfluenceInstance | null = null;
		let bestLen = -1;

		for (const inst of this.deps.instances) {
			if (!inst.baseUrl) continue;
			if (!tryParseUrl(inst.baseUrl)) continue;
			if (!urlMatchesBaseUrl(url, inst.baseUrl)) continue;
			const normalizedLen = inst.baseUrl
				.trim()
				.replace(/\/+$/, '')
				.length;
			if (normalizedLen > bestLen) {
				best = inst;
				bestLen = normalizedLen;
			}
		}

		return best;
	}

	/**
	 * Resolve one index-aligned target to exactly one instance.
	 *
	 * Once a page exists, confluence_url is authoritative. parentUrl only
	 * participates while url is empty and the child page still needs to be
	 * created. This prevents a stale/cross-instance parentUrl from making two
	 * engines claim the same existing page.
	 */
	resolveTarget(target: PublishTarget): ConfluenceInstance | null {
		const url = target.url.trim();
		if (url) return this.resolve(url);
		const parentUrl = target.parentUrl?.trim() ?? '';
		if (parentUrl) return this.resolve(parentUrl);
		const pageId = target.pageId.trim();
		if (pageId && this.deps.instances.length === 1) return this.deps.instances[0] ?? null;
		return null;
	}

	/** Effective URL used for target ownership and unmatched diagnostics. */
	getRoutingUrl(target: PublishTarget): string {
		const url = target.url.trim();
		if (url) return url;
		const parentUrl = target.parentUrl?.trim() ?? '';
		if (parentUrl) return parentUrl;
		return target.pageId.trim();
	}

	/**
	 * Partition a file's targets for one engine. A partially unmatched target
	 * is reported by exactly one engine (the first matched owner in target
	 * order); other engines treat it as foreign. Files with no matched owner
	 * never reach an engine and are returned by groupByInstance as unmatched.
	 */
	partitionTargets(targets: PublishTarget[], currentInstanceId: string): TargetPartition {
		const owners = targets.map((target) => this.resolveTarget(target)?.id ?? null);
		const reporterId = owners.find((id): id is string => id !== null) ?? null;
		const result: TargetPartition = {
			ownedIndices: [],
			foreignIndices: [],
			unmatchedIndices: [],
			ignoredIndices: [],
		};

		targets.forEach((target, index) => {
			const ownerId = owners[index];
			if (ownerId === currentInstanceId) {
				result.ownedIndices.push(index);
			} else if (ownerId !== null) {
				result.foreignIndices.push(index);
			} else if (!this.getRoutingUrl(target)) {
				result.ignoredIndices.push(index);
			} else if (reporterId === currentInstanceId) {
				result.unmatchedIndices.push(index);
			} else {
				result.foreignIndices.push(index);
			}
		});
		return result;
	}

	/** Pick the URL for a referenced note that belongs to one engine. */
	findTargetUrlForInstance(targets: PublishTarget[], instanceId: string): string | null {
		for (const target of targets) {
			const url = target.url.trim();
			if (url && this.resolveTarget(target)?.id === instanceId) return url;
		}
		return null;
	}

	/**
	 * Multi-instance + multi-target: parse the index-aligned targets and resolve
	 * each one by its authoritative URL (or parent URL for an uncreated page).
	 * A file lands in an instance's group when at least one target belongs to
	 * that instance. A file can land in multiple groups; each engine then
	 * processes only its owned target indices.
	 *
	 * unmatched: none of the target URLs matched any configured instance.
	 */
	groupByInstance(
		files: TFile[],
		app: App,
		frontmatterKey: string,
	): {
		groups: Map<string, { instance: ConfluenceInstance; files: TFile[] }>;
		unmatched: TFile[];
	} {
		const groups = new Map<string, { instance: ConfluenceInstance; files: TFile[] }>();
		const unmatched: TFile[] = [];

		for (const file of files) {
			const targets = this.getRoutingTargetsForFile(app, file, frontmatterKey);
			const routableTargets = targets.filter((target) => {
				const route = this.getRoutingUrl(target);
				return route.length > 0 || target.pageId.trim().length > 0;
			});
			if (routableTargets.length === 0) {
				unmatched.push(file);
				continue;
			}

			const matchedInstances = new Map<string, ConfluenceInstance>();
			for (const target of routableTargets) {
				const inst = this.resolveTarget(target);
				if (inst && !matchedInstances.has(inst.id)) matchedInstances.set(inst.id, inst);
			}
			if (matchedInstances.size === 0) {
				unmatched.push(file);
				continue;
			}

			for (const inst of matchedInstances.values()) {
				const existing = groups.get(inst.id);
				if (existing) {
					existing.files.push(file);
				} else {
					groups.set(inst.id, { instance: inst, files: [file] });
				}
			}
		}

		return { groups, unmatched };
	}

	private getRoutingTargetsForFile(app: App, file: TFile, frontmatterKey: string): PublishTarget[] {
		const cache = app.metadataCache.getFileCache(file);
		const fm = (cache?.frontmatter ?? {}) as Frontmatter;
		const direct = readTargetsFromFrontmatter(fm, frontmatterKey).targets;
		if (direct.some((target) => target.url.trim().length > 0 || target.parentUrl?.trim().length || target.pageId.trim().length > 0)) {
			return direct;
		}

		let current = file.path.includes('/')
			? file.path.split('/').slice(0, -1).join('/')
			: '';
		while (current.length > 0) {
			const indexPath = `${current}/_index.md`;
			const indexFile = app.vault.getAbstractFileByPath(indexPath);
			if (indexFile instanceof TFile) {
				const indexFm = (app.metadataCache.getFileCache(indexFile)?.frontmatter ?? {}) as Frontmatter;
				const inherited = readTargetsFromFrontmatter(indexFm, frontmatterKey).targets;
				const routed = inherited.map((target) => ({
					...target,
					url: '',
					parentUrl: target.parentUrl?.trim() || target.url.trim() || target.pageId.trim() || undefined,
					pageId: '',
				}));
				if (routed.some((target) => (target.parentUrl?.trim().length ?? 0) > 0 || target.url.trim().length > 0 || target.pageId.trim().length > 0)) {
					return routed;
				}
			}
			current = current.includes('/')
				? current.slice(0, current.lastIndexOf('/'))
				: '';
		}
		return direct;
	}
}
