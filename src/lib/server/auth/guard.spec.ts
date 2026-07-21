/**
 * T1 acceptance (COME-ABOARD.md §8): role rank ordering + requireRole's
 * 401-vs-403 split. requireWalletAccess is exercised at the route level by
 * route-gate.spec.ts (T2) since it needs a real wallet + db.
 */
import { describe, expect, it } from 'vitest';
import { roleAtLeast, requireRole } from './guard.js';
import type { SessionUser } from './session.js';

function user(role: 'owner' | 'member' | 'guest'): SessionUser {
	return { id: 1, username: 'u', role, mustResetPassword: false };
}

describe('auth/guard: roleAtLeast (rank ordering)', () => {
	it('public is always true, even for an anonymous caller', () => {
		expect(roleAtLeast(null, 'public')).toBe(true);
	});

	it('authed requires a session but no particular role', () => {
		expect(roleAtLeast(null, 'authed')).toBe(false);
		expect(roleAtLeast(user('guest'), 'authed')).toBe(true);
	});

	it('ranks guest < member < owner', () => {
		expect(roleAtLeast(user('guest'), 'guest')).toBe(true);
		expect(roleAtLeast(user('guest'), 'member')).toBe(false);
		expect(roleAtLeast(user('guest'), 'owner')).toBe(false);

		expect(roleAtLeast(user('member'), 'guest')).toBe(true);
		expect(roleAtLeast(user('member'), 'member')).toBe(true);
		expect(roleAtLeast(user('member'), 'owner')).toBe(false);

		expect(roleAtLeast(user('owner'), 'guest')).toBe(true);
		expect(roleAtLeast(user('owner'), 'member')).toBe(true);
		expect(roleAtLeast(user('owner'), 'owner')).toBe(true);
	});

	it('an anonymous caller never meets a guest/member/owner minimum', () => {
		expect(roleAtLeast(null, 'guest')).toBe(false);
		expect(roleAtLeast(null, 'member')).toBe(false);
		expect(roleAtLeast(null, 'owner')).toBe(false);
	});
});

describe('auth/guard: requireRole (401 vs 403)', () => {
	it('throws 401 for no session', () => {
		try {
			requireRole(null, 'guest');
			throw new Error('expected a throw');
		} catch (e) {
			expect((e as { status: number }).status).toBe(401);
		}
	});

	it('throws 403 for an insufficient role', () => {
		try {
			requireRole(user('guest'), 'owner');
			throw new Error('expected a throw');
		} catch (e) {
			expect((e as { status: number }).status).toBe(403);
		}
	});

	it('returns the user when the role is sufficient', () => {
		expect(requireRole(user('owner'), 'member')).toEqual(user('owner'));
	});
});
