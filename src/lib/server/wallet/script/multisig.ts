/**
 * Multisig ScriptEngine (WALLET-ENGINE §3.1, §3.2, §3.4): p2sh / p2sh-p2wsh /
 * p2wsh sortedmulti(M-of-N). ALL multisig-specific behaviour lives here; every
 * layer above the seam is kind-blind. Never touches a private key (§5.1) --
 * signatures arrive externally and are merged by combine().
 *
 * Key rules:
 *  - BIP-67: cosigner pubkeys are lexicographically re-sorted PER ADDRESS, so
 *    stored key order never affects a derived address.
 *  - N bip32Derivations per input/change, in witness (sorted) order.
 *  - signingProgress `collected` = the MINIMUM per-input signature count.
 *  - finalize is quorum-gated; combine guards foreign sigs + non-SIGHASH_ALL.
 */
import type { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type {
	MultisigScriptType,
	SigningProgress,
	SpendableUtxo,
	Wallet
} from '../types.js';
import {
	encodeP2sh,
	encodeSegwitV0,
	hash160,
	networkParams,
	p2shScript,
	parseXpub,
	witnessV0Script,
	type NetworkParams
} from '../derive.js';
import {
	fingerprintToU32,
	finalizeTx,
	parseHdPath,
	parsePsbt,
	psbtToBase64,
	samePsbtIdentity,
	type Bip32Derivation,
	type ChangeMeta,
	type DerivedScript,
	type PsbtInputMeta,
	type ScriptEngine
} from './engine.js';
import {
	DifferentTransactionError,
	ForeignSignatureError,
	NotFullySignedError,
	WrongSighashError
} from '../errors.js';

const RBF_SEQUENCE = 0xfffffffd;
const SIG_PUSH_BYTES = 73; // 1 length byte + up to 72-byte low-S DER sig

interface Cosigner {
	account: HDKey;
	fpU32: number;
	fpHex: string;
	originPath: number[];
	displayPath: string;
	chainNodes: Record<0 | 1, HDKey | undefined>;
}

/** Byte-lexicographic (BIP-67) compare of two compressed pubkeys. */
function comparePubkeys(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

export class MultisigEngine implements ScriptEngine {
	readonly kind = 'multisig' as const;
	readonly network: NetworkParams['network'];

	private readonly cosigners: Cosigner[];
	private readonly threshold: number; // M
	private readonly scriptType: MultisigScriptType;
	private readonly net: NetworkParams;

	constructor(wallet: Wallet) {
		if (wallet.keys.length < 2) throw new Error('multisig wallet needs at least 2 keys');
		this.threshold = wallet.threshold;
		this.scriptType = wallet.scriptType as MultisigScriptType;
		this.net = networkParams(wallet.network);
		this.network = wallet.network;
		this.cosigners = wallet.keys.map((k) => ({
			account: parseXpub(k.xpub).hdkey,
			fpU32: fingerprintToU32(k.fingerprint),
			fpHex: k.fingerprint,
			originPath: parseHdPath(k.path),
			displayPath: k.path,
			chainNodes: { 0: undefined, 1: undefined }
		}));
	}

	private childPub(cos: Cosigner, chain: 0 | 1, index: number): Uint8Array {
		let node = cos.chainNodes[chain];
		if (!node) {
			node = cos.account.deriveChild(chain);
			cos.chainNodes[chain] = node;
		}
		const pub = node.deriveChild(index).publicKey;
		if (!pub) throw new Error('failed to derive cosigner child pubkey');
		return pub;
	}

	/** Derive all cosigner pubkeys at (chain,index), BIP-67 sort, keep origin map. */
	private sortedKeys(
		chain: 0 | 1,
		index: number
	): { pubkeys: Uint8Array[]; derivations: Bip32Derivation[] } {
		const entries = this.cosigners.map((cos) => ({ cos, pub: this.childPub(cos, chain, index) }));
		entries.sort((a, b) => comparePubkeys(a.pub, b.pub));
		const pubkeys = entries.map((e) => e.pub);
		const derivations: Bip32Derivation[] = entries.map((e) => [
			e.pub,
			{ fingerprint: e.cos.fpU32, path: [...e.cos.originPath, chain, index] }
		]);
		return { pubkeys, derivations };
	}

	private witnessScriptFor(chain: 0 | 1, index: number): Uint8Array {
		const { pubkeys } = this.sortedKeys(chain, index);
		return btc.p2ms(this.threshold, pubkeys).script;
	}

	scriptFor(chain: 0 | 1, index: number): DerivedScript {
		const witnessScript = this.witnessScriptFor(chain, index);
		if (this.scriptType === 'p2wsh') {
			const program = sha256(witnessScript);
			return {
				address: encodeSegwitV0(program, this.net),
				scriptPubKey: witnessV0Script(program),
				witnessScript
			};
		}
		if (this.scriptType === 'p2sh') {
			const scriptH160 = hash160(witnessScript);
			return {
				address: encodeP2sh(scriptH160, this.net),
				scriptPubKey: p2shScript(scriptH160),
				witnessScript,
				redeemScript: witnessScript // bare p2sh: the multisig IS the redeem script
			};
		}
		// p2sh-p2wsh: outer P2SH wrapping the P2WSH program.
		const program = sha256(witnessScript);
		const redeemScript = witnessV0Script(program); // the p2wsh scriptPubKey
		const scriptH160 = hash160(redeemScript);
		return {
			address: encodeP2sh(scriptH160, this.net),
			scriptPubKey: p2shScript(scriptH160),
			witnessScript,
			redeemScript
		};
	}

	inputMeta(utxo: SpendableUtxo, rawPrevTx?: Uint8Array): PsbtInputMeta {
		const { derivations } = this.sortedKeys(utxo.chain, utxo.index);
		const script = this.scriptFor(utxo.chain, utxo.index);
		const meta: PsbtInputMeta = { bip32Derivation: derivations, sequence: RBF_SEQUENCE };
		if (this.scriptType === 'p2sh') {
			// Bare legacy p2sh: nonWitnessUtxo required; redeemScript = multisig script.
			if (rawPrevTx) meta.nonWitnessUtxo = rawPrevTx;
			meta.redeemScript = script.redeemScript;
		} else {
			meta.witnessUtxo = { script: script.scriptPubKey, amount: BigInt(utxo.valueSats) };
			meta.witnessScript = script.witnessScript;
			if (this.scriptType === 'p2sh-p2wsh') meta.redeemScript = script.redeemScript;
			if (rawPrevTx) meta.nonWitnessUtxo = rawPrevTx;
		}
		return meta;
	}

	changeMeta(index: number): ChangeMeta {
		const { derivations } = this.sortedKeys(1, index);
		const script = this.scriptFor(1, index);
		const meta: ChangeMeta = { bip32Derivation: derivations };
		if (this.scriptType === 'p2sh') {
			meta.redeemScript = script.redeemScript;
		} else {
			meta.witnessScript = script.witnessScript;
			if (this.scriptType === 'p2sh-p2wsh') meta.redeemScript = script.redeemScript;
		}
		return meta;
	}

	perInputVsize(): number {
		const M = this.threshold;
		const N = this.cosigners.length;
		const scriptLen = 3 + 34 * N;
		const scriptPush = scriptLen < 76 ? 1 : scriptLen < 256 ? 2 : 3;
		if (this.scriptType === 'p2wsh' || this.scriptType === 'p2sh-p2wsh') {
			const witnessWeight = 1 + 1 + M * SIG_PUSH_BYTES + scriptPush + scriptLen;
			const baseBytes =
				this.scriptType === 'p2wsh'
					? 36 + 1 + 4 // outpoint + empty-scriptSig varint + sequence
					: 36 + (1 + 1 + 34) + 4; // + scriptSig pushing the 34-byte p2wsh program
			return Math.ceil((baseBytes * 4 + witnessWeight) / 4);
		}
		// Bare p2sh legacy: OP_0 + M sigs + redeemScript push, all in scriptSig.
		const scriptSig = 1 + M * SIG_PUSH_BYTES + scriptPush + scriptLen;
		const sigVarint = scriptSig < 253 ? 1 : 3;
		return 36 + sigVarint + scriptSig + 4;
	}

	/** Set of expected cosigner pubkeys (hex) for a PSBT input, from its derivations. */
	private expectedPubkeys(input: ReturnType<btc.Transaction['getInput']>): Set<string> {
		const set = new Set<string>();
		const derivs = (input.bip32Derivation ?? []) as Bip32Derivation[];
		for (const [pub] of derivs) set.add(hex.encode(pub));
		return set;
	}

	signingProgress(psbtBase64: string): SigningProgress {
		const tx = parsePsbt(psbtBase64);
		const n = tx.inputsLength;
		const required = this.threshold;

		let complete = false;
		if (n > 0) {
			try {
				const clone = tx.clone();
				clone.finalize();
				complete = true;
			} catch {
				complete = false;
			}
		}

		// collected = the MINIMUM signature count across inputs (least-signed input).
		// Attribution: map each signed pubkey to its (fingerprint, path) via the
		// input's own bip32Derivation, so a cosigner is "signed" by identity, not
		// by re-derivation (WALLET-ENGINE §3.2: identity = master fp + origin path).
		let minCount = required;
		const signedIdentities: { fpU32: number; path: number[] }[] = [];
		if (n === 0) {
			minCount = 0;
		} else {
			for (let i = 0; i < n; i++) {
				const inp = tx.getInput(i);
				const sigs = (inp.partialSig ?? []) as [Uint8Array, Uint8Array][];
				const derivs = (inp.bip32Derivation ?? []) as Bip32Derivation[];
				const derivByPub = new Map(derivs.map(([p, d]) => [hex.encode(p), d]));
				const finalized =
					(inp.finalScriptWitness instanceof Array && inp.finalScriptWitness.length > 0) ||
					(inp.finalScriptSig instanceof Uint8Array && inp.finalScriptSig.length > 0);
				const count = finalized ? required : sigs.length;
				for (const [pub] of sigs) {
					const d = derivByPub.get(hex.encode(pub));
					if (d) signedIdentities.push({ fpU32: d.fingerprint, path: d.path });
				}
				if (count < minCount) minCount = count;
			}
		}
		const collected = complete ? required : minCount;

		const keys = this.cosigners.map((cos) => ({
			fingerprint: cos.fpHex,
			path: cos.displayPath,
			// Post-finalize the partialSigs are stripped; callers trust `complete`.
			signed: complete ? false : signedIdentities.some((s) => this.identityMatches(cos, s))
		}));

		return { required, collected, complete, inputCount: n, keys };
	}

	/** A signed identity belongs to this cosigner iff the master fingerprint AND
	 *  the account-level origin path prefix both match (two keys from one seed at
	 *  different BIP-48 accounts share a fingerprint -- disambiguate on path). */
	private identityMatches(cos: Cosigner, s: { fpU32: number; path: number[] }): boolean {
		if (s.fpU32 !== cos.fpU32) return false;
		if (s.path.length < cos.originPath.length) return false;
		for (let i = 0; i < cos.originPath.length; i++) {
			if (s.path[i] !== cos.originPath[i]) return false;
		}
		return true;
	}

	finalize(psbtBase64: string): { rawHex: string; txid: string } {
		const progress = this.signingProgress(psbtBase64);
		if (!progress.complete && progress.collected < progress.required) {
			throw new NotFullySignedError(
				`multisig needs ${progress.required} signatures; have ${progress.collected}`
			);
		}
		const tx = parsePsbt(psbtBase64);
		return finalizeTx(tx);
	}

	combine(baseBase64: string, incomingBase64: string): string {
		const base = parsePsbt(baseBase64);
		const incoming = parsePsbt(incomingBase64);

		if (!samePsbtIdentity(base, incoming)) {
			throw new DifferentTransactionError();
		}

		const n = base.inputsLength;
		for (let i = 0; i < n; i++) {
			const baseInp = base.getInput(i);
			const inInp = incoming.getInput(i);
			const expected = this.expectedPubkeys(baseInp);
			const incomingSigs = (inInp.partialSig ?? []) as [Uint8Array, Uint8Array][];
			for (const [pub, sig] of incomingSigs) {
				// SIGHASH_ALL only -- block SINGLE/NONE/ANYONECANPAY.
				if (sig.length === 0 || sig[sig.length - 1] !== 0x01) {
					throw new WrongSighashError();
				}
				if (!expected.has(hex.encode(pub))) {
					throw new ForeignSignatureError();
				}
			}
		}

		// Mechanical merge (idempotent for already-present sigs). Guards above ran
		// against the whole incoming set first, so a bad sig aborts before merge.
		base.combine(incoming);
		return psbtToBase64(base);
	}
}
