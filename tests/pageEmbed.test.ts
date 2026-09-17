import { describe, expect, it } from 'bun:test';
import type { App } from 'obsidian';
import { convert, ConvertContext } from '../src/confluence/convertMarkdown';

const baseCtx: ConvertContext = {
	attachedFilenames: new Set(),
	mermaidFilenameByHash: new Map(),
	drawioFilenameByHash: new Map(),
	drawioFilenameByPath: new Map(),
	renderMermaidToSvg: false,
	renderDrawioToSvg: false,
	defaultImageWidthPx: 0,
	stripSupplementaryChars: false,
};

const app = {} as App;

describe('whole-note embed (![[Note]])', () => {
	it('renders an Include Page macro when the note resolves to a Confluence page', async () => {
		const ctx: ConvertContext = { ...baseCtx, resolveWikilink: () => ({ url: '/wiki/x', title: 'Other Note' }) };
		const html = await convert(app, '![[Other Note]]', 'source.md', ctx);
		expect(html).toContain('<ac:structured-macro ac:name="include"');
		expect(html).toContain('<ac:link><ri:page ri:content-title="Other Note" /></ac:link>');
		expect(html).not.toContain('ac:image');
	});

	it('falls back to plain text when the note cannot be resolved', async () => {
		const ctx: ConvertContext = { ...baseCtx, resolveWikilink: () => null };
		const html = await convert(app, '![[Missing Note]]', 'source.md', ctx);
		expect(html).not.toContain('ac:structured-macro');
		expect(html).toContain('Missing Note');
	});

	it('still treats image extensions as image embeds, not page embeds', async () => {
		const ctx: ConvertContext = { ...baseCtx, resolveWikilink: () => ({ url: '/wiki/x' }) };
		const html = await convert(app, '![[diagram.png]]', 'source.md', ctx);
		expect(html).not.toContain('ac:structured-macro ac:name="include"');
	});
});
