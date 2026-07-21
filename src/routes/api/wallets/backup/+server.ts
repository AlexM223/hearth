/**
 * GET /api/wallets/backup -- download the caller's wallets as a Hearth wallet
 * backup: PUBLIC data only (names + output descriptors), exactly what
 * re-import needs and nothing more. The same universal import surface
 * (parse-config) recognizes the file and restores every wallet from it.
 * Member-gated like the rest of the wallet tree.
 */
import { error, type RequestEvent } from '@sveltejs/kit';
import { buildWalletBackup, listWallets } from '$lib/server/wallet/index.js';
import { requireRole } from '$lib/server/auth/index.js';

export function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'member');
	const wallets = listWallets(user.id);
	if (wallets.length === 0) throw error(404, 'no wallets to back up yet');
	const backup = buildWalletBackup(wallets);
	const date = backup.exportedAt.slice(0, 10);
	return new Response(JSON.stringify(backup, null, 2), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': `attachment; filename="hearth-wallets-${date}.json"`,
			'cache-control': 'no-store'
		}
	});
}
