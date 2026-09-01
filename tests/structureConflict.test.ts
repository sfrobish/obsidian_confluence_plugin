import { describe, expect, it } from 'bun:test';
import { collectAncestorIndexPaths, shouldReplaceRemotePageOnConflict } from '../src/sync/structureConflict';

describe('shouldReplaceRemotePageOnConflict', () => {
	it('never replaces the topmost vault root binding when Confluence parentage disagrees', () => {
		const result = shouldReplaceRemotePageOnConflict({
			currentParentId: 'old-parent',
			expectedParentId: 'new-parent',
			currentTitle: 'Old title',
			expectedTitle: 'New title',
			sacredRootPage: true,
			defaultBehavior: true,
		});
		expect(result).toBe(false);
	});

	it('replaces when the Confluence parent differs from the vault parent', () => {
		const result = shouldReplaceRemotePageOnConflict({
			currentParentId: 'old-parent',
			expectedParentId: 'new-parent',
			currentTitle: 'Old title',
			expectedTitle: 'New title',
			defaultBehavior: true,
		});
		expect(result).toBe(true);
	});

	it('keeps a root page in place when there is no parent mismatch, even if the title differs', () => {
		const result = shouldReplaceRemotePageOnConflict({
			currentParentId: undefined,
			expectedParentId: undefined,
			currentTitle: 'Old title',
			expectedTitle: 'New title',
			defaultBehavior: true,
		});
		expect(result).toBe(false);
	});

	it('never replaces the sacred root binding itself', () => {
		const result = shouldReplaceRemotePageOnConflict({
			currentParentId: 'old-parent',
			expectedParentId: 'new-parent',
			currentTitle: 'Old title',
			expectedTitle: 'New title',
			sacredRootPage: true,
			defaultBehavior: true,
		});
		expect(result).toBe(false);
	});

	it('keeps the existing update path when there is no structure mismatch', () => {
		const result = shouldReplaceRemotePageOnConflict({
			currentParentId: 'same-parent',
			expectedParentId: 'same-parent',
			currentTitle: 'Same title',
			expectedTitle: 'Same title',
			defaultBehavior: true,
		});
		expect(result).toBe(false);
	});

	it('walks the vault hierarchy from the immediate folder upward, not from the vault root downward', () => {
		expect(collectAncestorIndexPaths('docs/team/notes/foo.md')).toEqual([
			'docs/team/notes/_index.md',
			'docs/team/_index.md',
			'docs/_index.md',
		]);
	});
});
