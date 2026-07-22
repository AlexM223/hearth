/**
 * PSBT build -> review -> commitment-check (WALLET-ENGINE §2.5). buildPsbt runs
 * a live UTXO refresh, excludes reserved coins, selects coins (select.ts),
 * builds the unsigned PSBT via the ScriptEngine's per-input metadata, persists
 * a draft (+ inputs + frozen multisig roster), and returns the review. KIND-
 * BLIND except the injected ScriptEngine. assertSameTransaction is the
 * commitment check (§4.9 invariant 2). All amounts integer sats.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import type { BuiltDraft, Recipient, ReviewSummary, SpendableUtxo, Wallet } from './types.js';
import { selectEngine, parsePsbt, samePsbtIdentity, inputsIdentity, outputsIdentity, type ScriptEngine } from './script/engine.js';
import {
	bip69SortInputs,
	bip69SortOutputs,
	selectCoins,
	type Selection,
	type SelectionOutput
} from './select.js';
import { syncWallet, getUtxos, type SyncNode } from './sync.js';
import { decodeAddress } from './address.js';
import {
	getWalletRow,
	insertDraft,
	reservedOutpoints,
	updateCursors,
	walletKeyIds,
	getDraftRow,
	updateDraftPsbt,
	getDraftInputRows,
	type NewDraft
} from './repo.js';
import {
	AlreadyReplacedError,
	CommitmentError,
	InvalidFeeRateError,
	InvalidRecipientError,
	NotFoundError,
	WalletError
} from './errors.js';
import type { SigningProgress } from './types.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface BuildNode extends SyncNode {
	getMinFeeRate?(): Promise<number> | number;
	fetchRawTx?(txid: string): Promise<Uint8Array>;
}

export interface BuildRequest {
	recipients: Recipient[];
	feeRate: number;
	onlyUtxos?: { txid: string; vout: number }[];
	replacesTxid?: string;
}

/** Shape/range-validate the raw request BEFORE touching the node or the DB
 *  (UX sweep hearth-5vw). An empty Send form (no client-side gate; that's a
 *  separate fix in the wallet detail page) used to reach `selectCoins`/
 *  `decodeAddress` with a plausible-looking but garbage body -- empty
 *  address, `amountSats: 0` (`Number('')` is `0`, not `NaN`) -- and when the
 *  node was ALSO unreachable (syncWallet/resolveMinFeeRate throw untyped
 *  network errors first), the caller never got as far as the typed
 *  validation, surfacing as a raw 500 ("something went wrong") instead of a
 *  400 with a plain-language message. Every failure here is a WalletError ->
 *  httpStatusFor maps it to 400, unconditionally, regardless of whether the
 *  node backends are reachable. */
function assertValidBuildRequest(req: BuildRequest): void {
	if (!Array.isArray(req.recipients) || req.recipients.length === 0) {
		throw new WalletError('enter at least one recipient');
	}
	for (const r of req.recipients) {
		if (r == null || typeof r.address !== 'string' || r.address.trim() === '') {
			throw new InvalidRecipientError('enter a recipient address');
		}
		if (r.amountSats !== 'max') {
			if (
				typeof r.amountSats !== 'number' ||
				!Number.isFinite(r.amountSats) ||
				!Number.isInteger(r.amountSats) ||
				r.amountSats <= 0
			) {
				throw new WalletError('enter an amount in sats');
			}
		}
	}
	if (typeof req.feeRate !== 'number' || !Number.isFinite(req.feeRate) || req.feeRate <= 0) {
		throw new InvalidFeeRateError('enter a fee rate');
	}
}

async function resolveMinFeeRate(node: BuildNode): Promise<number> {
	if (!node.getMinFeeRate) return 1;
	const v = await node.getMinFeeRate();
	return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Legacy inputs (p2pkh / bare p2sh) require the full prev tx (nonWitnessUtxo);
 *  segwit adds it best-effort as anti-fee-lying. */
async function rawPrevFor(node: BuildNode, u: SpendableUtxo, wallet: Wallet): Promise<Uint8Array | undefined> {
	const needsLegacy = wallet.scriptType === 'p2pkh' || wallet.scriptType === 'p2sh';
	if (!node.fetchRawTx) return undefined;
	if (!needsLegacy) return undefined; // keep segwit builds hermetic
	try {
		return await node.fetchRawTx(u.txid);
	} catch {
		return undefined;
	}
}

/** Build an unsigned PSBT + persist the draft. Serialized per userId (§5.4). */
export async function buildPsbt(
	node: BuildNode,
	userId: number,
	walletId: number,
	req: BuildRequest
): Promise<BuiltDraft> {
	// Validate the request SHAPE before anything else -- no lock, no wallet
	// lookup, no node call. Guarantees a clean 400 for a malformed/empty Send
	// form even when the node backends are unreachable (hearth-5vw).
	assertValidBuildRequest(req);

	// The whole reserve -> select -> persist runs under the build lock so the
	// window is atomic across the Electrum await (import lazily to avoid a cycle).
	const { withLock } = await import('./lock.js');
	return withLock('wallet-build:' + userId, async () => {
		const wallet = getWalletRow(userId, walletId);
		if (!wallet) throw new NotFoundError('wallet not found');
		const engine = selectEngine(wallet);

		// LIVE utxo refresh (never trust the cache for spending) then read.
		await syncWallet(node, walletId, { forceRefresh: true });
		const utxos = getUtxos(walletId);
		const reserved = reservedOutpoints(userId);
		const minFeeRate = await resolveMinFeeRate(node);

		const selection = selectCoins({
			engine,
			scriptType: wallet.scriptType,
			network: wallet.network,
			utxos,
			recipients: req.recipients,
			feeRate: req.feeRate,
			minFeeRate,
			tipHeight: node.tipHeight ?? null,
			reservedOutpoints: reserved,
			onlyUtxos: req.onlyUtxos
		});

		const changeIndex = selection.changeAmountSats != null ? wallet.changeCursor : null;
		const psbtBase64 = await constructPsbt(node, wallet, engine, selection, changeIndex);

		const recipientsForStore = selection.recipients.map((r) => ({
			address: r.address,
			amountSats: r.amountSats
		}));
		const amountSats = recipientsForStore.reduce((s, r) => s + r.amountSats, 0);

		const newDraft: NewDraft = {
			walletId,
			createdBy: userId,
			psbt: psbtBase64,
			recipients: recipientsForStore,
			amountSats,
			feeSats: selection.feeSats,
			feeRate: req.feeRate,
			changeIndex,
			replacesTxid: req.replacesTxid ?? null,
			expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
			inputs: selection.inputs.map((u) => ({ txid: u.txid, vout: u.vout, valueSats: u.valueSats })),
			signers:
				wallet.kind === 'multisig'
					? [{ userId, assignedKeyIds: walletKeyIds(walletId) }]
					: undefined
		};
		let draftId: number;
		try {
			draftId = insertDraft(newDraft);
		} catch (e) {
			// The RBF partial-unique index (idx_psbt_drafts_replaces) is the real
			// gate: at most one live replacement per replaced txid (§1).
			if (req.replacesTxid && /UNIQUE|constraint/i.test(String((e as Error).message))) {
				throw new AlreadyReplacedError();
			}
			throw e;
		}
		if (changeIndex != null) {
			updateCursors(walletId, wallet.receiveCursor, Math.max(wallet.changeCursor, changeIndex + 1));
		}

		const review = buildReviewFromSelection(wallet, engine, selection, psbtBase64);
		return { draftId, psbtBase64, review };
	});
}

/** Construct the unsigned PSBT: BIP-69 ordered inputs + outputs, change stamped
 *  with bip32Derivation so a signer recognizes it pays back to this wallet. */
async function constructPsbt(
	node: BuildNode,
	wallet: Wallet,
	engine: ScriptEngine,
	selection: Selection,
	changeIndex: number | null
): Promise<string> {
	const tx = new btc.Transaction({ version: 2, allowUnknownOutputs: false });

	for (const u of bip69SortInputs(selection.inputs)) {
		const rawPrev = await rawPrevFor(node, u, wallet);
		const meta = engine.inputMeta(u, rawPrev);
		tx.addInput({ txid: hex.decode(u.txid), index: u.vout, ...meta });
	}

	const outputs: SelectionOutput[] = selection.recipients.map((r) => ({
		address: r.address,
		scriptPubKey: r.scriptPubKey,
		amountSats: r.amountSats,
		isChange: false,
		kind: r.kind
	}));
	if (selection.changeAmountSats != null && changeIndex != null) {
		const changeScript = engine.scriptFor(1, changeIndex);
		// Heartwood gap fix (§6.1): validate the CHANGE address through the same
		// recipient validator, and assert it encodes to the engine's scriptPubKey
		// (a derived-address bug can't quietly send change to the wrong script).
		const decodedChange = decodeAddress(changeScript.address, wallet.network);
		if (hex.encode(decodedChange.scriptPubKey) !== hex.encode(changeScript.scriptPubKey)) {
			throw new WalletError('internal error: change address did not match its script');
		}
		outputs.push({
			address: changeScript.address,
			scriptPubKey: changeScript.scriptPubKey,
			amountSats: selection.changeAmountSats,
			isChange: true,
			kind: 'p2wpkh' // kind only affects vsize/dust (already computed); not used here
		});
	}

	for (const o of bip69SortOutputs(outputs)) {
		if (!o.scriptPubKey) continue;
		if (o.isChange && changeIndex != null) {
			const cm = engine.changeMeta(changeIndex);
			tx.addOutput({ script: o.scriptPubKey, amount: BigInt(o.amountSats), ...cm });
		} else {
			tx.addOutput({ script: o.scriptPubKey, amount: BigInt(o.amountSats) });
		}
	}
	return base64.encode(tx.toPSBT());
}

function buildReviewFromSelection(
	wallet: Wallet,
	engine: ScriptEngine,
	selection: Selection,
	psbtBase64: string
): ReviewSummary {
	return {
		walletId: wallet.id,
		kind: wallet.kind,
		recipients: selection.recipients.map((r) => ({ address: r.address, amountSats: r.amountSats })),
		changeAmountSats: selection.changeAmountSats,
		feeSats: selection.feeSats,
		feeRate: selection.feeSats / selection.vsize,
		vsize: selection.vsize,
		inputs: selection.inputs.map((u) => ({
			txid: u.txid,
			vout: u.vout,
			valueSats: u.valueSats,
			address: u.address
		})),
		totalInputSats: selection.totalInputSats,
		progress: engine.signingProgress(psbtBase64)
	};
}

/** Recompute the review for a stored draft (kind-blind). progress from PSBT. */
export function reviewSummary(userId: number, walletId: number, draftId: number): ReviewSummary {
	const wallet = getWalletRow(userId, walletId);
	if (!wallet) throw new NotFoundError('wallet not found');
	const draft = getDraftRow(walletId, draftId);
	if (!draft) throw new NotFoundError('draft not found');
	const engine = selectEngine(wallet);

	const tx = parsePsbt(draft.psbt);
	// Authoritative per-input values (red-team review LOW-1): `psbt_draft_inputs`
	// was recorded from the REAL selection at build time and is correct for
	// every script type. Re-deriving from the PSBT's witnessUtxo (the previous
	// approach) silently read 0 for legacy p2pkh/bare-p2sh inputs, which carry
	// nonWitnessUtxo instead -- producing a bogus totalInputSats=0 and a
	// negative changeAmountSats on this re-fetched review screen (the FIRST
	// review, buildReviewFromSelection below, was never affected).
	const authoritative = new Map(
		getDraftInputRows(draftId).map((r) => [`${r.txid}:${r.vout}`, r.valueSats])
	);
	const inputs: ReviewSummary['inputs'] = [];
	let totalInputSats = 0;
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		const txid = inp.txid ? hex.encode(inp.txid) : '';
		const vout = inp.index ?? 0;
		const fromRow = authoritative.get(`${txid}:${vout}`);
		// Fall back to witnessUtxo only if the authoritative row is somehow
		// missing (should not happen -- defense in depth, never a silent 0).
		const valueSats = fromRow ?? (inp.witnessUtxo ? Number(inp.witnessUtxo.amount) : 0);
		totalInputSats += valueSats;
		inputs.push({ txid, vout, valueSats, address: '' });
	}

	return {
		walletId,
		kind: wallet.kind,
		recipients: draft.recipients,
		changeAmountSats: draft.changeIndex != null ? totalInputSats - draft.amountSats - draft.feeSats : null,
		feeSats: draft.feeSats,
		feeRate: draft.feeRate,
		vsize: draft.feeSats > 0 && draft.feeRate > 0 ? Math.round(draft.feeSats / draft.feeRate) : 0,
		inputs,
		totalInputSats,
		progress: engine.signingProgress(draft.psbt)
	};
}

/** Merge an externally-produced signed PSBT into a draft (WALLET-ENGINE §2.5).
 *  Source is a WebHID result, an air-gapped PSBT file, or a reassembled BBQr QR
 *  payload -- all arrive as base64 PSBT; this function does not care which.
 *  Single-sig: assertSameTransaction then adopt. Multisig: combine (foreign-sig +
 *  SIGHASH_ALL guards). Persists the merged PSBT, moves draft -> signing. NEVER
 *  holds keys -- signing happened outside the process. */
export function applySignature(
	userId: number,
	walletId: number,
	draftId: number,
	signedPsbtBase64: string
): { review: ReviewSummary; progress: SigningProgress } {
	const wallet = getWalletRow(userId, walletId);
	if (!wallet) throw new NotFoundError('wallet not found');
	const draft = getDraftRow(walletId, draftId);
	if (!draft) throw new NotFoundError('draft not found');
	if (draft.status === 'broadcast' || draft.status === 'confirmed') {
		throw new WalletError('this draft has already been broadcast');
	}
	const engine = selectEngine(wallet);

	let merged: string;
	if (wallet.kind === 'single') {
		assertSameTransaction(draft.psbt, signedPsbtBase64);
		merged = signedPsbtBase64;
	} else {
		if (!engine.combine) throw new WalletError('multisig engine cannot combine');
		merged = engine.combine(draft.psbt, signedPsbtBase64);
	}

	const progress = engine.signingProgress(merged);
	const nextStatus = progress.collected > 0 ? 'signing' : draft.status;
	updateDraftPsbt(draftId, merged, nextStatus);

	return { review: reviewSummary(userId, walletId, draftId), progress };
}

/** THE commitment check (WALLET-ENGINE §4.9 invariant 2, §5.2). Byte-for-byte
 *  compares the reviewed draft's inputs (outpoints, order-sensitive) and outputs
 *  (scriptPubKey:amount, order-sensitive) against the signed PSBT; refuses on ANY
 *  difference (signing never changes these fields). Throws CommitmentError. */
export function assertSameTransaction(draftPsbtBase64: string, signedPsbtBase64: string): void {
	const draft = parsePsbt(draftPsbtBase64);
	const signed = parsePsbt(signedPsbtBase64);
	if (draft.inputsLength !== signed.inputsLength) {
		throw new CommitmentError('the signed transaction changed the number of inputs');
	}
	if (draft.outputsLength !== signed.outputsLength) {
		throw new CommitmentError('the signed transaction changed the number of outputs');
	}
	if (inputsIdentity(draft) !== inputsIdentity(signed)) {
		throw new CommitmentError('the signed transaction spends different inputs than you reviewed');
	}
	if (outputsIdentity(draft) !== outputsIdentity(signed)) {
		throw new CommitmentError('the signed transaction pays different outputs than you reviewed');
	}
	// (samePsbtIdentity is the same comparison; kept explicit above for messages.)
	if (!samePsbtIdentity(draft, signed)) {
		throw new CommitmentError('the signed transaction does not match what you reviewed');
	}
}
