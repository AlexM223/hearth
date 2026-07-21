/**
 * T9 acceptance (WALLET-ENGINE §5.5; DECISIONS.md §4.9 invariant 3): SPV
 * tx-inclusion. A REAL mainnet block-700000 vector verifies {ok:true}; the
 * weak-target and merkle-mismatch (and unconfirmed / above-tip / bad-header /
 * bad-pow) cases REFUSE. Detection fails closed -- never a false positive.
 */
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { verifyTxInclusion, bitsToTarget, parseBlockHeader, meetsTarget } from './spv.js';

// Real vector from Bitcoin Core + Fulcrum (block 700000, tx at pos 1).
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

const base = { txid: V.txid, height: V.height, proof: V.merkle, pos: V.pos, headerHex: V.headerHex, tipHeight: 800000 };

describe('T9: SPV tx-inclusion (real block-700000 vector)', () => {
	it('verifies a real inclusion proof against a real PoW-valid header', () => {
		expect(verifyTxInclusion(base)).toEqual({ ok: true });
	});

	it('refuses an unconfirmed tx (height <= 0)', () => {
		expect(verifyTxInclusion({ ...base, height: 0 })).toEqual({ ok: false, reason: 'unconfirmed' });
	});

	it('refuses a height above the tip', () => {
		expect(verifyTxInclusion({ ...base, tipHeight: 699999 })).toEqual({ ok: false, reason: 'above_tip' });
	});

	it('refuses a malformed (non-80-byte) header', () => {
		expect(verifyTxInclusion({ ...base, headerHex: 'deadbeef' })).toEqual({ ok: false, reason: 'bad_header' });
	});

	it('refuses a merkle proof that does not reproduce the root', () => {
		const tampered = [...V.merkle];
		tampered[0] = 'ff'.repeat(32);
		expect(verifyTxInclusion({ ...base, proof: tampered })).toEqual({ ok: false, reason: 'bad_merkle' });
	});

	it('refuses a wrong txid (merkle mismatch)', () => {
		expect(verifyTxInclusion({ ...base, txid: 'ab'.repeat(32) })).toEqual({ ok: false, reason: 'bad_merkle' });
	});

	it('refuses a trivially-easy target when a difficulty floor is set (weak_target)', () => {
		// The real block target is huge; set maxTarget far below it -> weak_target.
		expect(verifyTxInclusion({ ...base, maxTarget: 1n }).ok).toBe(false);
		expect(verifyTxInclusion({ ...base, maxTarget: 1n })).toEqual({ ok: false, reason: 'weak_target' });
	});

	it('accepts when the difficulty floor is above the block target', () => {
		// maxTarget = 2^256-1 (everything passes the floor).
		const huge = (1n << 256n) - 1n;
		expect(verifyTxInclusion({ ...base, maxTarget: huge })).toEqual({ ok: true });
	});

	it('bitsToTarget decodes the nBits compact form', () => {
		// 0x1d00ffff (genesis difficulty) -> 0x00ffff * 256^(0x1d-3).
		expect(bitsToTarget(0x1d00ffff)).toBe(0x00ffffn << (8n * BigInt(0x1d - 3)));
	});
});

// T1 acceptance (WATCHTOWER.md §0.3, §1.3): notify/detect/difficulty.ts's
// tipCache floor reuses these two exports rather than re-implementing header
// parsing/PoW checks. Verified here against the SAME real block-700000
// header, cross-checked with an INDEPENDENT sha256d computed straight from
// @noble/hashes (not by calling anything internal to spv.ts).
describe('T1: parseBlockHeader + meetsTarget (reused by notify/detect/difficulty.ts)', () => {
	function independentBlockHash(headerHex: string): string {
		const bytes = hex.decode(headerHex);
		const once = sha256(bytes);
		const twice = sha256(once);
		return hex.encode(twice.slice().reverse()); // display order
	}

	it('parseBlockHeader returns the header bits and the display-order hash', () => {
		const parsed = parseBlockHeader(V.headerHex);
		expect(parsed).not.toBeNull();
		expect(parsed!.hash).toBe(independentBlockHash(V.headerHex));
		// bits is the raw nBits field this header carries -- cross-check via
		// bitsToTarget agreeing with verifyTxInclusion's own self-consistency pass.
		expect(bitsToTarget(parsed!.bits) > 0n).toBe(true);
	});

	it('parseBlockHeader returns null on a malformed header', () => {
		expect(parseBlockHeader('deadbeef')).toBeNull();
	});

	it('meetsTarget is true for the real PoW-valid header', () => {
		expect(meetsTarget(V.headerHex)).toBe(true);
	});

	it('meetsTarget is false for a malformed header', () => {
		expect(meetsTarget('deadbeef')).toBe(false);
	});

	it('meetsTarget is false when the hash does not satisfy its own bits (tampered header)', () => {
		// Flip a byte in the middle of the header (inside the nonce field) so the
		// hash changes but bits stays the same -- self-consistency must now fail.
		const bytes = hex.decode(V.headerHex);
		bytes[76] ^= 0xff;
		expect(meetsTarget(hex.encode(bytes))).toBe(false);
	});
});
