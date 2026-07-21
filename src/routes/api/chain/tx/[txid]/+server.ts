/**
 * GET /api/chain/tx/:txid -- tx detail (EXPLORER.md §1.5, §4.2). getTxDetail
 * throws when the tx can't be resolved on any rail; a Core "not found" RPC
 * code (-5) means the txid is genuinely unknown -> 404. Any other failure
 * (a down rail) -> 503, never a raw stack trace, never a silent crash.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { getTxDetail } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';

export async function GET(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'guest');
	const node = getNodeClient();
	try {
		const detail = await getTxDetail(node, event.params.txid!, user.id);
		return json(detail);
	} catch (e) {
		const rpcCode = (e as { rpcCode?: number } | null)?.rpcCode;
		if (rpcCode === -5) throw error(404, 'transaction not found');
		throw error(503, 'node unreachable -- try again shortly');
	}
}
