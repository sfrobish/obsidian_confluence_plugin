import type { App, TFile } from 'obsidian';
import { frontmatterHasBinding, type Frontmatter } from '../frontmatter/handler';

export interface ScanOptions {
	frontmatterKey: string;
	scanFolders: string[];
	ignorePatterns: string[];
}

/**
 * Scan the vault for all notes that include confluence_url frontmatter.
 * Use metadataCache, O(n), and only check the cache for each file (already indexed), without reading from disk.
 *
 * Automatically and implicitly ignore Obsidian's config directory (default `.obsidian`, user-customizable),
 * so users do not need to maintain it manually in ignorePatterns.
 */
export function scanBoundNotes(app: App, opts: ScanOptions): TFile[] {
	const all = app.vault.getMarkdownFiles();
	const scanFolders = opts.scanFolders.map(normalizeFolder).filter((s) => s.length > 0);
	const ignoreRegexes = [`${app.vault.configDir}/**`, ...opts.ignorePatterns]
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map(globToRegex);

	const out: TFile[] = [];
	for (const file of all) {
		if (scanFolders.length > 0 && !scanFolders.some((f) => file.path === f || file.path.startsWith(f + '/'))) continue;
		if (ignoreRegexes.some((r) => r.test(file.path))) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter as Frontmatter | undefined;
			if (!fm) continue;
			const isIndexPage = file.basename === '_index';
			const hasHierarchyAnchor = isIndexPage && (!!fm.confluence_page_id || !!fm.confluence_url || !!fm.confluence_parent_url);
			// Sync only when url or parent_url has at least one value (parent_url is used for creating child pages on first sync)
			if (!frontmatterHasBinding(fm, opts.frontmatterKey) && !hasHierarchyAnchor) continue;
			out.push(file);
	}
	return out;
}

function normalizeFolder(s: string): string {
	return s.trim().replace(/^\/+|\/+$/g, '');
}

/** Minimal glob → RegExp: supports * and ? */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');
	return new RegExp('^' + escaped + '$');
}
