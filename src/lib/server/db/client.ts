/**
 * node:sqlite wrapper (DECISIONS.md §2, §4.8). WAL mode, one file, no ORM.
 *
 * node:sqlite's DatabaseSync is fully synchronous -- every query blocks the
 * event loop. That imposes real discipline (DECISIONS.md §2):
 *   - NEVER `await` inside an open BEGIN/COMMIT. Do async work (password
 *     hashing, etc.) BEFORE calling withTransaction.
 *   - The SSE fan-out never reads SQLite (see src/lib/server/events).
 *   - Batch hot writes on a timer rather than per-event.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let instance: DatabaseSync | null = null;

/** Opens (or creates) the SQLite file at `dbPath`, enabling WAL + foreign keys. */
export function openDb(dbPath: string): DatabaseSync {
	if (dbPath !== ':memory:') {
		mkdirSync(dirname(dbPath), { recursive: true });
	}
	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA foreign_keys = ON;');
	instance = db;
	return db;
}

/** Returns the already-open database. Throws if `openDb` hasn't run yet. */
export function getDb(): DatabaseSync {
	if (!instance) {
		throw new Error('hearth db: not initialized -- call openDb(dbPath) before getDb()');
	}
	return instance;
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE / COMMIT, rolling back on any thrown error.
 * `fn` MUST be synchronous -- node:sqlite has no notion of a "pending"
 * transaction across an event-loop tick, so an async fn would silently
 * interleave other synchronous writes into the same transaction.
 */
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
	const db = getDb();
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn(db);
		db.exec('COMMIT');
		return result;
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
}

/** Closes the database. Mainly for tests and graceful shutdown. */
export function closeDb(): void {
	instance?.close();
	instance = null;
}
