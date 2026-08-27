import { type App, TFile } from 'obsidian';
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
		const isIndexPage = file.basename === '_index';
		const hasHierarchyAnchor = isIndexPage && hasConfluenceMetadata(fm);
		const hasInheritedHierarchyAnchor = !hasHierarchyAnchor && hasAncestorHierarchyAnchor(app, file);
		const hasDirectBinding = frontmatterHasBinding((fm ?? {}) as Frontmatter, opts.frontmatterKey);
		// Sync only when the note has an explicit binding or it falls under a folder hierarchy that already has Confluence metadata.
		if (!hasDirectBinding && !hasHierarchyAnchor && !hasInheritedHierarchyAnchor) continue;
		out.push(file);
	}
	return out;
}

function hasConfluenceMetadata(fm: Frontmatter | undefined): boolean {
	if (!fm) return false;
	return !!(
		(typeof fm.confluence_page_id === 'string' && fm.confluence_page_id.trim().length > 0) ||
		(typeof fm.confluence_url === 'string' && fm.confluence_url.trim().length > 0) ||
		(typeof fm.confluence_parent_url === 'string' && fm.confluence_parent_url.trim().length > 0)
	);
}

function hasAncestorHierarchyAnchor(app: App, file: TFile): boolean {
	let current = file.path.includes('/')
		? file.path.split('/').slice(0, -1).join('/')
		: '';

	while (current.length > 0) {
		const indexPath = `${current}/_index.md`;
		const indexFile = app.vault.getAbstractFileByPath(indexPath);
		if (indexFile && indexFile instanceof TFile) {
			const fm = app.metadataCache.getFileCache(indexFile)?.frontmatter as Frontmatter | undefined;
			if (hasConfluenceMetadata(fm)) return true;
		}
		current = current.includes('/')
			? current.slice(0, current.lastIndexOf('/'))
			: '';
	}
	return false;
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
