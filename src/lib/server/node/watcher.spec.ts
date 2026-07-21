import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBlockWatcher } from './watcher.js';
import { register, publish } from '../events/index.js';
import type { NodeClient } from './index.js';

/**
 * A minimal stand-in for NodeClient's shape the watcher actually touches
 * (`.electrum` as an EventEmitter with headersSubscribe(), `.coreRpc` for the
 * polling fallback) -- constructing a real NodeClient would open real
 * sockets. Structural typing + a cast keeps this a true unit test of
 * watcher.ts's own logic.
 */
function fakeNodeClient(headersSubscribe: () => Promise<{ height: number; hex: string }>) {
	const electrum = new EventEmitter() as EventEmitter & { headersSubscribe: typeof headersSubscribe };
	electrum.headersSubscribe = headersSubscribe;
	return { electrum, coreRpc: {} } as unknown as NodeClient;
}

describe('node: block watcher (DECISIONS.md §4.5 -- Electrum push, Core RPC poll fallback)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('publishes a `block` SSE frame the instant Electrum pushes a new header (sub-2s propagation)', async () => {
		const node = fakeNodeClient(() => Promise.resolve({ height: 900_000, hex: '' }));
		const watcher = startBlockWatcher(node);
		// Let the initial headersSubscribe() prime resolve.
		await new Promise((r) => setImmediate(r));

		const sent: string[] = [];
		const unregister = register({ userId: 1, isAdmin: false, send: (f) => sent.push(f) });

		const start = performance.now();
		node.electrum.emit('header', { height: 900_001 });
		const elapsedMs = performance.now() - start;

		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain('event: block');
		expect(sent[0]).toContain('"height":900001');
		// The whole call chain (header event -> publishBlock -> eventBus.publish
		// -> conn.send) is synchronous -- comfortably inside the ~2s acceptance
		// bar (DECISIONS.md §6), typically sub-millisecond.
		expect(elapsedMs).toBeLessThan(2000);

		unregister();
		watcher.stop();
	});

	it('never republishes the same or a lower height (dedupe / no reorg-down noise)', async () => {
		const node = fakeNodeClient(() => Promise.resolve({ height: 900_000, hex: '' }));
		const watcher = startBlockWatcher(node);
		await new Promise((r) => setImmediate(r));

		const sent: string[] = [];
		const unregister = register({ userId: 1, isAdmin: false, send: (f) => sent.push(f) });

		node.electrum.emit('header', { height: 900_001 });
		node.electrum.emit('header', { height: 900_001 }); // duplicate push
		node.electrum.emit('header', { height: 900_000 }); // stale/lower

		expect(sent).toHaveLength(1);

		unregister();
		watcher.stop();
	});

	it('falls back to Core RPC polling when the initial Electrum subscribe fails', async () => {
		vi.useFakeTimers();
		const node = fakeNodeClient(() => Promise.reject(new Error('electrum down')));
		// Stub getBlockCount's underlying rpc.call so the fallback poll resolves
		// without a real network call.
		(node.coreRpc as unknown as { call: () => Promise<number> }).call = vi
			.fn()
			.mockResolvedValue(900_005);

		const sent: string[] = [];
		const unregister = register({ userId: 1, isAdmin: false, send: (f) => sent.push(f) });

		const watcher = startBlockWatcher(node, { pollIntervalMs: 1000 });
		await vi.advanceTimersByTimeAsync(1); // let the rejected headersSubscribe() settle
		await vi.advanceTimersByTimeAsync(1000); // first poll tick
		await vi.advanceTimersByTimeAsync(0);

		expect(sent.some((f) => f.includes('"height":900005'))).toBe(true);

		unregister();
		watcher.stop();
	});
});
