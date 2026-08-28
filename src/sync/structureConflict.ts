export interface StructureConflictCheck {
	currentParentId?: string;
	expectedParentId?: string | null;
	currentTitle: string;
	expectedTitle: string;
	defaultBehavior: boolean;
}

export function shouldReplaceRemotePageOnConflict({
	currentParentId,
	expectedParentId,
	currentTitle,
	expectedTitle,
	defaultBehavior,
}: StructureConflictCheck): boolean {
	if (!defaultBehavior) return false;
	const parentMismatch = expectedParentId
		? (currentParentId ?? '') !== expectedParentId
		: Boolean(currentParentId);
	return parentMismatch || currentTitle !== expectedTitle;
}
