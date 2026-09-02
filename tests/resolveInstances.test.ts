import { describe, expect, it } from 'bun:test';
import {
	resolveInstance,
	resolveTargetInstance,
	getRoutingUrl,
	partitionTargets,
	findTargetUrlForInstance,
} from '../src/publish/resolveInstances';
import type { ConfluenceInstance, PublishTarget } from '../src/types';

const inst = (id: string, baseUrl: string): ConfluenceInstance => ({
	id,
	name: id,
	baseUrl,
	authType: 'bearer',
	username: '',
	apiToken: '',
	stripSupplementaryChars: false,
});

const target = (t: Partial<PublishTarget>): PublishTarget => ({
	url: '',
	parentUrl: undefined,
	pageId: '',
	...t,
});

const A = inst('a', 'https://a.example.com/wiki');
const B = inst('b', 'https://b.example.com/wiki');

describe('resolveInstance', () => {
	it('returns null when nothing matches', () => {
		expect(resolveInstance([A, B], 'https://c.example.com/wiki/pages/1')).toBeNull();
	});

	it('resolves a url to its owning instance', () => {
		expect(resolveInstance([A, B], 'https://b.example.com/wiki/pages/1')?.id).toBe('b');
	});

	it('picks the longest-prefix match regardless of array order', () => {
		const root = inst('root', 'https://team.example.com');
		const wiki = inst('wiki', 'https://team.example.com/wiki');
		const url = 'https://team.example.com/wiki/pages/99';
		expect(resolveInstance([root, wiki], url)?.id).toBe('wiki');
		expect(resolveInstance([wiki, root], url)?.id).toBe('wiki');
	});

	it('skips instances with an empty or unparseable baseUrl', () => {
		const broken = inst('broken', 'not-a-url');
		const blank = inst('blank', '');
		expect(resolveInstance([broken, blank, A], 'https://a.example.com/wiki/x')?.id).toBe('a');
	});

	it('returns null for an unparseable target url', () => {
		expect(resolveInstance([A], 'nonsense')).toBeNull();
	});

	it('does not resolve a look-alike parent domain to the real instance', () => {
		const real = inst('real', 'https://example.com');
		expect(resolveInstance([real], 'https://example.com.evil.test/wiki/pages/1')).toBeNull();
	});
});

describe('resolveTargetInstance', () => {
	it('resolves by url when present', () => {
		expect(resolveTargetInstance([A, B], target({ url: 'https://a.example.com/wiki/1' }))?.id).toBe('a');
	});

	it('falls back to parentUrl only while url is empty', () => {
		expect(
			resolveTargetInstance([A, B], target({ url: '', parentUrl: 'https://b.example.com/wiki/parent' }))?.id,
		).toBe('b');
	});

	it('lets url win over a stale cross-instance parentUrl', () => {
		const t = target({ url: 'https://a.example.com/wiki/1', parentUrl: 'https://b.example.com/wiki/parent' });
		expect(resolveTargetInstance([A, B], t)?.id).toBe('a');
	});

	it('assigns a bare pageId to the sole instance', () => {
		expect(resolveTargetInstance([A], target({ pageId: '12345' }))?.id).toBe('a');
	});

	it('does not guess an instance for a bare pageId when several are configured', () => {
		expect(resolveTargetInstance([A, B], target({ pageId: '12345' }))).toBeNull();
	});

	it('returns null for an empty target', () => {
		expect(resolveTargetInstance([A, B], target({}))).toBeNull();
	});
});

describe('getRoutingUrl', () => {
	it('prefers url, then parentUrl, then pageId, then empty', () => {
		expect(getRoutingUrl(target({ url: 'u', parentUrl: 'p', pageId: 'id' }))).toBe('u');
		expect(getRoutingUrl(target({ parentUrl: 'p', pageId: 'id' }))).toBe('p');
		expect(getRoutingUrl(target({ pageId: 'id' }))).toBe('id');
		expect(getRoutingUrl(target({}))).toBe('');
	});
});

describe('partitionTargets', () => {
	it('splits targets into owned and foreign by instance id', () => {
		const targets = [
			target({ url: 'https://a.example.com/wiki/1' }),
			target({ url: 'https://b.example.com/wiki/2' }),
		];
		const p = partitionTargets([A, B], targets, 'a');
		expect(p.ownedIndices).toEqual([0]);
		expect(p.foreignIndices).toEqual([1]);
		expect(p.unmatchedIndices).toEqual([]);
		expect(p.ignoredIndices).toEqual([]);
	});

	it('ignores a target with no routing information', () => {
		const targets = [target({ url: 'https://a.example.com/wiki/1' }), target({})];
		const p = partitionTargets([A, B], targets, 'a');
		expect(p.ownedIndices).toEqual([0]);
		expect(p.ignoredIndices).toEqual([1]);
	});

	it('reports an unmatched target once — via the first owned instance in the file', () => {
		const targets = [
			target({ url: 'https://a.example.com/wiki/1' }),
			target({ url: 'https://c.example.com/wiki/unknown' }),
		];
		// instance A owns target 0, so A is the reporter for the unmatched target 1
		const forA = partitionTargets([A, B], targets, 'a');
		expect(forA.ownedIndices).toEqual([0]);
		expect(forA.unmatchedIndices).toEqual([1]);

		// instance B owns nothing here, so the unmatched target is foreign to it
		const forB = partitionTargets([A, B], targets, 'b');
		expect(forB.foreignIndices).toEqual([0, 1]);
		expect(forB.unmatchedIndices).toEqual([]);
	});
});

describe('findTargetUrlForInstance', () => {
	const targets = [
		target({ url: 'https://b.example.com/wiki/2' }),
		target({ url: 'https://a.example.com/wiki/1' }),
	];

	it('returns the first url owned by the given instance', () => {
		expect(findTargetUrlForInstance([A, B], targets, 'a')).toBe('https://a.example.com/wiki/1');
	});

	it('skips targets whose url is empty even if a pageId would resolve', () => {
		const withPageId = [target({ url: '', pageId: '999' }), target({ url: 'https://a.example.com/wiki/1' })];
		expect(findTargetUrlForInstance([A], withPageId, 'a')).toBe('https://a.example.com/wiki/1');
	});

	it('returns null when no owned target has a url', () => {
		expect(findTargetUrlForInstance([A, B], [target({ url: 'https://c.example.com/wiki/x' })], 'a')).toBeNull();
	});
});
