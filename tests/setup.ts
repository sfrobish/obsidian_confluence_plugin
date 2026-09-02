import { mock } from 'bun:test';

// The `obsidian` package ships types only (no runtime entry), so any source
// module with a value import from 'obsidian' fails to load under `bun test`.
// Stub the handful of runtime symbols the codebase imports — enough for
// `instanceof` checks and constructor calls in unit tests. Anything that needs
// real Obsidian behavior belongs in a manual/integration test, not here.
class TFile {
	path = '';
	name = '';
	basename = '';
	extension = '';
}
class TFolder {
	path = '';
	name = '';
	children: unknown[] = [];
}

mock.module('obsidian', () => ({
	App: class {},
	Plugin: class {},
	PluginSettingTab: class {},
	Modal: class {},
	Notice: class { constructor(_message?: string) {} },
	Setting: class { constructor(_containerEl?: unknown) {} },
	Component: class {},
	TFile,
	TFolder,
	TAbstractFile: class {},
	MarkdownRenderer: { render: async () => {}, renderMarkdown: async () => {} },
	setIcon: () => {},
	normalizePath: (p: string) => p,
}));
