/**
 * Read models for the mining dashboard (MINING-ENGINE.md §6.1). Three server
 * functions produce the EXACT JSON contracts the /mining page (Member/Owner/
 * Guest all load it; sections are role-gated in the page itself) and its
 * poll endpoints consume. Live "now" values come from the in-memory
 * aggregates (fresh to the last share); durable history (blocks, the
 * hashrate series, all-time best) comes from the DB mirror.
 *
 * STRICT per-user scoping is a security boundary (readModels.spec.ts):
 * getUserMiningView(userId) only ever reads THAT user's prefs/workers/
 * wallets/blocks.
 *
 * Ported as a pattern from cairn's mining/readModels.ts (SV2 fields dropped
 * entirely -- M8, not built here).
 */
import { getDb } from '../db/index.js';
import { getWallet, listWallets, peekReceiveAddress } from '../wallet/index.js';
import { readMiningSettings, type MiningBind } from './settings.js';
import { getMiningPrefs } from './prefs.js';
import { getMiningAggregates, miningEngineStatus, miningFatalErrors, getNetworkHashps } from './index.js';
import { getNodeClient } from '../node/index.js';
import { coinbaseMaturity } from '../../shared/coinbase.js';
import { soloOdds } from '../../shared/hashrate.js';
import { logWarn } from '../log.js';

type EngineDisplayStatus = 'running' | 'stopped' | 'core_missing';

// --------------------------------------------------------------- user view

export interface UserMiningView {
	engine: {
		status: EngineDisplayStatus;
		stratumPort: number;
		bind: MiningBind;
		/** Difficulty floor of the standard (small-miner) port. */
		shareDifficulty: number;
		/** The high-difficulty-floor listener for ASIC-class hardware, null when
		 *  the operator disabled it. */
		asicPort: { port: number; shareDifficulty: number } | null;
	};
	connection: { miningId: string; workerFormat: string; password: 'x' } | null;
	payout: { walletId: number; walletName: string; address: string } | null;
	workers: {
		name: string;
		online: boolean;
		lastShareAgoSec: number | null;
		hashrate: { now: number; h1: number; h24: number };
		shares: { accepted: number; stale: number; rejected: number };
		bestShareDifficulty: number;
	}[];
	totals: {
		hashrateNow: number;
		hashrate24h: number;
		bestShareEver: number;
		acceptedShares: number;
		staleShares: number;
	};
	earnings: {
		blocksFound: {
			height: number;
			txid: string | null;
			vout: 0;
			reward: number;
			foundAt: string;
			status: 'maturing' | 'mature' | 'rejected';
		}[];
		totalMaturedSats: number;
		totalPendingSats: number;
	};
	odds: {
		userHashrate: number;
		networkHashps: number;
		expectedYearsPerBlock: number;
		probPerDayPct: number;
	} | null;
	/** Approximate network difficulty (D ~= H * 600 / 2^32) -- context for the
	 *  best-share-ever card ("N% of the way to a block"). Independent of
	 *  `odds`, which is null whenever the user isn't hashing right now. */
	networkDifficulty: number | null;
	wallets: { id: number; name: string; eligible: boolean }[];
}

const ONLINE_THRESHOLD_MS = 5 * 60_000;

async function engineDisplayStatus(): Promise<EngineDisplayStatus> {
	const s = miningEngineStatus();
	if (s.running) return 'running';
	// Not running: distinguish "toggled off, Core is fine" from "Core actually
	// unreachable" so the off-state copy is honest (MINING-ENGINE.md §6.4).
	const { probeCoreRpcHealth } = await import('./index.js');
	const probe = await probeCoreRpcHealth();
	return probe.ok ? 'stopped' : 'core_missing';
}

async function safeTipHeight(): Promise<number> {
	try {
		return (await getNodeClient().getTipHeight()) ?? 0;
	} catch (e) {
		logWarn('mining', { event: 'read_model_tip_fetch_failed', err: String(e) });
		return 0;
	}
}

/** DB stored all-time best share difficulty for a user. */
function storedBest(userId: number): number {
	try {
		const row = getDb()
			.prepare('SELECT MAX(best_share_diff) AS best FROM mining_workers WHERE user_id = ?')
			.get(userId) as { best: number | null } | undefined;
		return row?.best ?? 0;
	} catch {
		return 0;
	}
}

interface BlockRow {
	height: number;
	block_hash: string;
	coinbase_txid: string | null;
	user_id: number | null;
	worker_name: string | null;
	wallet_id: number | null;
	payout_address: string;
	coinbase_value_sats: number;
	found_at: string;
	submit_result: string;
}

function blockStatus(row: BlockRow, tipHeight: number): 'maturing' | 'mature' | 'rejected' {
	if (row.submit_result.startsWith('rejected')) return 'rejected';
	return coinbaseMaturity(row.height, tipHeight).mature ? 'mature' : 'maturing';
}

export async function getUserMiningView(userId: number): Promise<UserMiningView> {
	const settings = readMiningSettings();
	const prefs = getMiningPrefs(userId);
	const agg = getMiningAggregates();
	const now = Date.now();
	const tipHeight = await safeTipHeight();

	// connection -- requires BOTH a minted id AND the user currently having
	// mining turned on (a miningId is permanent once minted, so gating on it
	// alone would make "disabled" unreachable in the UI after first enable).
	let connection: UserMiningView['connection'] = null;
	if (prefs?.miningId && prefs.enabled) {
		connection = { miningId: prefs.miningId, workerFormat: `${prefs.miningId}.<workerName>`, password: 'x' };
	}

	// payout
	let payout: UserMiningView['payout'] = null;
	if (prefs?.payoutWalletId != null) {
		const wallet = getWallet(userId, prefs.payoutWalletId);
		if (wallet) {
			try {
				const peek = peekReceiveAddress(wallet);
				payout = { walletId: wallet.id, walletName: wallet.name, address: peek.address };
			} catch (e) {
				logWarn('mining', { event: 'payout_address_peek_failed', userId, walletId: wallet.id, err: String(e) });
				payout = { walletId: wallet.id, walletName: wallet.name, address: '' };
			}
		}
	}

	// workers + totals (live, session-scoped)
	const live = agg.liveWorkers(userId);
	const workers = live.map((w) => {
		const online = w.lastShareAtMs !== null && now - w.lastShareAtMs < ONLINE_THRESHOLD_MS;
		return {
			name: w.worker,
			online,
			lastShareAgoSec: w.lastShareAtMs === null ? null : Math.round((now - w.lastShareAtMs) / 1000),
			hashrate: w.hashrate,
			shares: { accepted: w.sharesAccepted, stale: w.sharesStale, rejected: w.sharesRejected },
			bestShareDifficulty: w.bestShareDiff
		};
	});
	const totals = {
		hashrateNow: live.reduce((a, w) => a + w.hashrate.now, 0),
		hashrate24h: live.reduce((a, w) => a + w.hashrate.h24, 0),
		bestShareEver: Math.max(storedBest(userId), agg.sessionBest(userId)),
		acceptedShares: live.reduce((a, w) => a + w.sharesAccepted, 0),
		staleShares: live.reduce((a, w) => a + w.sharesStale, 0)
	};

	// earnings
	const blockRows = getDb()
		.prepare('SELECT * FROM mining_blocks WHERE user_id = ? ORDER BY height DESC, id DESC')
		.all(userId) as unknown as BlockRow[];
	let totalMaturedSats = 0;
	let totalPendingSats = 0;
	const blocksFound = blockRows.map((row) => {
		const status = blockStatus(row, tipHeight);
		const reward = row.coinbase_value_sats;
		if (status === 'mature') totalMaturedSats += reward;
		else if (status === 'maturing') totalPendingSats += reward;
		return {
			height: row.height,
			txid: row.coinbase_txid,
			vout: 0 as const,
			reward,
			foundAt: row.found_at,
			status
		};
	});

	// odds
	const networkHashps = await getNetworkHashps();
	let odds: UserMiningView['odds'] = null;
	if (networkHashps !== null && totals.hashrateNow > 0) {
		const o = soloOdds(totals.hashrateNow, networkHashps);
		if (o) {
			odds = {
				userHashrate: totals.hashrateNow,
				networkHashps,
				expectedYearsPerBlock: o.expectedYearsPerBlock,
				probPerDayPct: o.probPerDayPct
			};
		}
	}

	// wallets (xpub-bearing wallets are payout-eligible)
	const wallets = listWallets(userId).map((w) => ({
		id: w.id,
		name: w.name,
		eligible: w.keys.length > 0 && w.keys.some((k) => k.xpub && k.xpub.trim() !== '')
	}));

	return {
		engine: {
			status: await engineDisplayStatus(),
			stratumPort: settings.stratumPort,
			bind: settings.bind,
			shareDifficulty: settings.shareDifficulty,
			asicPort: settings.asicPortEnabled
				? { port: settings.asicStratumPort, shareDifficulty: settings.asicShareDifficulty }
				: null
		},
		connection,
		payout,
		workers,
		totals,
		earnings: { blocksFound, totalMaturedSats, totalPendingSats },
		odds,
		networkDifficulty: networkHashps !== null && networkHashps > 0 ? (networkHashps * 600) / 2 ** 32 : null,
		wallets
	};
}

// --------------------------------------------------------------- admin view

export interface AdminMiningView {
	engine: {
		status: EngineDisplayStatus;
		coreRpc: 'ok' | 'down';
		uptimeSec: number;
		bind: MiningBind;
		stratumPort: number;
		lastTemplateAgoSec: number | null;
		fatalErrors: string[];
		listeners: { role: 'standard' | 'asic'; port: number; connections: number }[];
	};
	pool: { connectedWorkers: number; connectedUsers: number; hashrateNow: number; hashrate24h: number };
	hashrateSeries: { t: number; hashrate: number }[];
	miners: {
		userId: number;
		userName: string;
		worker: string;
		hashrate: number;
		difficulty: number;
		lastShareAgoSec: number | null;
		online: boolean;
	}[];
	userBreakdown: { userId: number; userName: string; workers: number; hashrate: number; sharePct: number }[];
	blocks: {
		height: number;
		blockHash: string;
		foundByName: string;
		reward: number;
		foundAt: string;
		confirmations: number;
		status: 'maturing' | 'mature' | 'rejected';
	}[];
	settings: {
		enabled: boolean;
		bind: MiningBind;
		port: number;
		shareDifficulty: number;
		vardiffEnabled: boolean;
		vardiffTargetPerMin: number;
		poolTag: string;
		asicPortEnabled: boolean;
		asicStratumPort: number;
		asicShareDifficulty: number;
	};
}

/** Resolve a set of user ids to display names in one query. */
function userNames(ids: number[]): Map<number, string> {
	const out = new Map<number, string>();
	const unique = [...new Set(ids)].filter((id) => Number.isInteger(id));
	if (unique.length === 0) return out;
	const placeholders = unique.map(() => '?').join(',');
	try {
		const rows = getDb()
			.prepare(`SELECT id, display_name, username FROM users WHERE id IN (${placeholders})`)
			.all(...unique) as { id: number; display_name: string | null; username: string }[];
		for (const r of rows) out.set(r.id, r.display_name?.trim() || r.username);
	} catch (e) {
		logWarn('mining', { event: 'user_names_lookup_failed', err: String(e) });
	}
	return out;
}

export async function getAdminMiningView(): Promise<AdminMiningView> {
	const settings = readMiningSettings();
	const status = miningEngineStatus();
	const agg = getMiningAggregates();
	const now = Date.now();
	const tipHeight = await safeTipHeight();

	const displayStatus = await engineDisplayStatus();
	const lastJobAt = status.engine?.lastJobAt ?? null;

	const liveMiners = agg.liveAllMiners();
	const names = userNames([
		...liveMiners.map((m) => m.userId),
		...(getDb().prepare('SELECT DISTINCT user_id FROM mining_blocks WHERE user_id IS NOT NULL').all() as {
			user_id: number;
		}[]).map((r) => r.user_id)
	]);

	const miners = liveMiners.map((m) => ({
		userId: m.userId,
		userName: names.get(m.userId) ?? `user ${m.userId}`,
		worker: m.worker,
		hashrate: m.hashrate.now,
		difficulty: m.currentDiff,
		lastShareAgoSec: m.lastShareAtMs === null ? null : Math.round((now - m.lastShareAtMs) / 1000),
		online: m.lastShareAtMs !== null && now - m.lastShareAtMs < ONLINE_THRESHOLD_MS
	}));

	const poolHashrateNow = liveMiners.reduce((a, m) => a + m.hashrate.now, 0);
	const poolHashrate24h = liveMiners.reduce((a, m) => a + m.hashrate.h24, 0);

	const byUser = new Map<number, { workers: number; hashrate: number }>();
	for (const m of liveMiners) {
		const cur = byUser.get(m.userId) ?? { workers: 0, hashrate: 0 };
		cur.workers += 1;
		cur.hashrate += m.hashrate.now;
		byUser.set(m.userId, cur);
	}
	const userBreakdown = [...byUser.entries()].map(([uid, v]) => ({
		userId: uid,
		userName: names.get(uid) ?? `user ${uid}`,
		workers: v.workers,
		hashrate: v.hashrate,
		sharePct: poolHashrateNow > 0 ? (v.hashrate / poolHashrateNow) * 100 : 0
	}));

	const connections = status.engine?.connections ?? [];
	const connectedUsers = new Set(connections.map((c) => c.userId)).size;

	const sinceIso = new Date(now - 86_400_000).toISOString();
	let hashrateSeries: { t: number; hashrate: number }[] = [];
	try {
		const rows = getDb()
			.prepare(
				`SELECT bucket_start, hashrate_est FROM mining_stats
				  WHERE user_id IS NULL AND bucket_start >= ? ORDER BY bucket_start ASC`
			)
			.all(sinceIso) as { bucket_start: string; hashrate_est: number }[];
		hashrateSeries = rows.map((r) => ({ t: Date.parse(r.bucket_start), hashrate: r.hashrate_est }));
	} catch (e) {
		logWarn('mining', { event: 'hashrate_series_read_failed', err: String(e) });
	}

	const blockRows = getDb()
		.prepare('SELECT * FROM mining_blocks ORDER BY height DESC, id DESC LIMIT 100')
		.all() as unknown as BlockRow[];
	const blocks = blockRows.map((row) => ({
		height: row.height,
		blockHash: row.block_hash,
		foundByName: row.user_id === null ? '—' : (names.get(row.user_id) ?? `user ${row.user_id}`),
		reward: row.coinbase_value_sats,
		foundAt: row.found_at,
		confirmations: coinbaseMaturity(row.height, tipHeight).confirmations,
		status: blockStatus(row, tipHeight)
	}));

	return {
		engine: {
			status: displayStatus,
			coreRpc: status.coreRpc,
			uptimeSec: status.startedAt === null ? 0 : Math.round((now - status.startedAt) / 1000),
			bind: settings.bind,
			stratumPort: settings.stratumPort,
			lastTemplateAgoSec: lastJobAt === null ? null : Math.round((now - lastJobAt) / 1000),
			fatalErrors: miningFatalErrors(),
			listeners: status.engine?.listeners ?? []
		},
		pool: { connectedWorkers: connections.length, connectedUsers, hashrateNow: poolHashrateNow, hashrate24h: poolHashrate24h },
		hashrateSeries,
		miners,
		userBreakdown,
		blocks,
		settings: {
			enabled: settings.enabled,
			bind: settings.bind,
			port: settings.stratumPort,
			shareDifficulty: settings.shareDifficulty,
			vardiffEnabled: settings.vardiffEnabled,
			vardiffTargetPerMin: settings.vardiffTargetPerMin,
			poolTag: settings.poolTag,
			asicPortEnabled: settings.asicPortEnabled,
			asicStratumPort: settings.asicStratumPort,
			asicShareDifficulty: settings.asicShareDifficulty
		}
	};
}

// ------------------------------------------------------- public pool view

/**
 * Pool-wide stats every signed-in user may see (competitor brief §5/§8): pool
 * hashrate + 24h chart, miners online, the blocks-found trophy wall, the
 * pool's best share so far, and a per-user best-share leaderboard (no pot --
 * bragging rights only). Genuinely sensitive admin material (settings,
 * per-connection difficulty, fatal errors, per-user share percentages) stays
 * in getAdminMiningView behind requireRole('owner').
 */
export interface PublicPoolView {
	engine: { status: EngineDisplayStatus };
	pool: { connectedWorkers: number; connectedUsers: number; hashrateNow: number; hashrate24h: number };
	hashrateSeries: { t: number; hashrate: number }[];
	/** Approximate network difficulty (D ~= H * 600 / 2^32). Null when the
	 *  node can't report a network hashrate. */
	networkDifficulty: number | null;
	/** The pool's best share ever, with its holder. Null until a first share lands. */
	bestShare: { difficulty: number; holderName: string; isYou: boolean } | null;
	/** Per-user best shares, ranked. Session-live bests included. Top 10. */
	leaderboard: {
		rank: number;
		name: string;
		isYou: boolean;
		bestShareDifficulty: number;
		hashrateNow: number;
		online: boolean;
	}[];
	/** Trophy wall -- newest first, all finders, rejected rows kept honest. */
	blocks: {
		height: number;
		blockHash: string;
		foundByName: string;
		isYou: boolean;
		reward: number;
		foundAt: string;
		status: 'maturing' | 'mature' | 'rejected';
	}[];
	/** All-time count of accepted blocks found by this pool. */
	totalBlocksFound: number;
}

export async function getPublicPoolView(viewerUserId: number): Promise<PublicPoolView> {
	const status = miningEngineStatus();
	const agg = getMiningAggregates();
	const now = Date.now();
	const tipHeight = await safeTipHeight();

	const liveMiners = agg.liveAllMiners();
	const poolHashrateNow = liveMiners.reduce((a, m) => a + m.hashrate.now, 0);
	const poolHashrate24h = liveMiners.reduce((a, m) => a + m.hashrate.h24, 0);
	const connections = status.engine?.connections ?? [];
	const connectedUsers = new Set(connections.map((c) => c.userId)).size;

	const bestByUser = new Map<number, number>();
	try {
		const rows = getDb()
			.prepare('SELECT user_id, MAX(best_share_diff) AS best FROM mining_workers GROUP BY user_id')
			.all() as { user_id: number; best: number | null }[];
		for (const r of rows) if (r.best && r.best > 0) bestByUser.set(r.user_id, r.best);
	} catch (e) {
		logWarn('mining', { event: 'leaderboard_read_failed', err: String(e) });
	}
	const liveByUser = new Map<number, { hashrateNow: number; online: boolean }>();
	for (const m of liveMiners) {
		if (m.bestShareDiff > (bestByUser.get(m.userId) ?? 0)) bestByUser.set(m.userId, m.bestShareDiff);
		const cur = liveByUser.get(m.userId) ?? { hashrateNow: 0, online: false };
		cur.hashrateNow += m.hashrate.now;
		cur.online = cur.online || (m.lastShareAtMs !== null && now - m.lastShareAtMs < ONLINE_THRESHOLD_MS);
		liveByUser.set(m.userId, cur);
	}

	const blockFinderIds = (
		getDb().prepare('SELECT DISTINCT user_id FROM mining_blocks WHERE user_id IS NOT NULL').all() as {
			user_id: number;
		}[]
	).map((r) => r.user_id);
	const names = userNames([...bestByUser.keys(), ...blockFinderIds]);

	const leaderboard = [...bestByUser.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([uid, best], i) => ({
			rank: i + 1,
			name: names.get(uid) ?? `user ${uid}`,
			isYou: uid === viewerUserId,
			bestShareDifficulty: best,
			hashrateNow: liveByUser.get(uid)?.hashrateNow ?? 0,
			online: liveByUser.get(uid)?.online ?? false
		}));

	const bestShare =
		leaderboard.length > 0
			? { difficulty: leaderboard[0]!.bestShareDifficulty, holderName: leaderboard[0]!.name, isYou: leaderboard[0]!.isYou }
			: null;

	const sinceIso = new Date(now - 86_400_000).toISOString();
	let hashrateSeries: { t: number; hashrate: number }[] = [];
	try {
		const rows = getDb()
			.prepare(
				`SELECT bucket_start, hashrate_est FROM mining_stats
				  WHERE user_id IS NULL AND bucket_start >= ? ORDER BY bucket_start ASC`
			)
			.all(sinceIso) as { bucket_start: string; hashrate_est: number }[];
		hashrateSeries = rows.map((r) => ({ t: Date.parse(r.bucket_start), hashrate: r.hashrate_est }));
	} catch (e) {
		logWarn('mining', { event: 'pool_hashrate_series_read_failed', err: String(e) });
	}

	const blockRows = getDb()
		.prepare('SELECT * FROM mining_blocks ORDER BY height DESC, id DESC LIMIT 25')
		.all() as unknown as BlockRow[];
	const blocks = blockRows.map((row) => ({
		height: row.height,
		blockHash: row.block_hash,
		foundByName: row.user_id === null ? '—' : (names.get(row.user_id) ?? `user ${row.user_id}`),
		isYou: row.user_id !== null && row.user_id === viewerUserId,
		reward: row.coinbase_value_sats,
		foundAt: row.found_at,
		status: blockStatus(row, tipHeight)
	}));

	let totalBlocksFound = 0;
	try {
		const row = getDb().prepare("SELECT COUNT(*) AS n FROM mining_blocks WHERE submit_result = 'accepted'").get() as
			| { n: number }
			| undefined;
		totalBlocksFound = row?.n ?? 0;
	} catch (e) {
		logWarn('mining', { event: 'blocks_count_read_failed', err: String(e) });
	}

	const networkHashps = await getNetworkHashps();
	const networkDifficulty = networkHashps !== null && networkHashps > 0 ? (networkHashps * 600) / 2 ** 32 : null;

	return {
		engine: { status: await engineDisplayStatus() },
		pool: { connectedWorkers: connections.length, connectedUsers, hashrateNow: poolHashrateNow, hashrate24h: poolHashrate24h },
		hashrateSeries,
		networkDifficulty,
		bestShare,
		leaderboard,
		blocks,
		totalBlocksFound
	};
}
