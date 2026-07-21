/**
 * T8 acceptance: hooks.server.ts's boot composition
 * (startWatchtowerService/startNotificationQueueWorker) wires cleanly
 * against a real NodeClient (even one pointed at nothing) and never throws
 * on start or stop -- a fast unit-level guard alongside the manual
 * `vite build` + boot smoke test performed for this milestone.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrations.js';
import { NodeClient } from '../node/index.js';
import { initSecretKey, __resetSecretKeyForTests } from './config/secrets.js';
import { startWatchtowerService, startNotificationQueueWorker, initWatchtowerOrigin } from './index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let secretDir: string;
let node: NodeClient;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	secretDir = mkdtempSync(join(tmpdir(), 'hearth-notify-index-'));
	__resetSecretKeyForTests();
	initSecretKey(secretDir);
	initWatchtowerOrigin('https://hearth.example');
	node = new NodeClient({ host: '127.0.0.1', port: 1, tls: false }, { host: '127.0.0.1', port: 1 });
});
afterEach(() => {
	node.close();
	__resetSecretKeyForTests();
	rmSync(secretDir, { recursive: true, force: true });
});

describe('T8: boot composition', () => {
	it('startWatchtowerService starts and stops cleanly against an unreachable node', () => {
		let service: ReturnType<typeof startWatchtowerService> | undefined;
		expect(() => {
			service = startWatchtowerService(node);
		}).not.toThrow();
		expect(() => service!.stop()).not.toThrow();
	});

	it('startNotificationQueueWorker starts and stops cleanly with no queued rows', () => {
		const worker = startNotificationQueueWorker();
		expect(() => worker.stop()).not.toThrow();
	});

	it('a manual tick against an empty queue never throws', async () => {
		const worker = startNotificationQueueWorker();
		await expect(worker.tickOnce()).resolves.toBeUndefined();
		worker.stop();
	});
});
