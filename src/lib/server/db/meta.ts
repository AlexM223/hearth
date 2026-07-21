/**
 * Generic reader/writer for the `meta` kv table (migration 001). Used for
 * small app-level settings that don't warrant their own column/table --
 * household display name and per-user "welcomed" flags (COME-ABOARD.md §1.1,
 * §2.5) are the first M3 consumers.
 */
import { getDb } from './client.js';

export function getMeta(key: string): string | null {
	const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
	getDb()
		.prepare(
			`INSERT INTO meta (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
		)
		.run(key, value);
}

export function deleteMeta(key: string): void {
	getDb().prepare('DELETE FROM meta WHERE key = ?').run(key);
}
