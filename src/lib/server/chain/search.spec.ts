/**
 * Search resolution table test (EXPLORER.md §6, §7 T1) -- mocked Core RPC
 * only, no live node required.
 */
import { describe, expect, it, vi } from 'vitest';
import { classifySearch, withBudget, HEIGHT_RE, HEX64_RE, type SearchNode } from './search.js';

function nodeWith(call: (method: string, params?: unknown[]) => Promise<unknown>): SearchNode {
	return { coreRpc: { call: call as SearchNode['coreRpc']['call'] } };
}

function notFoundError(): Error & { rpcCode: number } {
	const err = new Error('Core RPC error (-5) for getrawtransaction: No such mempool or blockchain transaction');
	return Object.assign(err, { rpcCode: -5 });
}

function connectionError(): Error {
	return new Error('Bitcoin Core RPC connection failed for getrawtransaction: fetch failed');
}

describe('chain/search: classifySearch', () => {
	it('pure height -> block, no rail call fires', async () => {
		const call = vi.fn();
		const node = nodeWith(call);
		expect(HEIGHT_RE.test('934197')).toBe(true);
		await expect(classifySearch('934197', node)).resolves.toEqual({ type: 'block', value: '934197' });
		expect(call).not.toHaveBeenCalled();
	});

	it('a 64-hex hash with 8+ leading zero nibbles skips the lookup (real-PoW heuristic)', async () => {
		const call = vi.fn();
		const node = nodeWith(call);
		const hash = '0'.repeat(10) + 'a'.repeat(54);
		expect(HEX64_RE.test(hash)).toBe(true);
		await expect(classifySearch(hash, node)).resolves.toEqual({ type: 'block', value: hash });
		expect(call).not.toHaveBeenCalled();
	});

	it('an ambiguous 64-hex string resolves to tx when the tx probe finds it', async () => {
		const hash = 'a'.repeat(64);
		const call = vi.fn(async (method: string) => {
			if (method === 'getrawtransaction') return 'deadbeefhex';
			throw notFoundError();
		});
		const node = nodeWith(call);
		await expect(classifySearch(hash, node)).resolves.toEqual({ type: 'tx', value: hash });
	});

	it('an ambiguous 64-hex string resolves to block when only the block probe finds it', async () => {
		const hash = 'b'.repeat(64);
		const call = vi.fn(async (method: string) => {
			if (method === 'getrawtransaction') throw notFoundError();
			if (method === 'getblockheader') return { hash };
			throw new Error('unexpected method');
		});
		const node = nodeWith(call);
		await expect(classifySearch(hash, node)).resolves.toEqual({ type: 'block', value: hash });
	});

	it('an ambiguous 64-hex string neither rail confirms -> unknown (calm empty state)', async () => {
		const hash = 'c'.repeat(64);
		const call = vi.fn(async () => {
			throw notFoundError();
		});
		const node = nodeWith(call);
		await expect(classifySearch(hash, node)).resolves.toEqual({ type: 'unknown', value: hash });
	});

	it('a genuine rail ERROR (not "not found") during the probe prefers tx over a dead end', async () => {
		const hash = 'd'.repeat(64);
		const call = vi.fn(async () => {
			throw connectionError();
		});
		const node = nodeWith(call);
		await expect(classifySearch(hash, node)).resolves.toEqual({ type: 'tx', value: hash });
	});

	it('a probe timeout falls back to tx (the budget fires, never hangs first paint)', async () => {
		const hash = 'e'.repeat(64);
		const call = vi.fn(
			(method: string) =>
				new Promise((resolve) => {
					// Never resolves within the test's lifetime -- withBudget must win.
					if (method === 'getblockheader') setTimeout(() => resolve({}), 10_000);
				})
		);
		const node = nodeWith(call as SearchNode['coreRpc']['call']);
		const result = await classifySearch(hash, node);
		expect(result).toEqual({ type: 'tx', value: hash });
	}, 10_000);

	it('a valid mainnet bech32 address -> address, no rail call', async () => {
		const call = vi.fn();
		const node = nodeWith(call);
		await expect(
			classifySearch('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', node)
		).resolves.toEqual({ type: 'address', value: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' });
		expect(call).not.toHaveBeenCalled();
	});

	it('garbage input -> unknown', async () => {
		const call = vi.fn();
		const node = nodeWith(call);
		await expect(classifySearch('not-a-real-anything', node)).resolves.toEqual({
			type: 'unknown',
			value: 'not-a-real-anything'
		});
		expect(call).not.toHaveBeenCalled();
	});

	it('withBudget resolves a rejected promise to undefined rather than throwing', async () => {
		const [result] = await withBudget(50, [Promise.reject(new Error('boom'))]);
		expect(result).toBeUndefined();
	});

	it('withBudget resolves a slow promise to undefined once the budget elapses', async () => {
		const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 500));
		const [result] = await withBudget(20, [slow]);
		expect(result).toBeUndefined();
	});
});
