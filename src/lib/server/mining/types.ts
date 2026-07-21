/**
 * Shared types for the Hearth solo mining engine (src/lib/server/mining).
 * Adapted as a pattern from cairn's mining/types.ts (SV2-specific fields
 * dropped entirely -- M8, not built here per DECISIONS.md §4.6/MINING-
 * ENGINE.md §9.4: the SV2 *settings keys* are reserved in settings.ts, but no
 * listener, and nothing here, exists for it in M5).
 *
 * SOLO POOL INVARIANT (the legal hard gate, DECISIONS.md §4.9): every job's
 * coinbase pays exactly ONE value-bearing output -- the authorized miner's own
 * payout script, carrying the FULL template coinbase value -- plus the
 * zero-value SegWit witness-commitment output. There is NO reward splitting
 * of any kind: the block finder keeps the entire reward.
 */
import type * as bitcoin from 'bitcoinjs-lib';

export type Network = bitcoin.networks.Network;

// ---------------------------------------------------------------------------
// Authorization contract
// ---------------------------------------------------------------------------

/**
 * One authorized miner. `miningId` is the Stratum username token a miner
 * authorizes with (`<miningId>.<workerName>`); it resolves to the owning
 * Hearth user, the wallet that receives the block reward, and that wallet's
 * current receive address (pre-encoded to an output script so the hot path
 * never re-derives it). The coinbase for this miner's jobs pays
 * `payoutScript` the FULL coinbase value and nothing else.
 */
export interface MinerAuth {
	readonly userId: number;
	readonly miningId: string;
	readonly walletId: number;
	readonly address: string;
	readonly payoutScript: Uint8Array;
}

/**
 * Synchronous, zero-I/O resolver from a Stratum miningId to its MinerAuth.
 * The real implementation (authTable.ts) is an in-memory snapshot the
 * integration layer refreshes out-of-band; the engine calls `resolve` inside
 * the socket data handler and MUST NOT block on I/O there. Returns null for
 * an unknown/revoked miningId (the connection is then rejected UNAUTHORIZED).
 */
export interface AuthProvider {
	resolve(miningId: string): MinerAuth | null;
}

/** Trivial map-backed AuthProvider -- the test/QA-harness implementation. */
export class MapAuthProvider implements AuthProvider {
	private readonly map = new Map<string, MinerAuth>();

	constructor(entries?: Iterable<MinerAuth>) {
		if (entries) for (const e of entries) this.map.set(e.miningId, e);
	}

	set(auth: MinerAuth): void {
		this.map.set(auth.miningId, auth);
	}

	delete(miningId: string): void {
		this.map.delete(miningId);
	}

	resolve(miningId: string): MinerAuth | null {
		return this.map.get(miningId) ?? null;
	}
}

// ---------------------------------------------------------------------------
// Engine events (typed callbacks the engine emits)
// ---------------------------------------------------------------------------

/**
 * An accepted share. `difficulty` is the ANNOUNCE-TIME weight: the share
 * difficulty that was in force for (connection, jobId) when the job was
 * announced to this connection (never a later vardiff value -- the race-free
 * fairness rule, MINING-ENGINE.md §4). A stats bridge sums this per worker
 * for hashrate accounting.
 */
export interface ShareEvent {
	readonly userId: number;
	readonly miningId: string;
	readonly worker: string;
	readonly difficulty: number;
	readonly timestampMs: number;
}

/**
 * A share that also cleared the block solve target -- a found block. Carries
 * everything the coordinator needs to re-personalize the exact winning
 * coinbase (frozen `payoutScriptHex`, never the miner's live address after a
 * wallet change) and to attribute + notify the win.
 */
export interface SolveEvent {
	readonly jobId: string;
	readonly extranonce1Hex: string;
	readonly extranonce2Hex: string;
	readonly ntimeHex: string;
	readonly nonceHex: string;
	readonly hashDisplay: string;
	readonly height: number;
	readonly userId: number;
	readonly miningId: string;
	readonly worker: string;
	readonly walletId: number;
	readonly address: string;
	readonly payoutScriptHex: string;
	readonly coinbaseValueSats: bigint;
}

/** A rejected submit (observability / abuse signal). */
export interface RejectEvent {
	readonly userId?: number;
	readonly worker?: string;
	readonly reason: 'stale' | 'duplicate' | 'low_difficulty' | 'unauthorized' | 'other';
}

// ---------------------------------------------------------------------------
// Status projection (what the read models / admin view surfaces)
// ---------------------------------------------------------------------------

export interface ConnectionInfo {
	readonly miningId: string;
	readonly userId: number;
	readonly worker: string;
	readonly address: string;
	readonly difficulty: number;
	readonly sharesAccepted: number;
	readonly lastShareAt: number | null;
}

/** One bound Stratum listener's role + port + live connection count. */
export interface ListenerInfo {
	readonly role: 'standard' | 'asic';
	readonly port: number;
	readonly connections: number;
}

export interface EngineStatus {
	readonly listening: boolean;
	readonly bind: string;
	/** The STANDARD listener's port (the primary advertised port). */
	readonly port: number;
	readonly lastTipHeight: number | null;
	readonly lastJobAt: number | null;
	readonly lastTemplateOk: boolean;
	readonly minerCount: number;
	/** COMBINED per-connection projection across every listener (standard + asic). */
	readonly connections: ConnectionInfo[];
	/** One entry per bound listener -- one element when the ASIC port is disabled. */
	readonly listeners: ListenerInfo[];
	readonly fatalErrors: string[];
}

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export interface MiningEngineConfig {
	/** Stratum bind host. Loopback '127.0.0.1' by default; '0.0.0.0' admits LAN miners. */
	readonly bindHost: string;
	readonly port: number;
	readonly network: Network;
	/** ASCII pool tag placed in the coinbase scriptSig after the BIP34 height push. */
	readonly poolTag: string;
	/** Fixed share difficulty, or the vardiff FLOOR + per-connection starting difficulty. */
	readonly shareDifficulty: number;
	readonly vardiffEnabled: boolean;
	readonly vardiffTargetPerMin: number;
	/** Vardiff ceiling (overflow guard). */
	readonly maxDifficulty: number;
	readonly maxConnections: number;
	/** Regtest-only test knob: solve gate is min(networkTarget, shareTarget >> shift). 0 = production. */
	readonly blockPolicyShift: number;
	/**
	 * Whether a SECOND (ASIC-class) Stratum listener runs alongside the
	 * standard one. Same engine -- same job pipeline, per-connection coinbase,
	 * auth table, share/solve/reject handlers, and vardiff mechanism --
	 * differing ONLY in bind port and difficulty floor.
	 */
	readonly asicPortEnabled: boolean;
	/** Bind port for the ASIC listener (must differ from `port`). */
	readonly asicPort: number;
	/** Fixed/starting difficulty + vardiff floor for the ASIC listener. */
	readonly asicShareDifficulty: number;
	/**
	 * SV2 seam (MINING-ENGINE.md §9.4, M8 -- NOT built here). These fields are
	 * threaded through config so the settings keys exist end-to-end, but
	 * miningPool.ts never constructs a listener for them regardless of value.
	 */
	readonly sv2Enabled: boolean;
	readonly sv2Port: number;
	readonly sv2ShareDifficulty: number;
	readonly sv2VersionRolling: boolean;
}

// ---------------------------------------------------------------------------
// Wire / job shared shapes (getblocktemplate subset + built Stratum job)
// ---------------------------------------------------------------------------

/** Subset of getblocktemplate (rules=["segwit"]) the engine consumes. */
export interface GbtTemplate {
	readonly version: number;
	readonly previousblockhash: string; // display hex
	readonly height: number;
	readonly curtime: number;
	readonly bits: string; // BE hex, 8 chars
	readonly coinbasevalue: number; // sats
	readonly transactions: readonly {
		readonly data: string; // raw tx hex
		readonly txid: string; // display hex
		readonly hash: string; // display hex (wtxid)
	}[];
	readonly default_witness_commitment?: string; // scriptPubKey hex
}

/**
 * One mining job's SHARED fields (all hex per wire.ts conventions). There is
 * no base coinb1/coinb2 here: a solo coinbase has no meaning without a
 * payout script, so every connection is announced its OWN personalized
 * coinb1/coinb2 (see BuiltJob.personalize) over these shared fields and the
 * shared merkle branches.
 */
export interface StratumJob {
	readonly jobId: string;
	readonly prevHashDisplay: string;
	readonly prevHashStratum: string;
	readonly merkleBranchesInternalHex: readonly string[];
	readonly versionHex: string; // 8 BE hex chars
	readonly nbitsHex: string; // 8 BE hex chars
	readonly ntimeHex: string; // 8 BE hex chars
	readonly height: number;
	readonly coinbaseValueSats: bigint;
	readonly cleanJobs: boolean;
}

export interface AssembledBlock {
	readonly blockHex: string;
	readonly blockHashDisplay: string;
	readonly coinbaseTxidDisplay: string;
}

/** The per-miner coinbase input for personalize(): pay the full reward here. */
export interface PersonalizeInput {
	readonly payoutScript: Uint8Array;
}

/**
 * A per-connection coinbase variant. Every variant of one job shares the same
 * merkle branches and header fields; they differ ONLY in the coinbase output
 * (the miner's own payout script), so coinb2 differs and coinb1 is identical.
 */
export interface CoinbaseVariant {
	readonly coinb1Hex: string;
	readonly coinb2Hex: string;
	readonly headerFor: (en1Hex: string, en2Hex: string, ntimeHex: string, nonceHex: string) => Buffer;
	/** Assemble the full consensus-valid block for submitblock. */
	readonly assemble: (en1Hex: string, en2Hex: string, ntimeHex: string, nonceHex: string) => AssembledBlock;
}

export interface BuiltJob {
	readonly job: StratumJob;
	/**
	 * Build the coinbase variant for a specific miner (its payout script -> the
	 * single value-bearing output). Every mining.notify and every submit
	 * validation goes through a variant; there is no unpersonalized coinbase.
	 */
	readonly personalize: (input: PersonalizeInput) => CoinbaseVariant;
}
