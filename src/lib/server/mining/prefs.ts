/**
 * Per-user mining preferences (`mining_prefs` table, migration 007): the
 * miner's stable Stratum identity token, whether they've opted in, and which
 * of their wallets receives the full reward when they find a block.
 *
 * Only Member/Owner (DECISIONS.md §4.3) can hold a row -- they own wallets; a
 * Guest has no wallet to pay out to. That's enforced at the route layer
 * (requireRole), not here.
 *
 * Every mutation here fires {@link onPrefsChanged} so the engine's in-memory
 * auth snapshot (authTable.ts) rebuilds off the socket path -- a disabled or
 * re-pointed miner stops/starts being authorized within one refresh, never on
 * the hot Stratum data handler.
 *
 * Ported as a pattern from cairn's mining/prefs.ts.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/index.js';
import { getWallet } from '../wallet/index.js';
import { logWarn } from '../log.js';
import { onPrefsChanged } from './index.js';

export interface MiningPrefs {
	userId: number;
	/** Stratum username token: `hearth_` + 8 lowercase hex. Null only
	 *  transiently before ensureMiningPrefs has generated one. */
	miningId: string | null;
	enabled: boolean;
	payoutWalletId: number | null;
	updatedAt: string;
}

interface PrefsRow {
	user_id: number;
	mining_id: string | null;
	enabled: number;
	payout_wallet_id: number | null;
	updated_at: string;
}

function toPrefs(row: PrefsRow): MiningPrefs {
	return {
		userId: row.user_id,
		miningId: row.mining_id,
		enabled: row.enabled === 1,
		payoutWalletId: row.payout_wallet_id,
		updatedAt: row.updated_at
	};
}

/** `hearth_` + 8 lowercase hex characters (4 random bytes). */
function generateMiningId(): string {
	return `hearth_${randomBytes(4).toString('hex')}`;
}

function rowFor(userId: number): PrefsRow | undefined {
	return getDb().prepare('SELECT * FROM mining_prefs WHERE user_id = ?').get(userId) as
		| PrefsRow
		| undefined;
}

/**
 * Return the user's prefs, creating the row (and a unique mining_id) on first
 * touch. The mining_id is generated with a uniqueness retry: a collision on
 * the UNIQUE(mining_id) index (astronomically unlikely at 2^32 space) just
 * draws a new id. Idempotent -- an existing row with a mining_id is returned
 * unchanged.
 */
export function ensureMiningPrefs(userId: number): MiningPrefs {
	const existing = rowFor(userId);
	if (existing && existing.mining_id) return toPrefs(existing);

	for (let attempt = 0; attempt < 8; attempt++) {
		const miningId = generateMiningId();
		try {
			getDb()
				.prepare(
					`INSERT INTO mining_prefs (user_id, mining_id, enabled, updated_at)
					 VALUES (?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
					 ON CONFLICT(user_id) DO UPDATE SET
					   mining_id = excluded.mining_id,
					   updated_at = excluded.updated_at
					 WHERE mining_prefs.mining_id IS NULL`
				)
				.run(userId, miningId);
			const after = rowFor(userId);
			if (after && after.mining_id) {
				onPrefsChanged();
				return toPrefs(after);
			}
		} catch (e) {
			// UNIQUE(mining_id) collision -- retry with a fresh id.
			logWarn('mining', { event: 'mining_id_collision', userId, attempt, err: String(e) });
		}
	}
	throw new Error('could not allocate a unique mining_id');
}

/** The user's prefs, or null when they've never had a row created. */
export function getMiningPrefs(userId: number): MiningPrefs | null {
	const row = rowFor(userId);
	return row ? toPrefs(row) : null;
}

/**
 * Point the user's payout at one of THEIR wallets, or null to clear it.
 * Rejects a wallet that isn't the caller's own or that can't receive (no
 * keys/xpub) -- a foreign or unpayable wallet must never be settable as a
 * payout target, since the engine would otherwise try to build a coinbase to
 * an address the user doesn't control. Ensures the prefs row exists first.
 */
export function setPayoutWallet(userId: number, walletId: number | null): MiningPrefs {
	ensureMiningPrefs(userId);
	if (walletId !== null) {
		const wallet = getWallet(userId, walletId);
		if (!wallet) throw new Error('wallet not found');
		if (wallet.keys.length === 0 || wallet.keys.every((k) => !k.xpub || k.xpub.trim() === '')) {
			throw new Error('wallet cannot receive a payout (no extended public key)');
		}
	}
	getDb()
		.prepare(
			`UPDATE mining_prefs
			    SET payout_wallet_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			  WHERE user_id = ?`
		)
		.run(walletId, userId);
	onPrefsChanged();
	return toPrefs(rowFor(userId)!);
}

/** Turn this user's mining on or off. Ensures the prefs row exists first. */
export function setUserMiningEnabled(userId: number, enabled: boolean): MiningPrefs {
	ensureMiningPrefs(userId);
	getDb()
		.prepare(
			`UPDATE mining_prefs
			    SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			  WHERE user_id = ?`
		)
		.run(enabled ? 1 : 0, userId);
	onPrefsChanged();
	return toPrefs(rowFor(userId)!);
}

/**
 * Rotate the user's Stratum identity token (e.g. if they believe it leaked).
 * The old token stops resolving after the next authTable refresh; any miner
 * still authorizing with it is rejected UNAUTHORIZED and must be
 * reconfigured.
 */
export function regenerateMiningId(userId: number): MiningPrefs {
	ensureMiningPrefs(userId);
	for (let attempt = 0; attempt < 8; attempt++) {
		const miningId = generateMiningId();
		try {
			getDb()
				.prepare(
					`UPDATE mining_prefs
					    SET mining_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
					  WHERE user_id = ?`
				)
				.run(miningId, userId);
			onPrefsChanged();
			return toPrefs(rowFor(userId)!);
		} catch (e) {
			logWarn('mining', { event: 'mining_id_collision_regenerate', userId, attempt, err: String(e) });
		}
	}
	throw new Error('could not allocate a unique mining_id');
}
