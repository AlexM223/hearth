/**
 * /api/wallets/[id]/ledger-registration -- the Ledger BIP-388 registration
 * HMAC seam (SIGNING.md §1.1, WALLET-ENGINE §2.5, §3.2). GET returns this
 * wallet's stored registrations (one per device that has registered); POST
 * persists a new one after the browser driver completes a registration
 * ceremony. Not PSBT-bearing -- the HMAC is not secret, it only spares a
 * later sign from re-approval -- but still owner-only (this wallet's
 * cosigner-key material shape is nobody else's business).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import {
	getWallet,
	resolveWalletRole,
	listLedgerRegistrations,
	saveLedgerRegistration
} from '$lib/server/wallet/index.js';
import { requireRole } from '$lib/server/auth/index.js';

function requireOwner(event: RequestEvent): number {
	// Explicit org-role floor (defense in depth) before the resource-level
	// ownership check below -- matches /api/wallets's requireRole('member').
	const user = requireRole(event.locals.user, 'member');
	const walletId = Number(event.params.id);
	if (resolveWalletRole(user.id, getWallet(user.id, walletId)) !== 'owner') throw error(404, 'wallet not found');
	return walletId;
}

export function GET(event: RequestEvent) {
	const walletId = requireOwner(event);
	return json({ registrations: listLedgerRegistrations(walletId) });
}

interface RegisterBody {
	masterFp?: string;
	policyName?: string;
	policyHmac?: string;
}

export async function POST(event: RequestEvent) {
	const walletId = requireOwner(event);
	let body: RegisterBody;
	try {
		body = (await event.request.json()) as RegisterBody;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	const { masterFp, policyName, policyHmac } = body;
	if (typeof masterFp !== 'string' || !/^[0-9a-fA-F]{8}$/.test(masterFp)) {
		throw error(400, 'a valid 8-hex master fingerprint is required');
	}
	if (typeof policyHmac !== 'string' || !/^[0-9a-fA-F]{64}$/.test(policyHmac)) {
		throw error(400, 'a valid 64-hex policy HMAC is required');
	}
	if (typeof policyName !== 'string' || policyName.length === 0 || policyName.length > 64) {
		throw error(400, 'a policy name (<=64 chars) is required');
	}
	saveLedgerRegistration(walletId, masterFp, policyName, policyHmac);
	return json({ registrations: listLedgerRegistrations(walletId) }, { status: 201 });
}
