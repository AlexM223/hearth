/**
 * Migration 010: drops two dead-code beads found by the foundation
 * documentation audit (DECISIONS.md's 2026-07-21 §4.8-supersession entry;
 * docs/SCHEMA.md §4, §3.2) and confirmed by a repo-wide grep before this
 * migration was written.
 *
 * 1. `utxos.reserved_by_draft_id` (migration 004) was declared but never read
 *    or written anywhere. The REAL double-spend reservation mechanism has
 *    always been the live join in `wallet/repo.ts`'s `reservedOutpoints()`
 *    over `psbt_draft_inputs` x in-flight `psbt_drafts` -- see that function
 *    for the query. A dead column on the money path outlives its excuse;
 *    drop it (hearth-krx).
 * 2. `scripthash_status` (migration 004) has no reader or writer outside its
 *    own DDL and the migration-004 schema-shape test -- dormant since it
 *    shipped, not scaffolding for imminent work (git log --follow on
 *    004_wallets.ts shows one commit, a0705cc, T0; nothing since has touched
 *    it). Drop it too (hearth-7vg).
 *
 * Historical migrations are never edited once shipped (DECISIONS.md §2) --
 * same idiom as migration 009 dropping migration 003's dead index -- so
 * 004_wallets.ts stays exactly as it shipped; this migration undoes the diff.
 *
 * node:sqlite's bundled SQLite supports `ALTER TABLE ... DROP COLUMN`
 * (verified directly against node:sqlite; SQLite added it in 3.35.0). No
 * `IF EXISTS` variant exists for DROP COLUMN, so -- same as migration 005's
 * bare `ALTER TABLE ... ADD COLUMN`s -- idempotency is the migration RUNNER's
 * job (each id applies exactly once via the `_migrations` ledger), not this
 * SQL's.
 */
import type { Migration } from '../migrations.js';

export const migration010DropDeadReservationScripthash: Migration = {
	id: 10,
	name: 'drop dead utxos.reserved_by_draft_id column + dormant scripthash_status table',
	up(db) {
		db.exec(`
			ALTER TABLE utxos DROP COLUMN reserved_by_draft_id;

			DROP TABLE IF EXISTS scripthash_status;
		`);
	}
};
