/**
 * Migration 005: come-aboard provenance + member-management columns
 * (COME-ABOARD.md §1.1, §6.1 -- the spec calls this "003_invites_members";
 * renumbered to 005 here since 003/004 were already taken by the M1 events
 * table and the M2 wallet schema). Idempotency is the migration RUNNER's job
 * (each id applies exactly once, tracked in `_migrations`; a rolled-back
 * partial failure retries cleanly since ALTER TABLE is transactional) -- same
 * house style as 001-004, no per-statement existence checks needed. No new
 * tables; household name + per-user "welcomed" flags reuse the existing
 * `meta` kv table (§1.1).
 */
import type { Migration } from '../migrations.js';

export const migration005InvitesMembers: Migration = {
	id: 5,
	name: 'come-aboard: invite provenance + member management columns',
	up(db) {
		db.exec(`
			ALTER TABLE invites ADD COLUMN note TEXT;
			ALTER TABLE invites ADD COLUMN accepted_at TEXT;

			ALTER TABLE users ADD COLUMN display_name TEXT;
			ALTER TABLE users ADD COLUMN invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
			ALTER TABLE users ADD COLUMN created_via_invite INTEGER REFERENCES invites(id) ON DELETE SET NULL;
			ALTER TABLE users ADD COLUMN last_active_at TEXT;

			CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);
		`);
	}
};
