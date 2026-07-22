/**
 * /api/wallets -- the ONE wallet route tree (WALLET-ENGINE §3.3; DECISIONS.md
 * §4.2). GET lists the caller's wallets with their SWR balance snapshot; POST
 * imports (single-sig or multisig, one path). Owner-scoped throughout.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { importWallet, listWallets, getSnapshot, type ImportInput } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { requireRole } from '$lib/server/auth/index.js';
import { nudgeWatchtowerRefresh } from '$lib/server/notify/index.js';

/** Layer 2 (COME-ABOARD.md §3.3, defense in depth): a Guest holds no wallet
 *  (matrix §3.2 -- ✗). Layer 1 (hooks.server.ts's API_POLICY) already
 *  requires 'member' for every /api/wallets/** path; this makes the service
 *  enforce the same rule even if that policy line were ever dropped, or if
 *  this handler is invoked from non-route code (tests, a future SSE bridge). */
function requireUser(event: RequestEvent): { id: number } {
	const user = requireRole(event.locals.user, 'member');
	return { id: user.id };
}

export function GET(event: RequestEvent) {
	const user = requireUser(event);
	const wallets = listWallets(user.id).map((w) => {
		const snap = getSnapshot(w.id);
		return {
			id: w.id,
			name: w.name,
			kind: w.kind,
			scriptType: w.scriptType,
			network: w.network,
			threshold: w.threshold,
			keyCount: w.keys.length,
			confirmedSats: snap?.confirmedSats ?? 0,
			unconfirmedSats: snap?.unconfirmedSats ?? 0
		};
	});
	return json({ wallets });
}

export async function POST(event: RequestEvent) {
	const user = requireUser(event);
	let body: ImportInput;
	try {
		body = (await event.request.json()) as ImportInput;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	try {
		const wallet = importWallet(user.id, body);
		// Watch the new wallet NOW -- the periodic enumeration is up to 5
		// minutes out, and a payment landing before it would be silently
		// baselined away (WATCHTOWER §1.1's gate, found live on regtest).
		nudgeWatchtowerRefresh();
		return json({ id: wallet.id, name: wallet.name, kind: wallet.kind, scriptType: wallet.scriptType }, { status: 201 });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
