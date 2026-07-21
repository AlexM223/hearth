import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations, listMigrations } from './migrations.js';

describe('db: migration runner', () => {
	it('creates the meta and users tables (migration 001)', () => {
		const db = new DatabaseSync(':memory:');
		runMigrations(db);

		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[];
		const names = tables.map((t) => t.name);

		expect(names).toContain('meta');
		expect(names).toContain('users');
		expect(names).toContain('_migrations');
	});

	it('records every migration in _migrations after running once', () => {
		const db = new DatabaseSync(':memory:');
		runMigrations(db);

		const applied = db.prepare('SELECT id, name FROM _migrations ORDER BY id').all() as {
			id: number;
			name: string;
		}[];
		expect(applied.length).toBe(listMigrations().length);
		expect(applied[0]).toEqual({ id: 1, name: 'init: meta + users' });
	});

	it('is idempotent -- running twice never re-applies or throws', () => {
		const db = new DatabaseSync(':memory:');
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();

		const applied = db.prepare('SELECT id FROM _migrations').all() as { id: number }[];
		expect(applied.length).toBe(listMigrations().length);
	});

	it('enforces the users.role CHECK constraint from the schema outline', () => {
		const db = new DatabaseSync(':memory:');
		runMigrations(db);

		expect(() =>
			db
				.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
				.run('alex', 'hash', 'owner')
		).not.toThrow();

		expect(() =>
			db
				.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
				.run('mallory', 'hash', 'root')
		).toThrow();
	});
});
