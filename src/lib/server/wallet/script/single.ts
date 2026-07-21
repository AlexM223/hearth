/**
 * Single-sig ScriptEngine (WALLET-ENGINE §3.1, §3.2): p2pkh / p2sh-p2wpkh /
 * p2wpkh of one derived child pubkey. All script/sighash specifics live HERE;
 * everything above the seam is kind-blind. Never touches a private key (§5.1).
 */
import type { HDKey } from '@scure/bip32';
import type { SigningProgress, SingleScriptType, SpendableUtxo, Wallet } from '../types.js';
import {
	encodeP2pkh,
	encodeP2sh,
	encodeSegwitV0,
	hash160,
	networkParams,
	p2pkhScript,
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
	type Bip32Derivation,
	type ChangeMeta,
	type DerivedScript,
	type PsbtInputMeta,
	type ScriptEngine
} from './engine.js';

const RBF_SEQUENCE = 0xfffffffd;

/** vsize per input by script type (WALLET-ENGINE §2.6, Heartwood verbatim). */
const INPUT_VSIZE: Record<SingleScriptType, number> = {
	p2pkh: 148,
	'p2sh-p2wpkh': 91,
	p2wpkh: 68
};

export class SingleSigEngine implements ScriptEngine {
	readonly kind = 'single' as const;
	readonly network: NetworkParams['network'];

	private readonly account: HDKey;
	private readonly scriptType: SingleScriptType;
	private readonly net: NetworkParams;
	private readonly originPath: number[];
	private readonly fpU32: number;
	private readonly fpHex: string;
	private readonly displayPath: string;
	/** Memoized chain node (account/chain) so the hot scan loop doesn't re-derive it. */
	private readonly chainNodes: Record<0 | 1, HDKey | undefined> = { 0: undefined, 1: undefined };

	constructor(wallet: Wallet) {
		const key = wallet.keys[0];
		if (!key) throw new Error('single-sig wallet has no key');
		this.account = parseXpub(key.xpub).hdkey;
		this.scriptType = wallet.scriptType as SingleScriptType;
		this.net = networkParams(wallet.network);
		this.network = wallet.network;
		this.originPath = parseHdPath(key.path);
		this.fpHex = key.fingerprint;
		this.fpU32 = fingerprintToU32(key.fingerprint);
		this.displayPath = key.path;
	}

	private chainNode(chain: 0 | 1): HDKey {
		let node = this.chainNodes[chain];
		if (!node) {
			node = this.account.deriveChild(chain);
			this.chainNodes[chain] = node;
		}
		return node;
	}

	private childPubkey(chain: 0 | 1, index: number): Uint8Array {
		const pub = this.chainNode(chain).deriveChild(index).publicKey;
		if (!pub) throw new Error('failed to derive child public key');
		return pub;
	}

	scriptFor(chain: 0 | 1, index: number): DerivedScript {
		const pub = this.childPubkey(chain, index);
		const h160 = hash160(pub);
		if (this.scriptType === 'p2wpkh') {
			return { address: encodeSegwitV0(h160, this.net), scriptPubKey: witnessV0Script(h160) };
		}
		if (this.scriptType === 'p2pkh') {
			return { address: encodeP2pkh(h160, this.net), scriptPubKey: p2pkhScript(h160) };
		}
		// p2sh-p2wpkh: wrap the v0 witness program in a P2SH.
		const redeemScript = witnessV0Script(h160);
		const scriptH160 = hash160(redeemScript);
		return {
			address: encodeP2sh(scriptH160, this.net),
			scriptPubKey: p2shScript(scriptH160),
			redeemScript
		};
	}

	private derivation(chain: 0 | 1, index: number, pub: Uint8Array): Bip32Derivation {
		return [pub, { fingerprint: this.fpU32, path: [...this.originPath, chain, index] }];
	}

	inputMeta(utxo: SpendableUtxo, rawPrevTx?: Uint8Array): PsbtInputMeta {
		const pub = this.childPubkey(utxo.chain, utxo.index);
		const script = this.scriptFor(utxo.chain, utxo.index);
		const meta: PsbtInputMeta = {
			bip32Derivation: [this.derivation(utxo.chain, utxo.index, pub)],
			sequence: RBF_SEQUENCE
		};
		if (this.scriptType === 'p2pkh') {
			// Legacy MUST use nonWitnessUtxo (the full prev tx) -- there is no
			// witnessUtxo shortcut. Without it, finalize will fail (reported honestly).
			if (rawPrevTx) meta.nonWitnessUtxo = rawPrevTx;
		} else {
			meta.witnessUtxo = { script: script.scriptPubKey, amount: BigInt(utxo.valueSats) };
			if (this.scriptType === 'p2sh-p2wpkh') meta.redeemScript = script.redeemScript;
			// Belt-and-suspenders anti-fee-lying for v0 segwit when we have it.
			if (rawPrevTx) meta.nonWitnessUtxo = rawPrevTx;
		}
		return meta;
	}

	changeMeta(index: number): ChangeMeta {
		const pub = this.childPubkey(1, index);
		const meta: ChangeMeta = { bip32Derivation: [this.derivation(1, index, pub)] };
		if (this.scriptType === 'p2sh-p2wpkh') {
			meta.redeemScript = witnessV0Script(hash160(pub));
		}
		return meta;
	}

	perInputVsize(): number {
		return INPUT_VSIZE[this.scriptType];
	}

	signingProgress(psbtBase64: string): SigningProgress {
		const tx = parsePsbt(psbtBase64);
		const n = tx.inputsLength;
		let allSigned = n > 0;
		let allFinal = n > 0;
		for (let i = 0; i < n; i++) {
			const inp = tx.getInput(i);
			const hasPartial = Array.isArray(inp.partialSig) && inp.partialSig.length > 0;
			const hasFinalSig = inp.finalScriptSig instanceof Uint8Array && inp.finalScriptSig.length > 0;
			const hasFinalWit = Array.isArray(inp.finalScriptWitness) && inp.finalScriptWitness.length > 0;
			const final = hasFinalSig || hasFinalWit;
			if (!(hasPartial || final)) allSigned = false;
			if (!final) allFinal = false;
		}
		let complete = allFinal;
		if (!complete && allSigned) {
			try {
				const clone = tx.clone();
				clone.finalize();
				complete = true;
			} catch {
				complete = false;
			}
		}
		const collected = complete || allSigned ? 1 : 0;
		return {
			required: 1,
			collected,
			complete,
			inputCount: n,
			keys: [{ fingerprint: this.fpHex, path: this.displayPath, signed: collected === 1 }]
		};
	}

	finalize(psbtBase64: string): { rawHex: string; txid: string } {
		const tx = parsePsbt(psbtBase64);
		return finalizeTx(tx);
	}
}
