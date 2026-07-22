/**
 * NodeClient facade -- the Electrum (Fulcrum) / Bitcoin Core RPC split
 * (DECISIONS.md §4.4). Electrum is the fast wallet rail (primary, required);
 * Core RPC is the canonical/explorer + mining rail. Per-method backend
 * policy with graceful per-datum degrade: a page never fails wholly because
 * one datum's backend is down (health() below resolves every rail/datum
 * independently via allSettled).
 */
import { ElectrumPool } from './electrum/pool.js';
import {
	CoreRpcClient,
	getBlockchainInfo,
	getBlockCount,
	getMempoolInfo,
	getNetworkInfo
} from './core/rpc.js';
import { addressToScriptHash } from './electrum/scripthash.js';
import type { ElectrumBalance, ElectrumHeader } from './electrum/client.js';
import type { CoreRpcConfig, ElectrumConfig } from '../config/index.js';
import { logWarn } from '../log.js';

export type RailStatus = 'unknown' | 'connected' | 'down';

export interface NodeHealth {
	electrum: RailStatus;
	core: RailStatus;
	/** Best-known chain tip height, preferring Electrum's live-subscribed value. */
	tipHeight: number | null;
	/** 0..1 verification progress from Core; null when unknown or fully synced. */
	syncProgress: number | null;
	/** Headers known minus blocks synced -- used for a rough ETA. */
	blocksRemaining: number | null;
	peerCount: number | null;
	mempool: { txCount: number; bytes: number } | null;
}

const AVG_BLOCK_MINUTES = 10;

export class NodeClient {
	private readonly electrumPool: ElectrumPool;
	private readonly core: CoreRpcClient;
	/** Updated live by the primary Electrum connection's 'header' events (see watcher.ts). */
	private lastElectrumTip: ElectrumHeader | null = null;

	constructor(electrumConfig: ElectrumConfig, coreConfig: CoreRpcConfig) {
		this.electrumPool = new ElectrumPool({
			host: electrumConfig.host,
			port: electrumConfig.port,
			tls: electrumConfig.tls
		});
		this.core = new CoreRpcClient(coreConfig);

		this.electrumPool.on('header', (header: ElectrumHeader) => {
			this.lastElectrumTip = header;
		});
		this.electrumPool.on('error', () => {});
	}

	/** The pooled Electrum client -- for the block watcher and future wallet/explorer modules. */
	get electrum(): ElectrumPool {
		return this.electrumPool;
	}

	/** The Core RPC client -- for the block watcher fallback and future explorer/mining modules. */
	get coreRpc(): CoreRpcClient {
		return this.core;
	}

	/** Scripthash balance -- the fast wallet rail (DECISIONS.md §4.4). */
	async getAddressBalance(address: string): Promise<ElectrumBalance> {
		const scripthash = addressToScriptHash(address);
		return this.electrumPool.getBalance(scripthash);
	}

	/**
	 * THE broadcast rail (DECISIONS.md §4.4 per-method policy): Electrum primary,
	 * Bitcoin Core `sendrawtransaction` fallback. This is the node's single
	 * broadcast primitive; the wallet engine reaches it from exactly ONE call
	 * site (src/lib/server/wallet/broadcast.ts -- the constitutional one-path
	 * rule, WALLET-ENGINE §6.3). Returns the txid the rail reports (the wallet
	 * engine then verifies it against its locally-recomputed txid).
	 */
	async broadcast(rawTxHex: string): Promise<string> {
		try {
			return await this.electrumPool.broadcast(rawTxHex);
		} catch (electrumErr) {
			// Electrum rejected or is down -- try Core if it is reachable. A
			// genuine policy rejection will also fail here and surface honestly.
			try {
				return await this.core.call<string>('sendrawtransaction', [rawTxHex]);
			} catch {
				throw electrumErr instanceof Error ? electrumErr : new Error(String(electrumErr));
			}
		}
	}

	/** Raw tx hex for a prevout (nonWitnessUtxo / legacy inputs). Electrum first,
	 *  Core `getrawtransaction` fallback. */
	async fetchRawTx(txid: string): Promise<Uint8Array> {
		try {
			const hexStr = (await this.electrumPool.getTransaction(txid, false)) as string;
			return Uint8Array.from(Buffer.from(hexStr, 'hex'));
		} catch {
			const hexStr = await this.core.call<string>('getrawtransaction', [txid]);
			return Uint8Array.from(Buffer.from(hexStr, 'hex'));
		}
	}

	/**
	 * Cheap current tip height (chain/ module's confirmations math, EXPLORER.md
	 * §1.4/§1.5): Electrum's live-subscribed cache is free; Core
	 * `getblockcount` is the fallback. `null` only when BOTH rails are down.
	 */
	async getTipHeight(): Promise<number | null> {
		if (this.lastElectrumTip) return this.lastElectrumTip.height;
		try {
			const header = await this.electrumPool.headersSubscribe();
			this.lastElectrumTip = header;
			return header.height;
		} catch {
			try {
				return await getBlockCount(this.core);
			} catch {
				return null;
			}
		}
	}

	/** Electrum relay fee floor in sat/vB (default 1 when unavailable). */
	async getMinFeeRate(): Promise<number> {
		try {
			const btcPerKvb = await this.electrumPool.estimateFee(1000);
			if (typeof btcPerKvb === 'number' && btcPerKvb > 0) {
				return Math.max(1, Math.floor((btcPerKvb * 1e8) / 1000));
			}
		} catch {
			// fall through to the relay floor
		}
		return 1;
	}

	/**
	 * Health snapshot: which rails are up, tip height, sync progress, peer
	 * count, mempool summary. Every datum resolves independently
	 * (Promise.allSettled) so one dead rail never blanks data the other rail
	 * can still supply -- Home degrades per-datum, never wholly.
	 */
	async health(): Promise<NodeHealth> {
		const [electrumTip, coreInfo, networkInfo, mempoolInfo] = await Promise.allSettled([
			this.lastElectrumTip
				? Promise.resolve(this.lastElectrumTip)
				: this.electrumPool.headersSubscribe(),
			getBlockchainInfo(this.core),
			getNetworkInfo(this.core),
			getMempoolInfo(this.core)
		]);

		if (electrumTip.status === 'fulfilled' && !this.lastElectrumTip) {
			// Cache the first successful tip so subsequent health() calls don't
			// re-issue headersSubscribe RPCs between real block-tip push events
			// (the watcher's 'header' listener keeps this current after that).
			this.lastElectrumTip = electrumTip.value;
		}
		if (electrumTip.status === 'rejected') {
			logWarn('node', { event: 'electrum_health_probe_failed', err: String(electrumTip.reason) });
		}
		if (coreInfo.status === 'rejected') {
			logWarn('node', { event: 'core_health_probe_failed', err: String(coreInfo.reason) });
		}

		const electrumStatus: RailStatus =
			electrumTip.status === 'fulfilled' || this.electrumPool.isConnected ? 'connected' : 'down';
		const coreStatus: RailStatus = coreInfo.status === 'fulfilled' ? 'connected' : 'down';

		const tipHeight =
			electrumTip.status === 'fulfilled'
				? electrumTip.value.height
				: coreInfo.status === 'fulfilled'
					? coreInfo.value.blocks
					: null;

		let syncProgress: number | null = null;
		let blocksRemaining: number | null = null;
		if (coreInfo.status === 'fulfilled') {
			const info = coreInfo.value;
			if (info.initialblockdownload) {
				syncProgress = info.verificationprogress;
				blocksRemaining = Math.max(0, info.headers - info.blocks);
			}
		}

		return {
			electrum: electrumStatus,
			core: coreStatus,
			tipHeight,
			syncProgress,
			blocksRemaining,
			peerCount: networkInfo.status === 'fulfilled' ? networkInfo.value.connections : null,
			mempool:
				mempoolInfo.status === 'fulfilled'
					? { txCount: mempoolInfo.value.size, bytes: mempoolInfo.value.bytes }
					: null
		};
	}

	/** Tear down both rails -- for graceful shutdown / tests. */
	close(): void {
		this.electrumPool.close();
	}
}

/**
 * Plain-language node health copy (DECISIONS.md §4.2, competitor-brief §7):
 * "Synced · block 934,197", "Syncing 62% — ~3h left", "Node unreachable —
 * here's what to check". Pure function, unit-tested in health.spec.ts.
 */
export function describeNodeHealth(health: NodeHealth): string {
	if (health.core === 'down' && health.electrum === 'down') {
		return "Node unreachable — here's what to check in Settings.";
	}
	if (health.syncProgress !== null && health.syncProgress < 0.9999) {
		const pct = Math.round(health.syncProgress * 100);
		if (health.blocksRemaining !== null) {
			const etaMinutes = health.blocksRemaining * AVG_BLOCK_MINUTES;
			return `Syncing ${pct}% — ${formatEta(etaMinutes)} left`;
		}
		return `Syncing ${pct}%`;
	}
	if (health.tipHeight !== null) {
		return `Synced · block ${health.tipHeight.toLocaleString('en-US')}`;
	}
	return "Node unreachable — here's what to check in Settings.";
}

function formatEta(totalMinutes: number): string {
	if (totalMinutes < 1) return '<1m';
	const hours = Math.floor(totalMinutes / 60);
	const minutes = Math.round(totalMinutes % 60);
	if (hours === 0) return `~${minutes}m`;
	if (hours < 48) return minutes > 0 ? `~${hours}h${minutes}m` : `~${hours}h`;
	return `~${Math.round(hours / 24)}d`;
}

export type { ElectrumBalance, ElectrumHistoryItem } from './electrum/client.js';
export { addressToScriptHash, addressToScriptPubKey } from './electrum/scripthash.js';

// ── Sanctioned low-level read helpers for chain/ and mining/ (DECISIONS.md §4.1) ──
// chain/* and mining/* need direct Core RPC read primitives beyond the
// NodeClient facade above (raw block/tx/mempool lookups the explorer and
// mining engine build their own read models on top of); this is the deliberate,
// explicit surface for that -- NOT a blanket `export *` from core/rpc.js.
export {
	getBlock,
	getBlockHash,
	getBlockHeader,
	getRawTransaction,
	getTxOut,
	getMempoolEntry,
	getMempoolAncestors,
	getMempoolDescendants,
	getMempoolInfo,
	getBlockchainInfo,
	estimateSmartFee,
	type RpcCaller,
	type BlockVerbose2,
	type RawTransaction,
	type MempoolEntry,
	type ScanTxOutResult
} from './core/rpc.js';

// ---------------------------------------------------------------- singleton
// Mirrors db/client.ts's openDb()/getDb() idiom: hooks.server.ts constructs
// the one process-wide NodeClient at boot; every route/module reaches it via
// getNodeClient() rather than threading it through locals.

let instance: NodeClient | null = null;

export function initNodeClient(electrumConfig: ElectrumConfig, coreConfig: CoreRpcConfig): NodeClient {
	instance = new NodeClient(electrumConfig, coreConfig);
	return instance;
}

export function getNodeClient(): NodeClient {
	if (!instance) {
		throw new Error('hearth node: not initialized -- call initNodeClient() before getNodeClient()');
	}
	return instance;
}
