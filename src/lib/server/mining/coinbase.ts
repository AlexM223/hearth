/**
 * Solo coinbase builder -- the non-custodial hard gate (DECISIONS.md §4.6,
 * §4.9 "the coinbase-split is KILLED"; MINING-ENGINE.md §3.2). Builds:
 *
 *   in[0]  prevout 0×32:0xffffffff, scriptSig = BIP34(height) ‖ poolTag ‖ EN1(4B) ‖ EN2(4B)
 *   out[0] THE single value-bearing output: full coinbasevalue → the finder's payout script
 *   out[1] SegWit witness-commitment (zero value)   ← only if the template supplies one
 *
 * ASSERTIONS IN CODE (the executable form of the coinbase-split kill, never
 * assumed): exactly one value-bearing output, and value conservation
 * (Σ outputs == coinbasevalue). Both throw rather than silently building a
 * split or short-changed coinbase.
 *
 * Rewritten from the Tessera pool core coinbase builder
 * (C:\dev\raffle\core\src\coinbase.ts's buildCoinbaseTransaction, via cairn's
 * job.ts makeVariant) for SOLO mining: Tessera's winners/finder-bounty/
 * OP_RETURN-commitment machinery is gone entirely -- there is no reward
 * splitting of any kind here, ever.
 *
 * ECC-free throughout (address.ts's addressToOutputScript); ONLY the
 * bitcoinjs `Transaction` structural API is used (no ECC init needed for
 * building/serializing an unsigned, witness-less coinbase).
 */
import * as bitcoin from 'bitcoinjs-lib';

/** Consensus limit on the coinbase scriptSig. */
export const MAX_SCRIPTSIG_SIZE = 100;

export interface ScriptSigPrefix {
	/** BIP34 minimal height push ‖ the (possibly trimmed) ASCII pool tag. */
	readonly scriptPrefix: Buffer;
	/** scriptPrefix.length + extranonceSize -- the full scriptSig length once
	 *  the extranonce bytes are appended. Asserted ≤ MAX_SCRIPTSIG_SIZE. */
	readonly scriptLen: number;
}

/**
 * BIP34 height push ‖ ASCII pool tag, trimmed so the FULL scriptSig
 * (prefix + extranonce) never exceeds the 100-byte consensus limit. The tag
 * is what gets trimmed -- the height push is never touched (BIP34 requires
 * it verbatim). Shared by every per-miner coinbase variant: the input script
 * doesn't depend on the payout, so this is computed ONCE per job.
 */
export function buildScriptSigPrefix(height: number, poolTag: string, extranonceSize: number): ScriptSigPrefix {
	if (!Number.isInteger(height) || height < 0 || height > 0xffffffff) {
		throw new Error(`blockHeight out of range: ${height}`);
	}
	const heightPush = bitcoin.script.compile([bitcoin.script.number.encode(height)]);
	let tag = Buffer.from(poolTag, 'ascii');
	if (heightPush.length + tag.length + extranonceSize > MAX_SCRIPTSIG_SIZE) {
		tag = tag.subarray(0, Math.max(0, MAX_SCRIPTSIG_SIZE - heightPush.length - extranonceSize));
	}
	const scriptPrefix = Buffer.concat([heightPush, tag]);
	const scriptLen = scriptPrefix.length + extranonceSize;
	if (scriptLen > MAX_SCRIPTSIG_SIZE) {
		// Defense in depth: an over-limit scriptSig is a consensus violation the
		// network rejects silently. Assert the trim actually worked.
		throw new Error(`scriptSig ${scriptLen} exceeds consensus limit ${MAX_SCRIPTSIG_SIZE}`);
	}
	return { scriptPrefix, scriptLen };
}

export interface SoloCoinbaseInput {
	/** From {@link buildScriptSigPrefix} -- shared across every miner's variant. */
	readonly scriptPrefix: Buffer;
	/** The extranonce placeholder bytes appended after scriptPrefix (all-zero
	 *  when building the template variant that job.ts splits into coinb1/
	 *  coinb2; the miner's real en1‖en2 is spliced in at that split point). */
	readonly extranoncePlaceholder: Buffer;
	/** THE finder's payout script -- the one and only value-bearing output. */
	readonly payoutScript: Uint8Array;
	readonly coinbaseValueSats: bigint;
	/** `default_witness_commitment` scriptPubKey hex from getblocktemplate, or
	 *  null when the template supplied none. */
	readonly witnessCommitmentHex: string | null;
}

function toSatsNumber(v: bigint): number {
	if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`sats out of range: ${v}`);
	return Number(v);
}

/**
 * The legal hard gate, as a standalone, directly-testable assertion (the
 * executable form of the coinbase-split kill, DECISIONS.md §4.9): exactly one
 * value-bearing output carrying the full `coinbaseValueSats`, plus at most a
 * zero-value witness-commitment output. Throws (never silently degrades) on
 * either violation:
 *  - `solo coinbase has N value-bearing outputs — splitting is forbidden` (N > 1)
 *  - `value conservation violated: outputs X != coinbase Y`
 *
 * Exported separately from {@link buildSoloCoinbaseTx} (which always builds a
 * shape that already satisfies this, so the throw is unreachable through that
 * function alone) so the guard itself has a direct unit test against a
 * hand-crafted, deliberately-split transaction -- MINING-ENGINE.md §9.1's "a
 * solo coinbase with a second value output throws" is otherwise untestable
 * dead code from the public builder's perspective.
 */
export function assertSoloCoinbaseShape(tx: bitcoin.Transaction, coinbaseValueSats: bigint): void {
	const valueOuts = tx.outs.filter((o) => BigInt(o.value) > 0n);
	if (valueOuts.length > 1) {
		throw new Error(`solo coinbase has ${valueOuts.length} value-bearing outputs — splitting is forbidden`);
	}
	const total = tx.outs.reduce((sum, o) => sum + BigInt(o.value), 0n);
	if (total !== coinbaseValueSats) {
		throw new Error(`value conservation violated: outputs ${total} != coinbase ${coinbaseValueSats}`);
	}
}

/**
 * Build the solo coinbase transaction and assert its shape via
 * {@link assertSoloCoinbaseShape}. These fire at job-build/personalize time --
 * inside the pool's serialized queue (miningPool.ts), whose `.catch` records
 * a fatal -- they NEVER crash the process (invariant 4).
 */
export function buildSoloCoinbaseTx(input: SoloCoinbaseInput): bitcoin.Transaction {
	const tx = new bitcoin.Transaction();
	tx.version = 2;
	tx.addInput(
		Buffer.alloc(32, 0),
		0xffffffff,
		0xffffffff,
		Buffer.concat([input.scriptPrefix, input.extranoncePlaceholder])
	);
	// THE single value-bearing output: the full reward to the miner's script.
	tx.addOutput(Buffer.from(input.payoutScript), toSatsNumber(input.coinbaseValueSats));
	// SegWit witness-commitment output (zero value, so conservation holds).
	if (input.witnessCommitmentHex) {
		tx.addOutput(Buffer.from(input.witnessCommitmentHex, 'hex'), 0);
	}

	assertSoloCoinbaseShape(tx, input.coinbaseValueSats);

	return tx;
}
