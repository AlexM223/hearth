/**
 * In-memory authorization snapshot for the Stratum engine (implements
 * AuthProvider, MINING-ENGINE.md §3.1). The engine calls {@link AuthTable.resolve}
 * INSIDE the socket data handler, so it must be a pure synchronous Map lookup
 * with zero I/O -- all the real work (DB reads, per-wallet address
 * derivation) happens out of band in {@link refreshAuthTable}, driven by the
 * lifecycle (engine start, a 60s timer, and the prefs-change hook).
 *
 * Build rule: one entry per enabled mining_prefs row that has a valid,
 * payable payout wallet. A per-user failure (missing wallet, unencodable
 * address) is logged and that user is skipped -- the refresh NEVER throws
 * and never lets one bad row drop everyone.
 *
 * Ported as a pattern from cairn's mining/authTable.ts. Deviation: hearth has
 * no single global "configured chain network" setting (each wallet infers its
 * own network from its xpub version bytes, DECISIONS.md §2) -- the mining
 * engine instead resolves ONE network from Bitcoin Core's own
 * getblockchaininfo().chain at start time (index.ts) and passes it in here;
 * a wallet whose OWN network doesn't match is skipped exactly like any other
 * per-user failure (its address won't encode against the wrong network's
 * bech32 prefix, so this falls out of addressToOutputScript's own check with
 * no special-casing needed).
 */
import { getDb } from '../db/index.js';
import { getWallet, peekReceiveAddress } from '../wallet/index.js';
import { logWarn } from '../log.js';
import { addressToOutputScript, type Network } from './address.js';
import type { AuthProvider, MinerAuth } from './types.js';

class AuthTable implements AuthProvider {
	private map = new Map<string, MinerAuth>();

	/** Pure, synchronous, zero-I/O -- safe to call on the Stratum hot path. */
	resolve(miningId: string): MinerAuth | null {
		return this.map.get(miningId) ?? null;
	}

	/** Atomically swap in a freshly built snapshot (never mutate the live map
	 *  in place -- resolve() must always see a consistent set). */
	replace(next: Map<string, MinerAuth>): void {
		this.map = next;
	}

	get size(): number {
		return this.map.size;
	}

	/** Snapshot of the currently authorized MinerAuth entries, for read models
	 *  / admin views. */
	entries(): MinerAuth[] {
		return [...this.map.values()];
	}
}

const authTable = new AuthTable();

/** The process-wide AuthProvider the MiningPool is constructed with. */
export function getAuthTable(): AuthTable {
	return authTable;
}

interface EnabledPrefsRow {
	user_id: number;
	mining_id: string;
	payout_wallet_id: number | null;
}

/**
 * Rebuild the snapshot from the current DB state, against `network` (the
 * ONE network the mining engine resolved from Bitcoin Core at start time --
 * see the module note). Deriving a wallet's current receive address is pure/
 * sync in hearth (peekReceiveAddress, no chain call needed -- the receive
 * cursor is already the DB-held source of truth), but this function stays
 * `async` to match the AuthProvider refresh contract every caller (index.ts's
 * 60s timer, onPrefsChanged) already expects, and to leave room for a future
 * chain-backed check without changing every call site.
 *
 * Builds into a fresh Map and swaps it in atomically at the end, so a
 * resolve() concurrent with a rebuild always sees either the old or the new
 * complete set, never a half-built one.
 */
export async function refreshAuthTable(network: Network): Promise<void> {
	let rows: EnabledPrefsRow[];
	try {
		rows = getDb()
			.prepare(
				`SELECT user_id, mining_id, payout_wallet_id
				   FROM mining_prefs
				  WHERE enabled = 1 AND mining_id IS NOT NULL AND payout_wallet_id IS NOT NULL`
			)
			.all() as unknown as EnabledPrefsRow[];
	} catch (e) {
		logWarn('mining', { event: 'auth_table_refresh_read_failed', err: String(e) });
		return;
	}

	const next = new Map<string, MinerAuth>();
	for (const row of rows) {
		try {
			const wallet = getWallet(row.user_id, row.payout_wallet_id!);
			if (!wallet) {
				logWarn('mining', { event: 'auth_table_wallet_missing', userId: row.user_id, walletId: row.payout_wallet_id });
				continue;
			}
			const peek = peekReceiveAddress(wallet);
			const script = addressToOutputScript(peek.address, network);
			next.set(row.mining_id, {
				userId: row.user_id,
				miningId: row.mining_id,
				walletId: wallet.id,
				address: peek.address,
				payoutScript: new Uint8Array(script)
			});
		} catch (e) {
			// One user's failure never aborts the rebuild or drops other miners.
			logWarn('mining', { event: 'auth_table_skip_miner', userId: row.user_id, err: String(e) });
		}
	}
	authTable.replace(next);
}

/** Test-only: reset the process-wide table between specs. */
export function __resetAuthTableForTests(): void {
	authTable.replace(new Map());
}
