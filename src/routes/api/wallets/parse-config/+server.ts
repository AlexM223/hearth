/**
 * POST /api/wallets/parse-config -- preview-before-confirm for the universal
 * import surface: takes raw pasted/uploaded text, auto-detects the format
 * (Caravan / Coldcard / Sparrow / descriptor / xpub / Hearth backup), and
 * returns normalized import plans WITHOUT persisting anything. The client
 * shows the preview, the user confirms, and the confirm POSTs each plan's
 * `input` to the existing /api/wallets. Member-gated like the rest of the
 * wallet tree (API_POLICY /api/wallets/** + the same in-handler check).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { parseWalletConfig } from '$lib/server/wallet/index.js';
import { httpStatusFor } from '$lib/server/wallet/errors.js';
import { requireRole } from '$lib/server/auth/index.js';

export async function POST(event: RequestEvent) {
	requireRole(event.locals.user, 'member');
	let body: { content?: unknown; filename?: unknown };
	try {
		body = (await event.request.json()) as typeof body;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	if (typeof body.content !== 'string') throw error(400, 'expected { content: string }');
	const filename = typeof body.filename === 'string' ? body.filename : null;
	try {
		return json(parseWalletConfig(body.content, filename));
	} catch (e) {
		const { status, message } = httpStatusFor(e);
		throw error(status, message);
	}
}
