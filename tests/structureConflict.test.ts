import { describe, expect, it } from 'bun:test';
import { shouldReplaceRemotePageOnConflict } from '../src/sync/structureConflict';

describe('shouldReplaceRemotePageOnConflict', () => {
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

	it('replaces when the title differs even if the parent matches', () => {
		const result = shouldReplaceRemotePageOnConflict({
			currentParentId: 'same-parent',
			expectedParentId: 'same-parent',
			currentTitle: 'Old title',
			expectedTitle: 'New title',
			defaultBehavior: true,
		});
		expect(result).toBe(true);
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
});
