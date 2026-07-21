/**
 * Solo job builder: getblocktemplate -> per-miner Stratum job
 * (MINING-ENGINE.md §2.4). Rewritten from the Tessera pool job builder
 * (C:\dev\raffle\pool\src\job.ts) for SOLO mining, via cairn's job.ts: the
 * Tessera winners/finder/OP_RETURN machinery is gone; in its place
 * `personalize({ payoutScript })` produces the single-output coinbase for one
 * miner via coinbase.ts's `buildSoloCoinbaseTx` (the legal hard gate lives
 * there, not here). All byte-order math goes through wire.ts -- never here.
 */
import * as bitcoin from 'bitcoinjs-lib';
import type { AssembledBlock, BuiltJob, CoinbaseVariant, GbtTemplate, Network, StratumJob } from './types.js';
import {
	applyBranches,
	buildHeader,
	displayToInternal,
	headerHashDisplay,
	internalToDisplay,
	merkleBranches,
	sha256d,
	toStratumPrevHash,
	varint
} from './wire.js';
import { buildScriptSigPrefix, buildSoloCoinbaseTx } from './coinbase.js';

/** Extranonce sizes (4 bytes each -- MINING-ENGINE.md §2.3). */
export const EXTRANONCE1_SIZE = 4;
export const EXTRANONCE2_SIZE = 4;
const EXTRANONCE_SIZE = EXTRANONCE1_SIZE + EXTRANONCE2_SIZE;

export interface JobConfig {
	readonly network: Network;
	readonly poolTag: string;
	readonly jobId: string;
	readonly cleanJobs: boolean;
}

/** Unsigned 32-bit value -> 8-char BE hex exactly as carried in Stratum messages. */
function beHex32(n: number, what: string): string {
	if (!Number.isInteger(n)) throw new Error(`${what} must be an integer`);
	return (n >>> 0).toString(16).padStart(8, '0');
}

/** Strict hex -> bytes with an exact length requirement (validate before parse). */
function hexToBytes(hex: string, expectedLen: number, what: string): Buffer {
	if (hex.length !== expectedLen * 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
		throw new Error(`${what} must be ${expectedLen * 2} hex chars, got "${hex}"`);
	}
	return Buffer.from(hex, 'hex');
}

export function buildJob(template: GbtTemplate, cfg: JobConfig): BuiltJob {
	// Validate the fields we slot directly into the header.
	hexToBytes(template.bits, 4, 'template.bits');
	const coinbaseValueSats = BigInt(template.coinbasevalue);
	if (coinbaseValueSats < 0n) throw new Error('coinbase value must be non-negative');
	if (!Number.isInteger(template.height) || template.height < 0 || template.height > 0xffffffff) {
		throw new Error(`template height out of range: ${template.height}`);
	}

	// ── Shared across every per-miner variant ─────────────────────────────
	const witnessCommitment = template.default_witness_commitment ?? null;
	const branches = merkleBranches(template.transactions.map((t) => displayToInternal(t.txid)));
	const txData = template.transactions.map((t) => Buffer.from(t.data, 'hex'));
	const versionHex = beHex32(template.version, 'template.version');
	const nbitsHex = template.bits.toLowerCase();
	const ntimeHex = beHex32(template.curtime, 'template.curtime');
	const prevHashStratum = toStratumPrevHash(template.previousblockhash);

	// scriptSig = BIP34 heightPush ‖ tag ‖ EN1 ‖ EN2 -- shared by every variant
	// (the payout changes only an OUTPUT, never the input script), so the
	// extranonce split offset is identical for all miners.
	const { scriptPrefix, scriptLen } = buildScriptSigPrefix(template.height, cfg.poolTag, EXTRANONCE_SIZE);
	const en1Offset = 4 + 1 + 36 + varint(scriptLen).length + scriptPrefix.length;

	/**
	 * Build one miner's coinbase variant: exactly one value-bearing output
	 * (the miner's payout script, full coinbase value) plus the zero-value
	 * witness commitment -- coinbase.ts asserts conservation/shape.
	 */
	const makeVariant = (payoutScript: Uint8Array): CoinbaseVariant => {
		const tx = buildSoloCoinbaseTx({
			scriptPrefix,
			extranoncePlaceholder: Buffer.alloc(EXTRANONCE_SIZE, 0),
			payoutScript,
			coinbaseValueSats,
			witnessCommitmentHex: witnessCommitment
		});

		const serialized = tx.toBuffer(); // no witness set -> legacy bytes
		if (!serialized.subarray(en1Offset, en1Offset + EXTRANONCE_SIZE).equals(Buffer.alloc(EXTRANONCE_SIZE, 0))) {
			throw new Error('extranonce split offset mismatch'); // defense in depth
		}
		const coinb1 = serialized.subarray(0, en1Offset);
		const coinb2 = serialized.subarray(en1Offset + EXTRANONCE_SIZE);

		const coinbaseFor = (en1Hex: string, en2Hex: string): Buffer =>
			Buffer.concat([
				coinb1,
				hexToBytes(en1Hex, EXTRANONCE1_SIZE, 'extranonce1'),
				hexToBytes(en2Hex, EXTRANONCE2_SIZE, 'extranonce2'),
				coinb2
			]);

		const headerFor = (en1Hex: string, en2Hex: string, ntimeArg: string, nonceHex: string): Buffer => {
			const coinbaseTxidLE = sha256d(coinbaseFor(en1Hex, en2Hex));
			const root = applyBranches(coinbaseTxidLE, branches);
			return buildHeader(versionHex, template.previousblockhash, root, ntimeArg, nbitsHex, nonceHex);
		};

		const assemble = (en1Hex: string, en2Hex: string, ntimeArg: string, nonceHex: string): AssembledBlock => {
			const header = headerFor(en1Hex, en2Hex, ntimeArg, nonceHex);
			const legacyCoinbase = coinbaseFor(en1Hex, en2Hex);
			const coinbaseTxidDisplay = internalToDisplay(sha256d(legacyCoinbase));
			let coinbaseSerialized = legacyCoinbase;
			if (witnessCommitment) {
				const cb = bitcoin.Transaction.fromHex(legacyCoinbase.toString('hex'));
				cb.setWitness(0, [Buffer.alloc(32)]);
				coinbaseSerialized = cb.toBuffer();
			}
			const block = Buffer.concat([header, varint(1 + txData.length), coinbaseSerialized, ...txData]);
			return {
				blockHex: block.toString('hex'),
				blockHashDisplay: headerHashDisplay(header),
				coinbaseTxidDisplay
			};
		};

		return { coinb1Hex: coinb1.toString('hex'), coinb2Hex: coinb2.toString('hex'), headerFor, assemble };
	};

	const job: StratumJob = {
		jobId: cfg.jobId,
		prevHashDisplay: template.previousblockhash,
		prevHashStratum,
		merkleBranchesInternalHex: branches.map((b) => b.toString('hex')),
		versionHex,
		nbitsHex,
		ntimeHex,
		height: template.height,
		coinbaseValueSats,
		cleanJobs: cfg.cleanJobs
	};

	return {
		job,
		personalize: ({ payoutScript }) => makeVariant(payoutScript)
	};
}
