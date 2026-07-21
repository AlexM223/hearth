/**
 * /api/members/:id -- role change (PATCH) and offboard (DELETE), both
 * Owner-only (COME-ABOARD.md §5.2, §5.3, §6.2). Distinct from revoking an
 * invite LINK (/api/invites/:id) -- this operates on an existing PERSON.
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { changeMemberRole, offboardMember, MemberError, type OffboardWalletPolicy } from '$lib/server/auth/members.js';

export async function PATCH(event: RequestEvent) {
	requireRole(event.locals.user, 'owner');
	const targetId = Number(event.params.id);
	if (!Number.isInteger(targetId)) throw error(400, 'invalid member id');

	let body: { role?: string };
	try {
		body = (await event.request.json()) as { role?: string };
	} catch {
		throw error(400, 'expected a JSON body');
	}
	if (typeof body.role !== 'string') throw error(400, 'role is required');

	try {
		changeMemberRole(targetId, body.role);
		return json({ ok: true });
	} catch (e) {
		if (e instanceof MemberError) {
			const status = e.code === 'not_found' ? 404 : e.code === 'last_owner' ? 409 : 400;
			throw error(status, e.message);
		}
		throw e;
	}
}

export async function DELETE(event: RequestEvent) {
	const user = requireRole(event.locals.user, 'owner');
	const targetId = Number(event.params.id);
	if (!Number.isInteger(targetId)) throw error(400, 'invalid member id');

	let body: { walletPolicy?: string } = {};
	try {
		body = (await event.request.json()) as { walletPolicy?: string };
	} catch {
		// No body at all is fine -- default to 'remove'.
	}
	const walletPolicy: OffboardWalletPolicy = body.walletPolicy === 'transfer' ? 'transfer' : 'remove';

	try {
		offboardMember(user.id, targetId, walletPolicy);
		return json({ offboarded: true, walletPolicy });
	} catch (e) {
		if (e instanceof MemberError) {
			const status = e.code === 'not_found' ? 404 : e.code === 'last_owner' ? 409 : 400;
			throw error(status, e.message);
		}
		throw e;
	}
}
