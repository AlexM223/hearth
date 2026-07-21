/**
 * /api/invites -- Owner-only invite create/list (COME-ABOARD.md §1.2, §6.2).
 * Layer 1 (hooks.server.ts + API_POLICY) already requires 'owner'; requireRole
 * here is Layer 2 (defense in depth, COME-ABOARD.md §3.3).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { createInvite, listInvites, InviteError, type CreateInviteInput } from '$lib/server/auth/invites.js';

interface CreateBody {
	role?: string;
	note?: string | null;
	expiresInMs?: number | null;
	maxUses?: number;
}

export function GET(event: RequestEvent) {
	requireRole(event.locals.user, 'owner');
	// Never include the code -- hash-only storage, and it was never persisted.
	const invites = listInvites().map((i) => ({
		id: i.id,
		role: i.role,
		note: i.note,
		maxUses: i.maxUses,
		usedCount: i.usedCount,
		state: i.state,
		expiresAt: i.expiresAt,
		acceptedAt: i.acceptedAt,
		createdAt: i.createdAt,
		createdBy: i.createdBy
	}));
	return json({ invites });
}

export async function POST(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'owner');
	let body: CreateBody;
	try {
		body = (await event.request.json()) as CreateBody;
	} catch {
		throw error(400, 'expected a JSON body');
	}
	if (typeof body.role !== 'string') throw error(400, 'role is required');

	const input: CreateInviteInput = {
		role: body.role,
		note: body.note ?? null,
		expiresInMs: body.expiresInMs ?? null,
		maxUses: body.maxUses ?? 1
	};

	try {
		const created = createInvite(user.id, input);
		// The plaintext code is returned ONCE, here, and never again (§1.2).
		const url = `${event.url.origin}/join/${created.code}`;
		return json(
			{
				id: created.id,
				code: created.code,
				url,
				role: created.role,
				expiresAt: created.expiresAt,
				maxUses: created.maxUses
			},
			{ status: 201 }
		);
	} catch (e) {
		if (e instanceof InviteError) throw error(400, e.message);
		throw e;
	}
}
