/**
 * Coin selection + fee/vsize/dust model (WALLET-ENGINE §2.6). Algorithm:
 * confirmed-first, largest-value-first accumulation (NOT BnB), hand-rolled so
 * fractional sat/vB fee rates work. Deterministic. Kind-blind: only
 * perInputVsize comes from the injected ScriptEngine. All amounts integer sats.
 */
import type { ScriptType, SpendableUtxo } from './types.js';
import { decodeAddress, type OutputKind, type DecodedAddress } from './address.js';
import type { ChainNetwork } from './types.js';
import type { ScriptEngine } from './script/engine.js';
import { InsufficientFundsError, InvalidFeeRateError } from './errors.js';

export const TX_OVERHEAD_VSIZE = 11;
export const DUST_RELAY_FEE_RATE = 3;
export const MAX_FEE_RATE = 1000;
export const COINBASE_MATURITY = 100;

/** outputVsize = 9 + scriptPubKey length (§2.6). */
const OUTPUT_VSIZE: Record<OutputKind, number> = {
	p2pkh: 34,
	p2sh: 32,
	p2wpkh: 31,
	p2wsh: 43,
	p2tr: 43
};
/** Assumed spend vsize for the dust formula: witness 67, legacy 148. */
const ASSUMED_SPEND: Record<OutputKind, number> = {
	p2pkh: 148,
	p2sh: 148,
	p2wpkh: 67,
	p2wsh: 67,
	p2tr: 67
};

export function outputVsize(kind: OutputKind): number {
	return OUTPUT_VSIZE[kind];
}
/** Core-exact dust threshold per destination type (546/540/294/330). */
export function dustThreshold(kind: OutputKind): number {
	return (OUTPUT_VSIZE[kind] + ASSUMED_SPEND[kind]) * DUST_RELAY_FEE_RATE;
}

/** Change output kind for a wallet's own script type. */
export function changeKind(scriptType: ScriptType): OutputKind {
	switch (scriptType) {
		case 'p2pkh':
			return 'p2pkh';
		case 'p2wpkh':
			return 'p2wpkh';
		case 'p2wsh':
			return 'p2wsh';
		case 'p2sh-p2wpkh':
		case 'p2sh-p2wsh':
		case 'p2sh':
			return 'p2sh';
	}
}

export interface SelectionRecipient {
	address: string;
	amountSats: number; // resolved (send-max already turned into a number)
	scriptPubKey: Uint8Array;
	kind: OutputKind;
}

export interface SelectionOutput {
	address: string | null; // null for change (address stamped later by build)
	scriptPubKey: Uint8Array | null;
	amountSats: number;
	isChange: boolean;
	kind: OutputKind;
}

export interface Selection {
	inputs: SpendableUtxo[];
	recipients: SelectionRecipient[];
	changeAmountSats: number | null;
	feeSats: number;
	vsize: number;
	totalInputSats: number;
}

export interface SelectRequest {
	engine: ScriptEngine;
	scriptType: ScriptType;
	network: ChainNetwork;
	utxos: SpendableUtxo[];
	recipients: { address: string; amountSats: number | 'max' }[];
	feeRate: number;
	minFeeRate: number;
	tipHeight: number | null;
	reservedOutpoints?: Set<string>; // "txid:vout"
	onlyUtxos?: { txid: string; vout: number }[]; // coin control
}

function outpointKey(txid: string, vout: number): string {
	return `${txid}:${vout}`;
}

function assertFeeRate(feeRate: number, minFeeRate: number): void {
	if (!Number.isFinite(feeRate) || feeRate <= 0) {
		throw new InvalidFeeRateError('fee rate must be a positive number');
	}
	if (feeRate < minFeeRate) {
		throw new InvalidFeeRateError(`fee rate is below the relay minimum (${minFeeRate} sat/vB)`);
	}
	if (feeRate > MAX_FEE_RATE) {
		throw new InvalidFeeRateError(`fee rate above the ${MAX_FEE_RATE} sat/vB sanity ceiling`);
	}
}

/** Estimate vsize for a candidate set. */
function estimateVsize(
	numInputs: number,
	perInputVsize: number,
	recipients: SelectionRecipient[],
	withChange: boolean,
	changeOutputKind: OutputKind
): number {
	let v = TX_OVERHEAD_VSIZE + numInputs * perInputVsize;
	for (const r of recipients) v += outputVsize(r.kind);
	if (withChange) v += outputVsize(changeOutputKind);
	return v;
}

const feeFor = (vsize: number, feeRate: number): number => Math.ceil(vsize * feeRate);

/** BIP-69 ordering: inputs (txid asc, vout asc). */
export function bip69SortInputs(inputs: SpendableUtxo[]): SpendableUtxo[] {
	return [...inputs].sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
}

/** BIP-69 ordering: outputs (value asc, then scriptPubKey hex asc). */
export function bip69SortOutputs(outputs: SelectionOutput[]): SelectionOutput[] {
	return [...outputs].sort((a, b) => {
		if (a.amountSats !== b.amountSats) return a.amountSats - b.amountSats;
		const ah = a.scriptPubKey ? hexOf(a.scriptPubKey) : '';
		const bh = b.scriptPubKey ? hexOf(b.scriptPubKey) : '';
		return ah < bh ? -1 : ah > bh ? 1 : 0;
	});
}

function hexOf(u8: Uint8Array): string {
	let s = '';
	for (const b of u8) s += b.toString(16).padStart(2, '0');
	return s;
}

/** Candidate filter (§2.6): confirmed OR own-change unconfirmed; exclude
 *  immature coinbase (fail-closed when tip unknown) and reserved coins. */
function candidateFilter(
	utxos: SpendableUtxo[],
	tipHeight: number | null,
	reserved: Set<string>
): SpendableUtxo[] {
	return utxos.filter((u) => {
		const spendableState = u.height > 0 || u.unconfirmedTrust === 'own-change';
		if (!spendableState) return false;
		if (reserved.has(outpointKey(u.txid, u.vout))) return false;
		if (u.coinbase) {
			if (tipHeight == null || u.height <= 0) return false; // fail-closed
			const confs = tipHeight - u.height + 1;
			if (confs < COINBASE_MATURITY) return false;
		}
		return true;
	});
}

/** Sort confirmed-first, then value desc; stable. */
function orderCandidates(utxos: SpendableUtxo[]): SpendableUtxo[] {
	return [...utxos]
		.map((u, i) => ({ u, i }))
		.sort((a, b) => {
			const ac = a.u.height > 0 ? 0 : 1;
			const bc = b.u.height > 0 ? 0 : 1;
			if (ac !== bc) return ac - bc;
			if (a.u.valueSats !== b.u.valueSats) return b.u.valueSats - a.u.valueSats;
			return a.i - b.i; // stable
		})
		.map((x) => x.u);
}

export function selectCoins(req: SelectRequest): Selection {
	assertFeeRate(req.feeRate, req.minFeeRate);
	if (req.recipients.length === 0) throw new InsufficientFundsError('no recipients');

	const perInputVsize = req.engine.perInputVsize();
	const changeOutputKind = changeKind(req.scriptType);
	const reserved = req.reservedOutpoints ?? new Set<string>();

	// Resolve + validate recipient scripts (change address validated too, later).
	const sendMax = req.recipients.some((r) => r.amountSats === 'max');
	if (sendMax && req.recipients.length !== 1) {
		throw new InsufficientFundsError('send-max supports exactly one recipient');
	}

	// Candidate set: coin-control uses exactly the allowlist (reserved exempt but
	// nothing to warn on here -- the caller surfaces that); else the auto filter.
	let candidates: SpendableUtxo[];
	if (req.onlyUtxos && req.onlyUtxos.length > 0) {
		const allow = new Set(req.onlyUtxos.map((o) => outpointKey(o.txid, o.vout)));
		candidates = req.utxos.filter((u) => allow.has(outpointKey(u.txid, u.vout)));
	} else {
		candidates = candidateFilter(req.utxos, req.tipHeight, reserved);
	}
	candidates = orderCandidates(candidates);

	if (sendMax) return selectSendMax(req, candidates, perInputVsize);

	const recipients: SelectionRecipient[] = req.recipients.map((r) => {
		const decoded: DecodedAddress = decodeAddress(r.address, req.network);
		const amount = r.amountSats as number;
		if (amount < dustThreshold(decoded.kind)) {
			throw new InsufficientFundsError(
				`amount ${amount} is below the dust threshold for that address type`
			);
		}
		return { address: r.address, amountSats: amount, scriptPubKey: decoded.scriptPubKey, kind: decoded.kind };
	});
	const amount = recipients.reduce((s, r) => s + r.amountSats, 0);

	const selected: SpendableUtxo[] = [];
	let totalIn = 0;
	for (const coin of candidates) {
		selected.push(coin);
		totalIn += coin.valueSats;
		const numInputs = selected.length;
		const vsizeWithChange = estimateVsize(numInputs, perInputVsize, recipients, true, changeOutputKind);
		const vsizeWithoutChange = estimateVsize(numInputs, perInputVsize, recipients, false, changeOutputKind);
		const feeWithChange = feeFor(vsizeWithChange, req.feeRate);
		const feeWithoutChange = feeFor(vsizeWithoutChange, req.feeRate);
		const changeDust = dustThreshold(changeOutputKind);

		if (totalIn >= amount + feeWithChange + changeDust + 1) {
			const changeValue = totalIn - amount - feeWithChange;
			return {
				inputs: selected.slice(),
				recipients,
				changeAmountSats: changeValue,
				feeSats: feeWithChange,
				vsize: vsizeWithChange,
				totalInputSats: totalIn
			};
		}
		if (totalIn >= amount + feeWithoutChange) {
			return {
				inputs: selected.slice(),
				recipients,
				changeAmountSats: null,
				feeSats: totalIn - amount,
				vsize: vsizeWithoutChange,
				totalInputSats: totalIn
			};
		}
	}
	throw new InsufficientFundsError(
		reserved.size > 0
			? 'not enough spendable funds -- some coins are reserved by a pending draft'
			: 'not enough spendable funds to cover this send plus fees'
	);
}

function selectSendMax(req: SelectRequest, candidates: SpendableUtxo[], perInputVsize: number): Selection {
	if (candidates.length === 0) throw new InsufficientFundsError('no spendable coins to sweep');
	const decoded = decodeAddress(req.recipients[0].address, req.network);
	const recipients: SelectionRecipient[] = [
		{ address: req.recipients[0].address, amountSats: 0, scriptPubKey: decoded.scriptPubKey, kind: decoded.kind }
	];
	const totalIn = candidates.reduce((s, c) => s + c.valueSats, 0);
	const vsize = estimateVsize(candidates.length, perInputVsize, recipients, false, decoded.kind);
	const fee = feeFor(vsize, req.feeRate);
	const amount = totalIn - fee;
	if (amount < dustThreshold(decoded.kind)) {
		throw new InsufficientFundsError('after fees the swept amount would be dust');
	}
	recipients[0].amountSats = amount;
	return {
		inputs: candidates.slice(),
		recipients,
		changeAmountSats: null,
		feeSats: fee,
		vsize,
		totalInputSats: totalIn
	};
}
