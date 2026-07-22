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

/** A year is generously long for a household invite link; anything past
 *  this is almost certainly a unit mistake (seconds instead of ms) rather
 *  than an intentional "keep this open forever" choice -- and "forever" is
 *  already expressible by omitting expiresInMs entirely. */
const MAX_EXPIRES_IN_MS = 365 * 24 * 60 * 60 * 1000;

/** An invite is a household-scale primitive (one captain onboarding a
 *  handful of members/guests), not a public sign-up link -- this caps
 *  runaway/garbage input, not legitimate use. */
const MAX_INVITE_USES = 1000;

/** Shape/range-validate the untrusted body BEFORE it ever reaches
 *  createInvite's `new Date(Date.now() + expiresInMs)` (audit P2#8): a
 *  non-numeric expiresInMs used to poison that call into NaN, and
 *  `new Date(NaN).toISOString()` throws a raw RangeError -- surfacing as an
 *  uncaught 500 instead of a 400 with a plain-language message. */
function assertValidCreateBody(body: CreateBody): void {
	if (body.expiresInMs != null) {
		if (typeof body.expiresInMs !== 'number' || !Number.isFinite(body.expiresInMs) || body.expiresInMs <= 0) {
			throw error(400, 'expiresInMs must be a positive number of milliseconds');
		}
		if (body.expiresInMs > MAX_EXPIRES_IN_MS) {
			throw error(400, 'expiresInMs cannot exceed one year');
		}
	}
	if (body.maxUses != null) {
		if (
			typeof body.maxUses !== 'number' ||
			!Number.isFinite(body.maxUses) ||
			!Number.isInteger(body.maxUses) ||
			body.maxUses <= 0
		) {
			throw error(400, 'maxUses must be a positive integer');
		}
		if (body.maxUses > MAX_INVITE_USES) {
			throw error(400, `maxUses cannot exceed ${MAX_INVITE_USES}`);
		}
	}
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
	assertValidCreateBody(body);

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
