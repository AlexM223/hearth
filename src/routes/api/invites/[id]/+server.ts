/**
 * DELETE /api/invites/:id -- revoke (soft: revoked=1). Owner-only
 * (COME-ABOARD.md §1.3, §6.2). Revoking an unused link, never a person --
 * see §5.3's revoke-vs-offboard distinction (offboarding a member is
 * /api/members/:id, T11).
 */
import { json, error, type RequestEvent } from '@sveltejs/kit';
import { requireRole } from '$lib/server/auth/index.js';
import { revokeInvite } from '$lib/server/auth/invites.js';

export function DELETE(event: RequestEvent) {
	requireRole(event.locals.user, 'owner');
	const id = Number(event.params.id);
	if (!Number.isInteger(id)) throw error(400, 'invalid invite id');
	const ok = revokeInvite(id);
	if (!ok) throw error(404, 'invite not found');
	return json({ revoked: true });
}
