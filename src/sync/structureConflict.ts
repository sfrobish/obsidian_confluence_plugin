export interface StructureConflictCheck {
	currentParentId?: string;
	expectedParentId?: string | null;
	currentTitle?: string;
	expectedTitle?: string;
	defaultBehavior: boolean;
}

export function shouldReplaceRemotePageOnConflict({
	currentParentId,
	expectedParentId,
	defaultBehavior,
}: StructureConflictCheck): boolean {
	if (!defaultBehavior) return false;
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
