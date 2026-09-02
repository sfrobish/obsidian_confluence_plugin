import { describe, expect, it } from 'bun:test';
import {
	tryParseUrl,
	urlMatchesBaseUrl,
	splitCsvUrls,
	extractTargetUrls,
	extractFirstTargetUrl,
} from '../src/confluence/urlMatch';

describe('tryParseUrl', () => {
	it('returns a URL for a valid absolute url', () => {
		expect(tryParseUrl('https://example.com/wiki')?.hostname).toBe('example.com');
	});

	it('trims surrounding whitespace', () => {
		expect(tryParseUrl('  https://example.com  ')?.protocol).toBe('https:');
	});

	it('returns null for non-strings, empty, and unparseable input', () => {
		expect(tryParseUrl(undefined)).toBeNull();
		expect(tryParseUrl(42)).toBeNull();
		expect(tryParseUrl('')).toBeNull();
		expect(tryParseUrl('   ')).toBeNull();
		expect(tryParseUrl('not a url')).toBeNull();
		expect(tryParseUrl('/relative/path')).toBeNull();
	});
});

describe('urlMatchesBaseUrl', () => {
	it('matches an exact url', () => {
		expect(urlMatchesBaseUrl('https://example.com/wiki', 'https://example.com/wiki')).toBe(true);
	});

	it('matches a sub-path of the base', () => {
		expect(urlMatchesBaseUrl('https://example.com/wiki/pages/123', 'https://example.com/wiki')).toBe(true);
	});

	it('tolerates a trailing slash on the base', () => {
		expect(urlMatchesBaseUrl('https://example.com/wiki/x', 'https://example.com/wiki/')).toBe(true);
	});

	it('matches any path when the base has no path', () => {
		expect(urlMatchesBaseUrl('https://example.com/anything/here', 'https://example.com')).toBe(true);
	});

	it('is case-insensitive on host and path', () => {
		expect(urlMatchesBaseUrl('https://EXAMPLE.com/WIKI/Page', 'https://example.com/wiki')).toBe(true);
	});

	// --- host-boundary security ---
	it('does NOT match a look-alike parent domain', () => {
		expect(urlMatchesBaseUrl('https://example.com.evil.test/wiki', 'https://example.com')).toBe(false);
	});

	it('does NOT match a different subdomain', () => {
		expect(urlMatchesBaseUrl('https://evil.example.com/wiki', 'https://example.com')).toBe(false);
	});

	// --- path-boundary safety ---
	it('does NOT match a path that only shares a prefix segment', () => {
		expect(urlMatchesBaseUrl('https://example.com/wikievil', 'https://example.com/wiki')).toBe(false);
	});

	it('does NOT match on protocol mismatch', () => {
		expect(urlMatchesBaseUrl('http://example.com/wiki', 'https://example.com/wiki')).toBe(false);
	});

	it('does NOT match on port mismatch', () => {
		expect(urlMatchesBaseUrl('https://example.com:8443/wiki', 'https://example.com/wiki')).toBe(false);
	});

	it('returns false for unparseable inputs', () => {
		expect(urlMatchesBaseUrl('nonsense', 'https://example.com')).toBe(false);
		expect(urlMatchesBaseUrl('https://example.com', 'nonsense')).toBe(false);
	});
});

describe('splitCsvUrls', () => {
	it('splits on ASCII and full-width commas, trims, and drops empties', () => {
		expect(splitCsvUrls('a, b，c ,, d')).toEqual(['a', 'b', 'c', 'd']);
	});

	it('returns an empty array for a blank string', () => {
		expect(splitCsvUrls('   ')).toEqual([]);
	});
});

describe('extractTargetUrls', () => {
	const key = 'confluence_url';

	it('reads a scalar url', () => {
		expect(extractTargetUrls({ confluence_url: 'https://a/1' }, key)).toEqual(['https://a/1']);
	});

	it('reads a CSV url string', () => {
		expect(extractTargetUrls({ confluence_url: 'https://a/1, https://a/2' }, key)).toEqual([
			'https://a/1',
			'https://a/2',
		]);
	});

	it('reads an array of urls (with nested CSV entries)', () => {
		expect(extractTargetUrls({ confluence_url: ['https://a/1', 'https://a/2,https://a/3'] }, key)).toEqual([
			'https://a/1',
			'https://a/2',
			'https://a/3',
		]);
	});

	it('appends confluence_parent_url after the primary key', () => {
		expect(
			extractTargetUrls({ confluence_url: 'https://a/1', confluence_parent_url: 'https://a/parent' }, key),
		).toEqual(['https://a/1', 'https://a/parent']);
	});

	it('honours a custom url key', () => {
		expect(extractTargetUrls({ my_key: 'https://a/1' }, 'my_key')).toEqual(['https://a/1']);
	});

	it('skips non-string entries', () => {
		expect(extractTargetUrls({ confluence_url: [null, 3, 'https://a/1'] } as never, key)).toEqual(['https://a/1']);
	});
});

describe('extractFirstTargetUrl', () => {
	it('returns the first url', () => {
		expect(extractFirstTargetUrl({ confluence_url: 'https://a/1,https://a/2' }, 'confluence_url')).toBe('https://a/1');
	});

	it('returns an empty string when there are no urls', () => {
		expect(extractFirstTargetUrl({}, 'confluence_url')).toBe('');
	});
});
