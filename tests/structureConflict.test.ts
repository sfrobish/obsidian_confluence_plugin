import { describe, expect, it } from 'bun:test';
import { collectAncestorIndexPaths, shouldReplaceRemotePageOnConflict } from '../src/publish/structureConflict';
import { MarkdownConverter } from '../src/confluence/markdownConverter';

(globalThis as any).window ??= { crypto: { subtle: crypto.subtle } };

describe('markdown Mermaid fence conversion', () => {
	it('replaces a fenced Mermaid block even when there is a blank line before the closing fence', async () => {
		const converter = new MarkdownConverter({} as any);
		const md = '```mermaid\nflowchart TD\nA-->B\n\n```\n';
		const refs = await converter.extractReferences(md, 'x.md');
		const ctx = {
			attachedFilenames: new Set<string>(),
			mermaidFilenameByHash: new Map(refs.mermaid.map((b) => [b.hash, b.filename])),
			drawioFilenameByHash: new Map(),
			drawioFilenameByPath: new Map(),
			renderMermaidToSvg: true,
			renderDrawioToSvg: false,
			defaultImageWidthPx: 0,
			stripSupplementaryChars: false,
		};
		const out = await converter.convert(md, 'x.md', ctx);
		expect(out).toContain('<ac:image>');
		expect(out).not.toContain('ac:name="code"');
	});
});

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
