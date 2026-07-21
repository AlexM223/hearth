/**
 * /api/wallets -- the ONE wallet route tree (WALLET-ENGINE §3.3; DECISIONS.md
 * §4.2). GET lists the caller's wallets with their SWR balance snapshot; POST
 * imports (single-sig or multisig, one path). Owner-scoped throughout.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { importWallet, listWallets, getSnapshot, type ImportInput } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';

function requireUser(event: RequestEvent): { id: number } {
	const user = event.locals.user;
	if (!user) throw error(401, 'sign in first');
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
		return json({ id: wallet.id, name: wallet.name, kind: wallet.kind, scriptType: wallet.scriptType }, { status: 201 });
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
