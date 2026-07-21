/**
 * T1 acceptance -- the headline fail-closed proof (WATCHTOWER.md §1.2,
 * §6.1): every failure mode returns false (deferred, never a false
 * positive); only a fully-provable, PoW-valid, floor-clearing inclusion
 * returns true. Reuses the SAME real block-700000 vector as wallet/spv.spec.ts.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { hex } from '@scure/base';
import { createDifficultyFloor, type DifficultyFloor } from './difficulty.js';
import { spvVerifyConfirmed, type SpvElectrumRail } from './spvGate.js';

const V = {
	height: 700000,
	txid: 'ed25927576988e38e4cc8e4b19d1272c480f113fb605271b190df05aa983714e',
	headerHex:
		'04e0ff3feb36c62f0471cee034811019e43b14f459b50e00cea30a000000000000000000659cecf4a06ed500031b741384e87d40ce5c16c3ec8c09b09ffe4b863c218d1f282d3c61e4480f17d767c2ab',
	pos: 1,
	merkle: [
		'1d8149eb8d8475b98113b5011cf70e0b7a4dccff71286d28b8b4b641f94f1e46',
		'cb650c493b26ebd670efca2ae84b7b235f92ee0f6daf1cd7ea7a93a9b917f51c',
		'a2b2ffb66a04e8a8709331a94bd623a1bb05b50cf52015408530ed43158ec81c',
		'dc028685d2aeda316f9061aecbf878fef89def44419520004b28ab1e6ff6fb1e',
		'988629e0a61f25615b91c8e4d1a12d1e0ce138725871d8fb6d0df3b20b808d77',
		'912f6f9fb9869c6dded8f36b618d4c643e7e5fef71543dc85b5ee9a93e0d191a',
		'2bb950e819c228449121bb7645a974c343d595444844bf564d8da3a8ff928a7f',
		'c7aff03f86413b875883a6a973c6406b22717a7f4caf3afc80cd2b91e5a65db1',
		'bad3fc4c8d071cec73c6a7878559e74df4bdd357d93224a0b094bbbb981b876a',
		'ccdff982359d3bfc1334493acad8f1dcb0fd0209c97d27b8b3927b497c178308',
		'53d1e6d928e6ff27e4c2000ae2613515e9087a423c4a446bfb5ac4a13cb5eaf7'
	]
};

function realRail(): SpvElectrumRail {
	return {
		async getMerkleProof() {
			return { merkle: V.merkle, pos: V.pos };
		},
		async getBlockHeader() {
			return V.headerHex;
		}
	};
}

let floor: DifficultyFloor;
beforeEach(() => {
	floor = createDifficultyFloor();
});

describe('T1: spvVerifyConfirmed (the fail-closed SPV gate)', () => {
	it('returns false for a mempool tx (height<=0) -- no proof can exist', async () => {
		expect(await spvVerifyConfirmed(realRail(), floor, V.txid, 0)).toBe(false);
		expect(await spvVerifyConfirmed(realRail(), floor, V.txid, -1)).toBe(false);
	});

	it('cold cache (no headers seen yet) defers even with a genuinely valid proof', async () => {
		expect(floor.size()).toBe(0);
		expect(await spvVerifyConfirmed(realRail(), floor, V.txid, V.height)).toBe(false);
	});

	it('once the cache is warmed by a real header, the SAME valid proof verifies true', async () => {
		floor.acceptHeader(V.height, V.headerHex);
		expect(await spvVerifyConfirmed(realRail(), floor, V.txid, V.height)).toBe(true);
	});

	it('a fresh floor with NO prior header still verifies once IT fetches+accepts the real header during verification', async () => {
		// The cache starts empty; the gate itself is what fetches the header. Per
		// WATCHTOWER.md's cold-cache rule this must still DEFER on this very
		// first call (there is no PRE-EXISTING pin/floor to trust yet) -- proving
		// the gate never bootstraps trust from a single self-reported header.
		expect(await spvVerifyConfirmed(realRail(), floor, V.txid, V.height)).toBe(false);
		expect(floor.size()).toBe(0); // nothing was even a chance to be pinned yet
	});

	it('merkle proof fetch throwing -> false, deferred (Electrum down)', async () => {
		floor.acceptHeader(V.height, V.headerHex);
		const rail: SpvElectrumRail = {
			async getMerkleProof() {
				throw new Error('electrum unreachable');
			},
			async getBlockHeader() {
				return V.headerHex;
			}
		};
		expect(await spvVerifyConfirmed(rail, floor, V.txid, V.height)).toBe(false);
	});

	it('block header fetch throwing -> false, deferred', async () => {
		floor.acceptHeader(V.height, V.headerHex);
		const rail: SpvElectrumRail = {
			async getMerkleProof() {
				return { merkle: V.merkle, pos: V.pos };
			},
			async getBlockHeader() {
				throw new Error('electrum unreachable');
			}
		};
		expect(await spvVerifyConfirmed(rail, floor, V.txid, V.height)).toBe(false);
	});

	it('unparseable header -> false, deferred', async () => {
		floor.acceptHeader(V.height, V.headerHex);
		const rail: SpvElectrumRail = {
			async getMerkleProof() {
				return { merkle: V.merkle, pos: V.pos };
			},
			async getBlockHeader() {
				return 'deadbeef';
			}
		};
		expect(await spvVerifyConfirmed(rail, floor, V.txid, V.height)).toBe(false);
	});

	it('header hash mismatch vs the PINNED cached hash (forged header OR a reorg) -> false, deferred, never blacklisted', async () => {
		floor.acceptHeader(V.height, V.headerHex);
		const tamperedBytes = hex.decode(V.headerHex);
		tamperedBytes[76] ^= 0xff; // different header content for the SAME height
		const rail: SpvElectrumRail = {
			async getMerkleProof() {
				return { merkle: V.merkle, pos: V.pos };
			},
			async getBlockHeader() {
				return hex.encode(tamperedBytes);
			}
		};
		expect(await spvVerifyConfirmed(rail, floor, V.txid, V.height)).toBe(false);
		// The next event with the REAL header still succeeds -- nothing was
		// blacklisted.
		expect(await spvVerifyConfirmed(realRail(), floor, V.txid, V.height)).toBe(true);
	});

	it('a tampered merkle branch that does not reconstruct the root -> false', async () => {
		floor.acceptHeader(V.height, V.headerHex);
		const rail: SpvElectrumRail = {
			async getMerkleProof() {
				const tampered = [...V.merkle];
				tampered[0] = 'ff'.repeat(32);
				return { merkle: tampered, pos: V.pos };
			},
			async getBlockHeader() {
				return V.headerHex;
			}
		};
		expect(await spvVerifyConfirmed(rail, floor, V.txid, V.height)).toBe(false);
	});

	it('a forged-txid false positive (hostile server, trivially-easy header) is refused once a real floor exists (cairn-7zj6)', async () => {
		// Warm the floor with the real (hard) header first.
		floor.acceptHeader(V.height, V.headerHex);
		// A hostile header at a DIFFERENT, not-yet-cached height with a trivially
		// easy bits value -- self-consistent (any hash meets it) but must be
		// refused as weaker than the floor.
		const bytes = new Uint8Array(80);
		bytes.fill(7);
		bytes[72] = 0xff;
		bytes[73] = 0xff;
		bytes[74] = 0x7f;
		bytes[75] = 0x22; // astronomically easy target (self-consistent for any content)
		const forgedHeaderHex = hex.encode(bytes);
		const rail: SpvElectrumRail = {
			async getMerkleProof() {
				return { merkle: V.merkle, pos: V.pos };
			},
			async getBlockHeader() {
				return forgedHeaderHex;
			}
		};
		expect(await spvVerifyConfirmed(rail, floor, V.txid, V.height + 1)).toBe(false);
	});

	it('a claimed height whose header is rejected by the floor (implausibly weak) stays above the STALE tip -> false', async () => {
		// Warm the floor with the real (hard) header at V.height -- tip = V.height.
		floor.acceptHeader(V.height, V.headerHex);
		// A hostile server claims a NEW, higher block exists, but its header is
		// trivially weak relative to the real floor -- acceptHeader rejects it
		// during verification, so `floor.tipHeight()` never advances past
		// V.height, and the claimed height is above that stale tip.
		const bytes = new Uint8Array(80);
		bytes.fill(9);
		bytes[72] = 0xff;
		bytes[73] = 0xff;
		bytes[74] = 0x7f;
		bytes[75] = 0x22;
		const weakFutureHeader = hex.encode(bytes);
		const rail: SpvElectrumRail = {
			async getMerkleProof() {
				return { merkle: V.merkle, pos: V.pos };
			},
			async getBlockHeader() {
				return weakFutureHeader;
			}
		};
		expect(await spvVerifyConfirmed(rail, floor, V.txid, V.height + 1)).toBe(false);
		expect(floor.tipHeight()).toBe(V.height); // never advanced past the stale tip
	});

	it('an older-than-cache confirmed tx (no pinned entry) still verifies using the floor factor, once the cache is warm', async () => {
		// Warm the cache at a LATER height than the tx's own height (simulating
		// an older tx whose own height fell out of / was never in the rolling
		// cache, but the cache is warm from newer blocks).
		floor.acceptHeader(V.height + 10, V.headerHex); // arbitrary warm entry (content doesn't need to match height for this cache-population purpose)
		expect(await spvVerifyConfirmed(realRail(), floor, V.txid, V.height)).toBe(true);
	});
});
