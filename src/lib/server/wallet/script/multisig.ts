/**
 * Multisig ScriptEngine (WALLET-ENGINE §3.1, §3.2, §3.4): p2sh / p2sh-p2wsh /
 * p2wsh sortedmulti(M-of-N). BIP-67 sort per address, N bip32Derivations,
 * exact vsize, combine (foreign-sig / wrong-sighash guards), signingProgress
 * (minimum per-input signature count), finalize (quorum-gated).
 *
 * Fully implemented in T2. This T1 placeholder satisfies the ScriptEngine
 * interface so selectEngine() compiles; single-sig (T1) never instantiates it.
 */
import type { SigningProgress, SpendableUtxo, Wallet } from '../types.js';
import type { ChangeMeta, DerivedScript, PsbtInputMeta, ScriptEngine } from './engine.js';
import type { NetworkParams } from '../derive.js';

export class MultisigEngine implements ScriptEngine {
	readonly kind = 'multisig' as const;
	readonly network: NetworkParams['network'];

	constructor(wallet: Wallet) {
		this.network = wallet.network;
	}

	private notYet(): never {
		throw new Error('multisig ScriptEngine lands in T2');
	}

	scriptFor(_chain: 0 | 1, _index: number): DerivedScript {
		return this.notYet();
	}
	inputMeta(_utxo: SpendableUtxo, _rawPrevTx?: Uint8Array): PsbtInputMeta {
		return this.notYet();
	}
	changeMeta(_index: number): ChangeMeta {
		return this.notYet();
	}
	perInputVsize(): number {
		return this.notYet();
	}
	signingProgress(_psbtBase64: string): SigningProgress {
		return this.notYet();
	}
	finalize(_psbtBase64: string): { rawHex: string; txid: string } {
		return this.notYet();
	}
}
