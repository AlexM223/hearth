/**
 * Mining engine lifecycle + Hearth integration bridge (DECISIONS.md §4.6,
 * MINING-ENGINE.md §1). This is the module's PUBLIC SURFACE -- routes, the
 * SSE bridge, and the explorer import from here only, never reaching into a
 * sibling file directly.
 *
 * The engine runs IN-PROCESS: one MiningPool per instance, its auth snapshot
 * and share accounting owned by this module. Everything here is best-effort
 * and never throws into its callers -- a mining failure must never take down
 * the app or a financial operation (invariant 4). Fatal conditions
 * accumulate in {@link miningFatalErrors} and surface in the admin status view.
 *
 * Wiring:
 *   MiningPool.onShare   -> aggregates.recordShare + best-share milestone notify
 *   MiningPool.onReject  -> aggregates.recordReject
 *   MiningPool.onBlockAccepted -> advance the finder's receive cursor, record
 *                          the block row, notify finder + broadcast, SSE nudges
 *   MiningPool.onBlockRejected -> record a 'rejected:<reason>' block row, loud log
 *   60s timer            -> refreshAuthTable (also on start + prefs-change)
 *   60s timer            -> worker-offline watcher
 *   15s timer            -> aggregates flush (owned by MiningAggregates)
 *
 * Network resolution deviation from cairn (documented): hearth has no single
 * global "configured chain network" setting -- each wallet infers its own
 * network from its xpub version bytes (DECISIONS.md §2). The mining engine
 * therefore resolves ONE network from Bitcoin Core's own
 * getblockchaininfo().chain at EVERY start (there is no fallback value to use
 * if that call fails), so unlike cairn's "log-and-continue" on a transient
 * pre-check failure, hearth's doStart() REFUSES to start (records a fatal)
 * when it cannot reach Core to determine the network at all -- there is
 * nothing else to fall back to, and guessing would risk mining wrong-chain
 * templates. Ports 3333 (standard) / 3334 (ASIC-floor); SV2 gets a NEW port
 * 3335 later (M8), never repurposing 3334 -- not built here.
 */
import { MiningPool, type MiningPoolOptions } from './miningPool.js';
import { getAuthTable, refreshAuthTable } from './authTable.js';
import { MiningAggregates } from './aggregates.js';
import { publish } from '../events/index.js';
import { readMiningSettings } from './settings.js';
import { networkFor } from './address.js';
import type { MiningEngineConfig, SolveEvent, ShareEvent, RejectEvent, EngineStatus } from './types.js';
import type { ChainNetwork } from '../wallet/types.js';
import { getNodeClient } from '../node/index.js';
import { getBlockchainInfo } from '../node/core/rpc.js';
import { isFeatureEnabled } from '../config/index.js';
import { nextReceiveAddress } from '../wallet/index.js';
import { notify } from '../notify/index.js';
import { getDb } from '../db/index.js';
import { log, logWarn, logError } from '../log.js';

export const MINING_ENABLED_DEFAULT = false;
export const STRATUM_PORT_STANDARD = 3333;
export const STRATUM_PORT_ASIC_FLOOR = 3334;

// Engine-config constants NOT exposed as operator settings (sane fixed values).
const MAX_CONNECTIONS = 128;
/** Vardiff ceiling -- a float64 overflow guard, generous for any home miner. */
const MAX_DIFFICULTY = 2 ** 40;
/** 0 = production solve gate (network target). Never shifted outside a regtest QA harness. */
const BLOCK_POLICY_SHIFT = 0;

const AUTH_REFRESH_MS = 60_000;
const OFFLINE_SCAN_MS = 60_000;
const OFFLINE_ESTABLISHED_MS = 10 * 60_000; // >=10min of shares before we watch it
const OFFLINE_SILENCE_MS = 5 * 60_000; // silent >5min = offline
const BEST_SHARE_THROTTLE_MS = 86_400_000; // <=1 best-share notify / user / day
const NETWORK_HASHPS_TTL_MS = 60_000;

// ------------------------------------------------------------- module state
const aggregates = new MiningAggregates();
let pool: MiningPool | null = null;
let startedAt: number | null = null;
let startInFlight: Promise<void> | null = null;
let authRefreshTimer: NodeJS.Timeout | null = null;
let offlineTimer: NodeJS.Timeout | null = null;
/** The network resolved from Core at the last successful start -- needed by
 *  onPrefsChanged's refresh, since refreshAuthTable is otherwise stateless. */
let currentNetwork: ChainNetwork | null = null;
const fatal: string[] = [];

/** Currently-offline episodes, keyed userId:worker (dedupe one notify/episode). */
const offlineNotified = new Set<string>();
/** In-memory all-time best-share baseline + last-notify time, per user. */
const bestBaseline = new Map<number, number>();
const bestLastNotify = new Map<number, number>();

let netHashCache: { at: number; value: number | null } | null = null;
let shutdownHooked = false;

/**
 * Durable shutdown flush. server.mjs runs in a SEPARATE module graph from this
 * (bundled) code and has no clean handle to this singleton, so its own
 * SIGTERM/SIGINT handler can't await stopMiningEngine() here. Instead the
 * engine registers its OWN signal handler, once, on first start: a
 * SYNCHRONOUS final flush of accumulated shares (aggregates.flush is sync
 * SQLite). Registered during app-bundle import, which finishes before
 * server.mjs registers its own signal handlers, so this runs first --
 * durability is guaranteed before the process exits. The pool's TCP
 * listener is closed by process exit.
 */
function ensureShutdownFlush(): void {
	if (shutdownHooked) return;
	shutdownHooked = true;
	const onSignal = (): void => {
		try {
			aggregates.flush();
		} catch {
			/* best-effort */
		}
	};
	process.once('SIGTERM', onSignal);
	process.once('SIGINT', onSignal);
}

export function getMiningAggregates(): MiningAggregates {
	return aggregates;
}

export function miningEngineRunning(): boolean {
	return pool !== null;
}

/** Prefs-change hook (prefs.ts calls this). Rebuild the auth snapshot off the
 *  hot path -- but only when the engine is actually running (no point paying
 *  for a derive round-trip to authorize nobody will connect against). */
export function onPrefsChanged(): void {
	if (pool !== null && currentNetwork !== null) void refreshAuthTable(networkFor(currentNetwork));
}

function recordFatal(msg: string): void {
	fatal.push(msg);
	if (fatal.length > 50) fatal.shift();
	logError('mining', { event: 'engine_fatal', msg });
}

function buildEngineConfig(network: ChainNetwork): MiningEngineConfig {
	const s = readMiningSettings();
	return {
		bindHost: s.bindHost,
		port: s.stratumPort,
		network: networkFor(network),
		poolTag: s.poolTag,
		shareDifficulty: s.shareDifficulty,
		vardiffEnabled: s.vardiffEnabled,
		vardiffTargetPerMin: s.vardiffTargetPerMin,
		maxDifficulty: MAX_DIFFICULTY,
		maxConnections: MAX_CONNECTIONS,
		blockPolicyShift: BLOCK_POLICY_SHIFT,
		asicPortEnabled: s.asicPortEnabled,
		asicPort: s.asicStratumPort,
		asicShareDifficulty: s.asicShareDifficulty,
		sv2Enabled: s.sv2Enabled,
		sv2Port: s.sv2Port,
		sv2ShareDifficulty: s.sv2ShareDifficulty,
		sv2VersionRolling: s.sv2VersionRolling
	};
}

/**
 * Maps Bitcoin Core's own chain-name vocabulary
 * (`getblockchaininfo().chain`: 'main'|'test'|'testnet4'|'signet'|'regtest')
 * onto hearth's {@link ChainNetwork} ('mainnet'|'testnet'|'regtest'). Hearth
 * has no signet support, so a signet node never matches -- an intentional
 * refusal, not a gap. Exported for unit testing.
 */
export function networkForCoreChain(coreChain: string): ChainNetwork | null {
	switch (coreChain) {
		case 'main':
			return 'mainnet';
		case 'test':
		case 'testnet4':
			return 'testnet';
		case 'regtest':
			return 'regtest';
		default:
			return null;
	}
}

/**
 * Live Bitcoin Core RPC reachability + sync-state probe -- an honest
 * Start-button diagnosis distinct from {@link miningEngineStatus}'s `coreRpc`
 * field (which reflects whether the pool's own tip-poller has completed a
 * getblocktemplate round trip while RUNNING). Never throws.
 */
export async function probeCoreRpcHealth(): Promise<
	{ ok: true } | { ok: false; reason: 'syncing'; blocks?: number } | { ok: false; reason: 'transport' }
> {
	try {
		const info = await getBlockchainInfo(getNodeClient().coreRpc);
		if (info.initialblockdownload) return { ok: false, reason: 'syncing', blocks: info.blocks };
		return { ok: true };
	} catch (e) {
		logWarn('mining', { event: 'probe_core_rpc_health_failed', err: String(e) });
		return { ok: false, reason: 'transport' };
	}
}

/**
 * Start the engine, idempotently. No-op (never throws) unless ALL gates
 * hold: the `mining` feature flag is on, the operator enabled mining in
 * settings, and Core RPC can be reached to determine the network. Concurrent
 * callers share one in-flight start.
 */
export function startMiningEngine(): Promise<void> {
	if (pool !== null) return Promise.resolve();
	if (startInFlight) return startInFlight;
	startInFlight = doStart().finally(() => {
		startInFlight = null;
	});
	return startInFlight;
}

async function doStart(): Promise<void> {
	try {
		if (!isFeatureEnabled('mining')) return;
		if (!readMiningSettings().enabled) return;

		const node = getNodeClient();

		// Network resolution (module doc note): the ONLY source of truth is
		// Core's own getblockchaininfo(). A transport failure here means we
		// cannot safely determine which chain to mine -- refuse to start rather
		// than guess (never mine wrong-chain templates/payout addresses).
		let coreChain: string;
		try {
			const info = await getBlockchainInfo(node.coreRpc);
			coreChain = info.chain;
		} catch (e) {
			recordFatal(`could not reach Bitcoin Core RPC to determine the network — refusing to start mining: ${String(e)}`);
			return;
		}
		const network = networkForCoreChain(coreChain);
		if (network === null) {
			recordFatal(
				`Bitcoin Core reports chain "${coreChain}", which hearth's mining engine does not support (mainnet/testnet/regtest only) — refusing to start.`
			);
			return;
		}

		// Build the auth snapshot BEFORE listening so the first connecting miner
		// resolves against a populated table.
		await refreshAuthTable(networkFor(network));
		currentNetwork = network;
		aggregates.startFlushTimer();
		ensureShutdownFlush();

		const config = buildEngineConfig(network);
		const engine = new MiningPool({
			rpc: node.coreRpc,
			config,
			authProvider: getAuthTable(),
			onShare: (e) => onShare(e),
			onReject: (e) => onReject(e),
			onBlockAccepted: (solve, blockHash, coinbaseTxid) => void handleBlockAccepted(solve, blockHash, coinbaseTxid),
			onBlockRejected: (solve, reason) => handleBlockRejected(solve, reason),
			log: (msg) => log('mining', { msg })
		} satisfies MiningPoolOptions);
		await engine.start();
		pool = engine;
		startedAt = Date.now();

		authRefreshTimer = setInterval(() => void refreshAuthTable(networkFor(network)), AUTH_REFRESH_MS);
		authRefreshTimer.unref?.();
		offlineTimer = setInterval(() => scanOffline(), OFFLINE_SCAN_MS);
		offlineTimer.unref?.();

		log('mining', { event: 'engine_started', port: config.port, bind: config.bindHost, network });
	} catch (e) {
		recordFatal(e instanceof Error ? e.message : String(e));
	}
}

/** Stop the engine: halt the pool, clear timers, do a final flush. Never throws. */
export async function stopMiningEngine(): Promise<void> {
	const engine = pool;
	pool = null;
	startedAt = null;
	currentNetwork = null;
	if (authRefreshTimer) {
		clearInterval(authRefreshTimer);
		authRefreshTimer = null;
	}
	if (offlineTimer) {
		clearInterval(offlineTimer);
		offlineTimer = null;
	}
	try {
		if (engine) await engine.stop();
	} catch (e) {
		logWarn('mining', { event: 'engine_stop_failed', err: String(e) });
	}
	// Durability: one last flush of accumulated shares, then park the timer.
	try {
		aggregates.flush();
	} catch (e) {
		logWarn('mining', { event: 'final_flush_failed', err: String(e) });
	}
	aggregates.stopFlushTimer();
	offlineNotified.clear();
}

/** Full stop + start with freshly-read settings (called after a settings save). Never throws. */
export async function reconfigureMiningEngine(): Promise<void> {
	try {
		await stopMiningEngine();
	} catch (e) {
		logWarn('mining', { event: 'reconfigure_stop_failed', err: String(e) });
	}
	await startMiningEngine();
}

export type CoreRpcStatus = 'ok' | 'down';

export interface MiningEngineStatus {
	running: boolean;
	engine: EngineStatus | null;
	coreRpc: CoreRpcStatus;
	startedAt: number | null;
}

export function miningEngineStatus(): MiningEngineStatus {
	const engine = pool ? pool.status() : null;
	const coreRpc: CoreRpcStatus = engine && engine.lastTemplateOk ? 'ok' : 'down';
	return { running: pool !== null, engine, coreRpc, startedAt };
}

/** Fatal errors accumulated by the bridge (distinct from the pool's own). */
export function miningFatalErrors(): string[] {
	const poolFatal = pool ? [...pool.fatalErrors] : [];
	return [...fatal, ...poolFatal];
}

/** Network hashrate (H/s), cached ~60s. Null when Core can't answer. */
export async function getNetworkHashps(): Promise<number | null> {
	const now = Date.now();
	if (netHashCache && now - netHashCache.at < NETWORK_HASHPS_TTL_MS) return netHashCache.value;
	let value: number | null = null;
	try {
		const v = await getNodeClient().coreRpc.call<number>('getnetworkhashps');
		value = Number.isFinite(v) && v > 0 ? v : null;
	} catch (e) {
		logWarn('mining', { event: 'get_network_hashps_failed', err: String(e) });
		value = null;
	}
	netHashCache = { at: now, value };
	return value;
}

// -------------------------------------------------------------- share hooks

function onShare(e: ShareEvent): void {
	try {
		aggregates.recordShare(e);
		maybeBestShareNotify(e);
	} catch (err) {
		logWarn('mining', { event: 'on_share_failed', err: String(err) });
	}
}

function onReject(e: RejectEvent): void {
	try {
		aggregates.recordReject(e);
	} catch (err) {
		logWarn('mining', { event: 'on_reject_failed', err: String(err) });
	}
}

/** All-time best share for a user, seeded from the DB mirror on first look. */
function allTimeBest(userId: number): number {
	if (bestBaseline.has(userId)) return bestBaseline.get(userId)!;
	let best = 0;
	try {
		const row = getDb()
			.prepare('SELECT MAX(best_share_diff) AS best FROM mining_workers WHERE user_id = ?')
			.get(userId) as { best: number | null } | undefined;
		best = row?.best ?? 0;
	} catch (e) {
		logWarn('mining', { event: 'best_share_baseline_read_failed', userId, err: String(e) });
	}
	bestBaseline.set(userId, best);
	return best;
}

/**
 * Notify on a new all-time best share that is at least DOUBLE the previous
 * stored best -- a genuine milestone, not every tiny new max. Throttled to at
 * most one per user per day. Only fires once a baseline exists (the first-ever
 * best just seeds the baseline silently).
 */
export function maybeBestShareNotify(e: ShareEvent): void {
	const d = e.difficulty;
	if (!Number.isFinite(d) || d <= 0) return;
	const baseline = allTimeBest(e.userId);
	if (d <= baseline) return; // not a new best
	bestBaseline.set(e.userId, d); // advance baseline regardless of notifying
	if (baseline <= 0) return; // first-ever best: seed only, no notification
	if (d < baseline * 2) return; // new best, but not a doubling milestone
	const now = Date.now();
	const last = bestLastNotify.get(e.userId) ?? 0;
	if (now - last < BEST_SHARE_THROTTLE_MS) return;
	bestLastNotify.set(e.userId, now);
	notify({
		type: 'mining_best_share',
		userId: e.userId,
		level: 'info',
		title: 'New best share!',
		body: `Your miner ${e.worker} just submitted a share of difficulty ${Math.round(d).toLocaleString()} — a new personal best.`,
		detail: { worker: e.worker, difficulty: d },
		link: '/mining'
	});
}

// -------------------------------------------------------------- block hooks

export async function handleBlockAccepted(solve: SolveEvent, blockHash: string, coinbaseTxid: string): Promise<void> {
	// (a) Advance the finder's receive cursor exactly once -- the payout
	// address this block paid must not be handed out again for a future receive.
	try {
		nextReceiveAddress(solve.userId, solve.walletId);
	} catch (e) {
		logWarn('mining', { event: 'receive_cursor_advance_failed', userId: solve.userId, walletId: solve.walletId, err: String(e) });
	}

	// (b) Record the block row (durable). block_hash is UNIQUE -- a duplicate
	// callback (should never happen) is swallowed rather than throwing.
	try {
		getDb()
			.prepare(
				`INSERT INTO mining_blocks
				   (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
				    payout_address, coinbase_value_sats, submit_result)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`
			)
			.run(
				solve.height,
				blockHash,
				coinbaseTxid,
				solve.userId,
				solve.worker,
				solve.walletId,
				solve.address,
				Number(solve.coinbaseValueSats)
			);
	} catch (e) {
		logError('mining', { event: 'mining_blocks_insert_accepted_failed', height: solve.height, blockHash, err: String(e) });
	}

	const rewardSats = Number(solve.coinbaseValueSats);

	// (c) Notify the finder (success) + a broadcast notice. M5 wires these
	// calls; M6 owns the actual five-channel delivery -- notify() already
	// writes the events/activity-feed row either way.
	try {
		notify({
			type: 'mining_block_found',
			userId: solve.userId,
			level: 'success',
			title: 'You found a block!',
			body: `Your miner ${solve.worker} found block ${solve.height}. The full reward pays your wallet — it becomes spendable after 100 confirmations.`,
			detail: { height: solve.height, blockHash, coinbaseTxid, rewardSats, worker: solve.worker, address: solve.address },
			link: '/mining'
		});
	} catch (e) {
		logWarn('mining', { event: 'block_found_user_notify_failed', err: String(e) });
	}
	try {
		notify({
			type: 'mining_block_found',
			userId: null,
			level: 'info',
			title: 'A miner found a block',
			body: `Block ${solve.height} was found on this instance. The reward pays the finder's wallet.`,
			detail: { height: solve.height, blockHash, userId: solve.userId, rewardSats },
			link: '/mining'
		});
	} catch (e) {
		logWarn('mining', { event: 'block_found_broadcast_notify_failed', err: String(e) });
	}

	// (d) Immediate live nudge: block-found is out of band -- nudge the finder
	// and everyone else now rather than waiting for the next aggregates flush.
	try {
		publish('mining', { kind: 'user', userId: solve.userId }, {});
		publish('mining:pool', { kind: 'broadcast' }, {});
	} catch (e) {
		logWarn('mining', { event: 'block_found_live_nudge_failed', err: String(e) });
	}
}

export function handleBlockRejected(solve: SolveEvent, reason: string): void {
	logError('mining', { event: 'block_rejected_by_bitcoind', height: solve.height, reason });
	try {
		// A rejected solve has no accepted block hash; store a synthetic unique
		// key so the UNIQUE(block_hash) constraint never collides across rejections.
		const key = `rejected:${solve.height}:${solve.nonceHex}:${Date.now()}`;
		getDb()
			.prepare(
				`INSERT INTO mining_blocks
				   (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
				    payout_address, coinbase_value_sats, submit_result)
				 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				solve.height,
				key,
				solve.userId,
				solve.worker,
				solve.walletId,
				solve.address,
				Number(solve.coinbaseValueSats),
				`rejected:${reason}`
			);
	} catch (e) {
		logError('mining', { event: 'mining_blocks_insert_rejected_failed', height: solve.height, err: String(e) });
	}
}

// ----------------------------------------------------------- offline watcher

/**
 * Scan for workers that were established (>=10min of shares) then went
 * silent (>5min). Notify once per offline episode; a worker that resumes
 * clears its episode so a later silence can notify again. Multiple
 * newly-offline workers of ONE user in the same scan collapse into a single
 * notification.
 */
function scanOffline(): void {
	try {
		const now = Date.now();
		const newlyOfflineByUser = new Map<number, string[]>();
		const liveKeys = new Set<string>();
		for (const w of aggregates.liveAllMiners()) {
			const key = `${w.userId}:${w.worker}`;
			liveKeys.add(key);
			if (w.lastShareAtMs === null || w.firstShareAtMs === null) continue;
			const established = w.lastShareAtMs - w.firstShareAtMs >= OFFLINE_ESTABLISHED_MS;
			const silent = now - w.lastShareAtMs > OFFLINE_SILENCE_MS;
			if (established && silent) {
				if (!offlineNotified.has(key)) {
					offlineNotified.add(key);
					const list = newlyOfflineByUser.get(w.userId) ?? [];
					list.push(w.worker);
					newlyOfflineByUser.set(w.userId, list);
				}
			} else if (!silent) {
				offlineNotified.delete(key); // resumed -> episode over
			}
		}
		// Forget episodes for workers no longer tracked at all.
		for (const key of [...offlineNotified]) {
			if (!liveKeys.has(key)) offlineNotified.delete(key);
		}
		for (const [userId, workers] of newlyOfflineByUser) {
			const body =
				workers.length === 1
					? `Your miner ${workers[0]} stopped submitting shares.`
					: `${workers.length} of your miners stopped submitting shares (${workers.slice(0, 3).join(', ')}${workers.length > 3 ? '…' : ''}).`;
			notify({
				type: 'mining_worker_offline',
				userId,
				level: 'warning',
				title: workers.length === 1 ? 'Miner offline' : 'Miners offline',
				body,
				detail: { workers },
				link: '/mining'
			});
		}
	} catch (e) {
		logWarn('mining', { event: 'offline_scan_failed', err: String(e) });
	}
}

/** Test-only: reset all in-memory bridge state. */
export function __resetMiningEngineForTests(): void {
	pool = null;
	startedAt = null;
	startInFlight = null;
	currentNetwork = null;
	if (authRefreshTimer) clearInterval(authRefreshTimer);
	if (offlineTimer) clearInterval(offlineTimer);
	authRefreshTimer = null;
	offlineTimer = null;
	fatal.length = 0;
	offlineNotified.clear();
	bestBaseline.clear();
	bestLastNotify.clear();
	netHashCache = null;
	aggregates.reset();
	aggregates.stopFlushTimer();
}
