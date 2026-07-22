/**
 * The mining dashboard load + actions (MINING-ENGINE.md §6). One page,
 * role-gated sections (the settings/members precedent): Guest sees the
 * shared pool view only; Member additionally sees their own connection/
 * workers/odds; Owner additionally sees the admin aggregate + settings form.
 * Never a hard failure -- each data source is independently guarded so a
 * read-model throw degrades to an honest `loadError` banner, never a 500 or
 * a misreported engine state (MINING-ENGINE.md §6.2).
 */
import { fail } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getUserMiningView, getPublicPoolView, getAdminMiningView } from '$lib/server/mining/readModels.js';
import { setPayoutWallet, setUserMiningEnabled, regenerateMiningId, ensureMiningPrefs } from '$lib/server/mining/prefs.js';
import { writeMiningSetting } from '$lib/server/mining/settings.js';
import { reconfigureMiningEngine } from '$lib/server/mining/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireRole(locals.user, 'guest');
	let loadError: string | null = null;

	let pool = null;
	try {
		pool = await getPublicPoolView(user.id);
	} catch {
		loadError = 'The pool view is temporarily unavailable.';
	}

	let mine = null;
	if (user.role === 'member' || user.role === 'owner') {
		try {
			mine = await getUserMiningView(user.id);
		} catch {
			loadError ??= 'Your mining view is temporarily unavailable.';
		}
	}

	let admin = null;
	if (user.role === 'owner') {
		try {
			admin = await getAdminMiningView();
		} catch {
			loadError ??= 'The admin mining view is temporarily unavailable.';
		}
	}

	return {
		role: user.role,
		pool,
		mine,
		admin,
		loadError,
		hostname: url.hostname
	};
};

export const actions = {
	toggleMining: async ({ request, locals }) => {
		const user = requireRole(locals.user, 'member');
		const data = await request.formData();
		const enabled = data.get('enabled') === 'on';
		ensureMiningPrefs(user.id);
		setUserMiningEnabled(user.id, enabled);
		return {};
	},

	// Explicit return type: without it, TS's inferred return type for this
	// async arrow collapses to just the LAST return statement's shape ({}),
	// dropping the fail() branches from $types.d.ts's ActionData union --
	// `form?.error` then fails to typecheck in +page.svelte. Every other
	// action here returns a uniform {} on success with no error path, so they
	// don't need the same annotation.
	setPayout: async ({
		request,
		locals
	}): Promise<Record<string, never> | ReturnType<typeof fail<{ error: string }>>> => {
		const user = requireRole(locals.user, 'member');
		const data = await request.formData();
		const raw = data.get('walletId');
		const walletId = raw && String(raw).length > 0 ? Number(raw) : null;
		if (walletId !== null && !Number.isInteger(walletId))
			return fail(400, { error: 'that payout wallet selection was not recognized -- pick a wallet from the list' });
		try {
			setPayoutWallet(user.id, walletId);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'could not set payout wallet' });
		}
		return {};
	},

	regenerateId: async ({ locals }) => {
		const user = requireRole(locals.user, 'member');
		regenerateMiningId(user.id);
		return {};
	},

	saveSettings: async ({ request, locals }) => {
		requireRole(locals.user, 'owner');
		const data = await request.formData();
		writeMiningSetting('mining_enabled', data.get('mining_enabled') === 'on');
		const bind = String(data.get('mining_bind') ?? 'loopback');
		if (bind === 'loopback' || bind === 'lan' || bind === 'all') writeMiningSetting('mining_bind', bind);
		const port = Number(data.get('mining_stratum_port'));
		if (Number.isInteger(port) && port > 0) writeMiningSetting('mining_stratum_port', port);
		const shareDiff = Number(data.get('mining_share_difficulty'));
		if (Number.isFinite(shareDiff) && shareDiff > 0) writeMiningSetting('mining_share_difficulty', shareDiff);
		writeMiningSetting('mining_vardiff_enabled', data.get('mining_vardiff_enabled') === 'on');
		const poolTag = String(data.get('mining_pool_tag') ?? '').trim();
		if (poolTag) writeMiningSetting('mining_pool_tag', poolTag);
		writeMiningSetting('mining_asic_port_enabled', data.get('mining_asic_port_enabled') === 'on');

		await reconfigureMiningEngine();
		return {};
	}
};
