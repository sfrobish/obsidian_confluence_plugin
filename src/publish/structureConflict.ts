export interface StructureConflictCheck {
	currentParentId?: string;
	expectedParentId?: string | null;
	currentTitle?: string;
	expectedTitle?: string;
	sacredRootPage?: boolean;
	defaultBehavior: boolean;
}

export function collectAncestorIndexPaths(filePath: string): string[] {
	const normalized = filePath.replace(/\\/g, '/').trim();
	if (!normalized || !normalized.endsWith('.md')) return [];

	const segments = normalized.split('/').filter(Boolean);
	if (segments.length <= 1) return [];

	const folderSegments = segments.slice(0, -1);
	if (folderSegments.length === 0) return [];

	const paths: string[] = [];
	for (let i = folderSegments.length; i >= 1; i--) {
		paths.push(`${folderSegments.slice(0, i).join('/')}/_index.md`);
	}
	return paths;
}

export function shouldReplaceRemotePageOnConflict({
	currentParentId,
	expectedParentId,
	sacredRootPage,
	defaultBehavior,
}: StructureConflictCheck): boolean {
	if (!defaultBehavior) return false;
	if (sacredRootPage) return false;
	const currentParent = currentParentId ?? '';
	const expectedParent = expectedParentId ?? '';
	if (expectedParent) {
		return currentParent !== expectedParent;
	}
	// Root pages are intentionally not deleted on title-only conflicts. If a
	// root page has been moved under a real parent, or a child page is
	// unexpectedly attached at the root, that is a structure mismatch and is
	// worth replacing.
	return Boolean(currentParent);
}
