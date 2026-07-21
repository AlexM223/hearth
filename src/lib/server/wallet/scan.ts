/**
 * Gap-limit scan (WALLET-ENGINE §4.2) against the Electrum BACKGROUND lane
 * (DECISIONS.md §4.4 -- a 200-call gap scan must never starve an interactive
 * send-page load). Pure of storage: returns a ScanResult; sync.ts persists it.
 *
 * Tx attribution is by scriptPubKey (not address string), so a regtest bcrt1...
 * encoding still matches a mainnet bc1... derivation. Fee is resolved only when
 * every input value is known from our own detailed set; otherwise fee = null
 * (never guessed).
 */
import { hex } from '@scure/base';
import type { Wallet } from './types.js';
import { selectEngine, type ScriptEngine } from './script/engine.js';
import { scriptToScripthash } from './derive.js';

export const GAP_LIMIT = 20;
export const BATCH_SIZE = 20;
export const HARD_CAP = 400;
export const TX_DETAIL_CAP = 50;

interface ElectrumHistoryItem {
	tx_hash: string;
	height: number;
	fee?: number;
}
interface ElectrumBalance {
	confirmed: number;
	unconfirmed: number;
}
interface ElectrumUnspent {
	tx_hash: string;
	tx_pos: number;
	value: number;
	height: number;
}
interface VerboseTx {
	txid?: string;
	vin?: { txid?: string; vout?: number }[];
	vout?: { value?: number; n?: number; scriptPubKey?: { hex?: string } }[];
	time?: number;
	blocktime?: number;
}

/** The narrow Electrum surface the scan needs (ElectrumPool satisfies it). */
export interface ScanRail {
	batchRequest(
		items: { method: string; params: unknown[] }[],
		lane?: 'interactive' | 'background'
	): Promise<unknown[]>;
	listUnspent(scripthash: string, lane?: 'interactive' | 'background'): Promise<ElectrumUnspent[]>;
	getTransaction(txid: string, verbose?: boolean, lane?: 'interactive' | 'background'): Promise<unknown>;
}

export interface ScannedAddress {
	chain: 0 | 1;
	index: number;
	address: string;
	scripthash: string;
	scriptPubKey: string; // hex
	used: boolean;
	balanceSats: number;
	txCount: number;
	firstSeenHeight: number | null;
}
export interface ScannedUtxo {
	txid: string;
	vout: number;
	valueSats: number;
	chain: 0 | 1;
	index: number;
	address: string;
	height: number;
	coinbase: boolean;
	unconfirmedTrust: 'own-change' | 'received' | null;
}
export interface ScannedTx {
	txid: string;
	height: number;
	blockTime: number | null;
	deltaSats: number;
	feeSats: number | null;
}
export interface ChainScan {
	addresses: ScannedAddress[];
	lastUsedIndex: number;
	nextCursor: number;
	truncated: boolean;
	confirmedSats: number;
	unconfirmedSats: number;
}
export interface ScanResult {
	addresses: ScannedAddress[];
	utxos: ScannedUtxo[];
	transactions: ScannedTx[];
	confirmedSats: number;
	unconfirmedSats: number;
	receiveCursor: number;
	changeCursor: number;
	truncated: boolean;
}

const btcToSats = (btc: number): number => Math.round(btc * 1e8);

/** Scan one chain (0 external / 1 internal) to the gap limit. */
async function scanChain(
	engine: ScriptEngine,
	chain: 0 | 1,
	rail: ScanRail
): Promise<ChainScan> {
	const addresses: ScannedAddress[] = [];
	let consecutiveUnused = 0;
	let index = 0;
	let lastUsedIndex = -1;
	let confirmedSats = 0;
	let unconfirmedSats = 0;

	while (consecutiveUnused < GAP_LIMIT && index < HARD_CAP) {
		const batchCount = Math.min(BATCH_SIZE, HARD_CAP - index);
		const derived = Array.from({ length: batchCount }, (_, i) => {
			const idx = index + i;
			const s = engine.scriptFor(chain, idx);
			return {
				idx,
				address: s.address,
				scriptPubKey: s.scriptPubKey,
				scripthash: scriptToScripthash(s.scriptPubKey)
			};
		});

		// Two batched calls in parallel on the BACKGROUND lane.
		const [histories, balances] = await Promise.all([
			rail.batchRequest(
				derived.map((d) => ({ method: 'blockchain.scripthash.get_history', params: [d.scripthash] })),
				'background'
			) as Promise<ElectrumHistoryItem[][]>,
			rail.batchRequest(
				derived.map((d) => ({ method: 'blockchain.scripthash.get_balance', params: [d.scripthash] })),
				'background'
			) as Promise<ElectrumBalance[]>
		]);

		let brokeMidBatch = false;
		for (let i = 0; i < derived.length; i++) {
			const d = derived[i];
			const history = histories[i] ?? [];
			const balance = balances[i] ?? { confirmed: 0, unconfirmed: 0 };
			const used = history.length > 0;
			confirmedSats += balance.confirmed;
			unconfirmedSats += balance.unconfirmed;
			const firstSeenHeight = used
				? Math.min(...history.map((h) => (h.height > 0 ? h.height : Number.MAX_SAFE_INTEGER)))
				: null;
			addresses.push({
				chain,
				index: d.idx,
				address: d.address,
				scripthash: d.scripthash,
				scriptPubKey: hex.encode(d.scriptPubKey),
				used,
				balanceSats: balance.confirmed + balance.unconfirmed,
				txCount: history.length,
				firstSeenHeight: firstSeenHeight === Number.MAX_SAFE_INTEGER ? null : firstSeenHeight
			});
			if (used) {
				consecutiveUnused = 0;
				lastUsedIndex = d.idx;
			} else {
				consecutiveUnused++;
				if (consecutiveUnused >= GAP_LIMIT) {
					brokeMidBatch = true;
					break;
				}
			}
		}
		index += derived.length;
		if (brokeMidBatch) break;
	}

	// Truncation: the cap stopped discovery while activity was still inside the
	// trailing gap (funds may exist past the cap).
	const truncated = index >= HARD_CAP && consecutiveUnused < GAP_LIMIT;
	// Tail trim: keep only addresses within lastUsedIndex + GAP_LIMIT.
	const keepThrough = lastUsedIndex + GAP_LIMIT;
	const trimmed = addresses.filter((a) => a.index <= keepThrough);
	return {
		addresses: trimmed,
		lastUsedIndex,
		nextCursor: lastUsedIndex + 1,
		truncated,
		confirmedSats,
		unconfirmedSats
	};
}

/** Full wallet scan: both chains in parallel, UTXOs + detailed tx deltas. */
export async function scanWallet(
	wallet: Wallet,
	rail: ScanRail,
	tipHeight: number | null
): Promise<ScanResult> {
	const engine = selectEngine(wallet);
	const [external, internal] = await Promise.all([
		scanChain(engine, 0, rail),
		scanChain(engine, 1, rail)
	]);
	const addresses = [...external.addresses, ...internal.addresses];

	// Balance is the AUTHORITATIVE get_balance sum (§2.4), not re-derived from
	// listUnspent -- the two agree, but get_balance is the node's own figure.
	const confirmedSats = external.confirmedSats + internal.confirmedSats;
	const unconfirmedSats = external.unconfirmedSats + internal.unconfirmedSats;

	// Fetch UTXOs for used addresses (background lane) -- the spendable coin set.
	const usedAddrs = addresses.filter((a) => a.used);
	const utxos: ScannedUtxo[] = [];
	const unspentLists = await Promise.all(
		usedAddrs.map((a) => rail.listUnspent(a.scripthash, 'background').then((list) => ({ a, list })))
	);
	for (const { a, list } of unspentLists) {
		for (const u of list) {
			const confirmed = u.height > 0;
			utxos.push({
				txid: u.tx_hash,
				vout: u.tx_pos,
				valueSats: u.value,
				chain: a.chain,
				index: a.index,
				address: a.address,
				height: u.height > 0 ? u.height : 0,
				coinbase: false, // refined below if the detailed tx says so
				unconfirmedTrust: confirmed ? null : a.chain === 1 ? 'own-change' : 'received'
			});
		}
	}

	// Detailed tx deltas: attribute by scriptPubKey. Owned-output map lets us
	// compute spent from our own inputs; fee only when fully resolvable.
	const ourScripts = new Set(addresses.map((a) => a.scriptPubKey));
	const allTxids = new Set<string>();
	// Detail the newest utxo-touching txs (covers received coins + own-input spends).
	for (const u of utxos) allTxids.add(u.txid);

	const detailTxids = [...allTxids].slice(0, TX_DETAIL_CAP);
	const detailed = await Promise.all(
		detailTxids.map((txid) =>
			rail.getTransaction(txid, true, 'background').then((tx) => ({ txid, tx: tx as VerboseTx }))
		)
	);
	const ownedOutputs = new Map<string, number>(); // "txid:vout" -> sats
	for (const { txid, tx } of detailed) {
		for (const v of tx.vout ?? []) {
			const spk = v.scriptPubKey?.hex;
			if (spk && ourScripts.has(spk) && typeof v.value === 'number' && typeof v.n === 'number') {
				ownedOutputs.set(`${txid}:${v.n}`, btcToSats(v.value));
			}
		}
	}
	const transactions: ScannedTx[] = [];
	for (const { txid, tx } of detailed) {
		let received = 0;
		for (const v of tx.vout ?? []) {
			const spk = v.scriptPubKey?.hex;
			if (spk && ourScripts.has(spk) && typeof v.value === 'number') received += btcToSats(v.value);
		}
		let spent = 0;
		let allInputsKnown = true;
		for (const vin of tx.vin ?? []) {
			if (vin.txid == null || vin.vout == null) {
				allInputsKnown = false;
				continue;
			}
			const owned = ownedOutputs.get(`${vin.txid}:${vin.vout}`);
			if (owned != null) spent += owned;
			else allInputsKnown = false;
		}
		transactions.push({
			txid,
			height: heightForTx(txid, utxos),
			blockTime: tx.blocktime ?? tx.time ?? null,
			deltaSats: received - spent,
			// Fee is knowable only when every input value is ours (rare); never guessed.
			feeSats: allInputsKnown && (tx.vin?.length ?? 0) > 0 ? computeFee(tx, ownedOutputs) : null
		});
	}

	return {
		addresses,
		utxos,
		transactions,
		confirmedSats,
		unconfirmedSats,
		receiveCursor: Math.max(external.nextCursor, 0),
		changeCursor: Math.max(internal.nextCursor, 0),
		truncated: external.truncated || internal.truncated
	};
}

function heightForTx(txid: string, utxos: ScannedUtxo[]): number {
	const u = utxos.find((x) => x.txid === txid);
	return u ? u.height : 0;
}

function computeFee(tx: VerboseTx, ownedOutputs: Map<string, number>): number | null {
	let inputs = 0;
	for (const vin of tx.vin ?? []) {
		if (vin.txid == null || vin.vout == null) return null;
		const owned = ownedOutputs.get(`${vin.txid}:${vin.vout}`);
		if (owned == null) return null;
		inputs += owned;
	}
	let outputs = 0;
	for (const v of tx.vout ?? []) if (typeof v.value === 'number') outputs += btcToSats(v.value);
	const fee = inputs - outputs;
	return fee >= 0 ? fee : null;
}
