import { describe, expect, it, vi } from 'vitest';
import { resolvePrevouts, prevoutKey } from './prevout.js';
import type { RpcCaller } from '../node/core/rpc.js';

function rpcFrom(call: (...args: unknown[]) => Promise<unknown>): RpcCaller {
	return { call: call as RpcCaller['call'] };
}

function rawTx(vouts: { address?: string; value: number }[]) {
	return {
		txid: 'parent',
		hash: 'parent',
		version: 2,
		size: 200,
		vsize: 150,
		weight: 600,
		locktime: 0,
		vin: [],
		vout: vouts.map((v, n) => ({
			value: v.value,
			n,
			scriptPubKey: { asm: '', hex: '', address: v.address, type: 'witness_v0_keyhash' }
		})),
		hex: ''
	};
}

describe('chain/prevout: resolvePrevouts', () => {
	it('resolves address/value for a simple ref', async () => {
		const call = vi.fn(async () => rawTx([{ address: 'bc1qexample', value: 0.001 }]));
		const rpc: RpcCaller = rpcFrom(call);
		const refs = [{ txid: 'parent', vout: 0 }];
		const resolved = await resolvePrevouts(rpc, refs);
		expect(resolved.get(prevoutKey(refs[0]))).toEqual({ address: 'bc1qexample', value: 100_000 });
	});

	it('dedupes repeated parent txids -- one fetch even if referenced twice', async () => {
		const call = vi.fn(async () => rawTx([{ value: 0.0005 }, { value: 0.0007 }]));
		const rpc: RpcCaller = rpcFrom(call);
		const refs = [
			{ txid: 'parent', vout: 0 },
			{ txid: 'parent', vout: 1 }
		];
		const resolved = await resolvePrevouts(rpc, refs);
		expect(call).toHaveBeenCalledTimes(1);
		expect(resolved.get(prevoutKey(refs[0]))?.value).toBe(50_000);
		expect(resolved.get(prevoutKey(refs[1]))?.value).toBe(70_000);
	});

	it('a parent fetch failure leaves the ref absent from the map (never throws)', async () => {
		const call = vi.fn(async () => {
			throw new Error('not found');
		});
		const rpc: RpcCaller = rpcFrom(call);
		const refs = [{ txid: 'missing', vout: 0 }];
		await expect(resolvePrevouts(rpc, refs)).resolves.toEqual(new Map());
	});

	it('a vout index the parent does not have is absent, never a thrown/undefined crash', async () => {
		const call = vi.fn(async () => rawTx([{ value: 0.001 }]));
		const rpc: RpcCaller = rpcFrom(call);
		const refs = [{ txid: 'parent', vout: 5 }];
		const resolved = await resolvePrevouts(rpc, refs);
		expect(resolved.size).toBe(0);
	});

	it('a null-address prevout (unrecognized script) resolves address:null, not a crash', async () => {
		const call = vi.fn(async () => rawTx([{ value: 0.002 }])); // no address key
		const rpc: RpcCaller = rpcFrom(call);
		const refs = [{ txid: 'parent', vout: 0 }];
		const resolved = await resolvePrevouts(rpc, refs);
		expect(resolved.get(prevoutKey(refs[0]))).toEqual({ address: null, value: 200_000 });
	});
});
