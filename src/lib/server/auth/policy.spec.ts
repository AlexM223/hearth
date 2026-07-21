/**
 * T1 acceptance (COME-ABOARD.md §8): the deny-by-default policy table.
 */
import { describe, expect, it } from 'vitest';
import { resolveApiPolicy, API_POLICY } from './policy.js';

describe('auth/policy: resolveApiPolicy (deny-by-default)', () => {
	it('returns null for an unmapped path -- the deny-by-default case', () => {
		expect(resolveApiPolicy('/api/__unmapped', 'GET')).toBeNull();
		expect(resolveApiPolicy('/api/totally/made/up', 'POST')).toBeNull();
	});

	it('resolves /api/health as public', () => {
		expect(resolveApiPolicy('/api/health', 'GET')?.min).toBe('public');
	});

	it('resolves /api/invites as owner-only', () => {
		expect(resolveApiPolicy('/api/invites', 'POST')?.min).toBe('owner');
		expect(resolveApiPolicy('/api/invites/5', 'DELETE')?.min).toBe('owner');
	});

	it('resolves /api/wallets as member-or-above (ownership re-checked in-handler)', () => {
		expect(resolveApiPolicy('/api/wallets', 'GET')?.min).toBe('member');
		expect(resolveApiPolicy('/api/wallets/1/drafts/2', 'GET')?.min).toBe('member');
	});

	it('resolves /api/chain and /api/mining/pool as guest-readable (shared instruments)', () => {
		expect(resolveApiPolicy('/api/chain/blocks/1', 'GET')?.min).toBe('guest');
		expect(resolveApiPolicy('/api/mining/pool', 'GET')?.min).toBe('guest');
	});

	it('resolves /api/mining/config as owner-only (engine toggle)', () => {
		expect(resolveApiPolicy('/api/mining/config', 'POST')?.min).toBe('owner');
	});

	it('resolves /api/me/** as any-authed (self-scoped in handler)', () => {
		expect(resolveApiPolicy('/api/me/profile', 'POST')?.min).toBe('authed');
	});

	it('every rule pattern is well-formed (a basic sanity/lint over the table)', () => {
		for (const rule of API_POLICY) {
			expect(rule.pattern).toBeInstanceOf(RegExp);
			expect(['public', 'authed', 'guest', 'member', 'owner']).toContain(rule.min);
		}
	});
});
