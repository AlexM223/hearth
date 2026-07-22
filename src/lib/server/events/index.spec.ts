import { describe, expect, it, vi } from 'vitest';
import { eventBus, connectionCount, publish, register, type LiveConnection } from './index.js';

function makeConn(overrides: Partial<LiveConnection> = {}): LiveConnection & { sent: string[] } {
	const sent: string[] = [];
	const conn: LiveConnection & { sent: string[] } = {
		userId: 1,
		isAdmin: false,
		send: (frame: string) => sent.push(frame),
		sent,
		...overrides
	};
	return conn;
}

describe('events: liveHub scope filtering (the security boundary, DECISIONS.md §4.5)', () => {
	it('a broadcast frame reaches every connection', () => {
		const a = makeConn({ userId: 1 });
		const b = makeConn({ userId: 2 });
		const unregisterA = register(a);
		const unregisterB = register(b);

		publish('block', { kind: 'broadcast' }, { height: 900_000 });

		expect(a.sent).toHaveLength(1);
		expect(b.sent).toHaveLength(1);
		unregisterA();
		unregisterB();
	});

	it('a user-scoped frame reaches ONLY that user -- never a broadcast-only client', () => {
		const owner = makeConn({ userId: 1, isAdmin: true });
		const member = makeConn({ userId: 2, isAdmin: false });
		const unregisterOwner = register(owner);
		const unregisterMember = register(member);

		publish('wallet', { kind: 'user', userId: 2 }, { balance: 12345 });

		expect(owner.sent).toHaveLength(0);
		expect(member.sent).toHaveLength(1);
		unregisterOwner();
		unregisterMember();
	});

	it('an admin-scoped frame reaches only isAdmin connections', () => {
		const owner = makeConn({ userId: 1, isAdmin: true });
		const member = makeConn({ userId: 2, isAdmin: false });
		const unregisterOwner = register(owner);
		const unregisterMember = register(member);

		publish('mining:pool', { kind: 'admin' }, { hashrate: 123 });

		expect(owner.sent).toHaveLength(1);
		expect(member.sent).toHaveLength(0);
		unregisterOwner();
		unregisterMember();
	});

	it('unregister makes a connection stop receiving frames', () => {
		const conn = makeConn();
		const unregister = register(conn);
		publish('block', { kind: 'broadcast' }, {});
		expect(conn.sent).toHaveLength(1);

		unregister();
		publish('block', { kind: 'broadcast' }, {});
		expect(conn.sent).toHaveLength(1); // unchanged
	});

	it('a send() that throws for one connection never blocks fan-out to the others', () => {
		const broken = makeConn({
			send: () => {
				throw new Error('client stream already closed');
			}
		});
		const healthy = makeConn({ userId: 2 });
		const unregisterBroken = register(broken);
		const unregisterHealthy = register(healthy);

		expect(() => publish('block', { kind: 'broadcast' }, { height: 1 })).not.toThrow();
		expect(healthy.sent).toHaveLength(1);

		unregisterBroken();
		unregisterHealthy();
	});

	it('idle-cost-zero: publish() is a no-op (skips JSON.stringify) with zero connections', () => {
		expect(connectionCount()).toBe(0);
		const spy = vi.spyOn(JSON, 'stringify');
		publish('mempool', { kind: 'broadcast' }, { huge: 'payload' });
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('events: publish() never reads SQLite (structural invariant)', () => {
	it('publish is a plain synchronous function with no db import in this module', async () => {
		// Structural check: this module must not import the db layer at all --
		// the two cairn SSE-stall incidents were caused by exactly that. If a
		// future edit adds `import ... from '../db/...'` to events/index.ts,
		// this test's source-scan (not just runtime behavior) should be revisited.
		const src = await import('node:fs').then((fs) =>
			fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
		);
		expect(src).not.toMatch(/from ['"]\.\.\/db/);
	});

	it('publish() returns synchronously (never awaits) even with connections registered', () => {
		const conn = makeConn();
		const unregister = register(conn);
		const result = publish('block', { kind: 'broadcast' }, { height: 1 });
		expect(result).toBeUndefined(); // void, not a Promise
		unregister();
	});
});

describe('events: eventBus', () => {
	it('emits a "frame" event alongside fan-out, for diagnostics/tests', () => {
		const handler = vi.fn();
		eventBus.once('frame', handler);
		const conn = makeConn();
		const unregister = register(conn);
		publish('block', { kind: 'broadcast' }, { ok: true });
		expect(handler).toHaveBeenCalledTimes(1);
		unregister();
	});
});
