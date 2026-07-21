/**
 * Settings -> Members & Invites (COME-ABOARD.md §5, §6.3). Owner-gated by
 * hooks.server.ts's requiresOwnerPage redirect (a Member/Guest never reaches
 * this load at all -- they're redirected to /me before SvelteKit resolves
 * the route). Roster + pending invites, one data source each, plus the
 * invite-create/revoke actions (Settings UI for invites, T10's other half).
 */
import { fail } from '@sveltejs/kit';
import {
	listMembers,
	householdSummary,
	createInvite,
	listInvites,
	revokeInvite,
	InviteError,
	changeMemberRole,
	offboardMember,
	MemberError,
	type WalletBalanceReader,
	type OffboardWalletPolicy
} from '$lib/server/auth/index.js';
import { listWallets, getSnapshot } from '$lib/server/wallet/index.js';
import type { Actions, PageServerLoad } from './$types';

const readBalances: WalletBalanceReader = (userId) =>
	listWallets(userId).map((w) => {
		const snap = getSnapshot(w.id);
		return { confirmedSats: snap?.confirmedSats ?? 0, unconfirmedSats: snap?.unconfirmedSats ?? 0 };
	});

export const load: PageServerLoad = ({ locals }) => {
	return {
		members: listMembers(readBalances),
		household: householdSummary(readBalances),
		invites: listInvites().map((i) => ({
			id: i.id,
			role: i.role,
			note: i.note,
			maxUses: i.maxUses,
			usedCount: i.usedCount,
			state: i.state,
			expiresAt: i.expiresAt,
			createdAt: i.createdAt
		})),
		ownUserId: locals.user!.id
	};
};

const EXPIRY_MS: Record<string, number | null> = {
	'1h': 3_600_000,
	'24h': 86_400_000,
	'7d': 7 * 86_400_000,
	'30d': 30 * 86_400_000,
	never: null
};

export const actions: Actions = {
	createInvite: async ({ request, locals, url }) => {
		const data = await request.formData();
		const role = String(data.get('role') ?? '');
		const note = String(data.get('note') ?? '').trim() || null;
		const expiryKey = String(data.get('expiry') ?? '7d');
		const allowMultiple = data.get('allowMultiple') === 'on';
		const maxUses = allowMultiple ? 5 : 1;

		try {
			const created = createInvite(locals.user!.id, {
				role,
				note,
				expiresInMs: expiryKey in EXPIRY_MS ? EXPIRY_MS[expiryKey] : EXPIRY_MS['7d'],
				maxUses
			});
			return {
				createdInvite: { url: `${url.origin}/join/${created.code}`, role: created.role }
			};
		} catch (e) {
			if (e instanceof InviteError) return fail(400, { error: e.message });
			throw e;
		}
	},

	revokeInvite: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'invalid invite id' });
		revokeInvite(id);
		return {};
	},

	changeRole: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		const role = String(data.get('role') ?? '');
		if (!Number.isInteger(id)) return fail(400, { error: 'invalid member id' });
		try {
			changeMemberRole(id, role);
			return {};
		} catch (e) {
			if (e instanceof MemberError) return fail(e.code === 'last_owner' ? 409 : 400, { error: e.message });
			throw e;
		}
	},

	offboard: async ({ request, locals }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		const walletPolicy = (data.get('walletPolicy') === 'transfer' ? 'transfer' : 'remove') as OffboardWalletPolicy;
		if (!Number.isInteger(id)) return fail(400, { error: 'invalid member id' });
		try {
			offboardMember(locals.user!.id, id, walletPolicy);
			return {};
		} catch (e) {
			if (e instanceof MemberError) return fail(e.code === 'last_owner' ? 409 : 400, { error: e.message });
			throw e;
		}
	}
};
