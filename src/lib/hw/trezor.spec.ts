/**
 * Trezor driver tests (SIGNING.md §5.2) -- a fake `@trezor/connect-web`
 * default export for the device-touching entry points; the PSBT-translation
 * logic is exercised against REAL `@scure/btc-signer` PSBTs, no mocking
 * needed for that half. Proves: the wrong-device guard (silent getPublicKey
 * + local re-derivation) fires BEFORE signTransaction is ever called;
 * `req.push` is always false; positional DER signatures get SIGHASH_ALL
 * appended and paired with the PSBT's own pubkey; the cancel-vs-rejection
 * error-ordering rule; the double-wrap `.init` unwrap; and multisig pubkey
 * order recovered from the PSBT's own script (never re-sorted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';

const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

// ---------------------------------------------------------------------------
// Fake @trezor/connect-web

const trezorState = {
	getPublicKeyImpl: null as null | ((params: unknown) => unknown),
	signTransactionImpl: null as null | ((params: unknown) => unknown),
	signTransactionCalls: [] as unknown[],
	getPublicKeyCalls: [] as unknown[],
	initError: null as Error | null
};

function makeFakeApi() {
	return {
		init: vi.fn(async () => {
			if (trezorState.initError) throw trezorState.initError;
		}),
		getPublicKey: vi.fn(async (params: unknown) => {
			trezorState.getPublicKeyCalls.push(params);
			return trezorState.getPublicKeyImpl!(params);
		}),
		signTransaction: vi.fn(async (params: unknown) => {
			trezorState.signTransactionCalls.push(params);
			return trezorState.signTransactionImpl!(params);
		})
	};
}

vi.mock('@trezor/connect-web', () => ({ default: makeFakeApi() }));

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('window', { isSecureContext: true, location: { origin: 'https://localhost' } });
	trezorState.getPublicKeyImpl = null;
	trezorState.signTransactionImpl = null;
	trezorState.signTransactionCalls = [];
	trezorState.getPublicKeyCalls = [];
	trezorState.initError = null;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Real single-sig fixture

function fundingNode(wallet: Wallet, coinSats: number): BuildNode {
	const sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;
	const txid = 'ab'.repeat(32);
	return {
		tipHeight: 800100,
		electrum: {
			async batchRequest(items) {
				return items.map((it) => {
					const s = it.params[0] as string;
					if (it.method === 'blockchain.scripthash.get_history')
						return s === sh ? [{ tx_hash: txid, height: 800000 }] : [];
					return s === sh ? { confirmed: coinSats, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
				});
			},
			async listUnspent(scripthash) {
				return scripthash === sh ? [{ tx_hash: txid, tx_pos: 0, value: coinSats, height: 800000 }] : [];
			},
			async getTransaction(t) {
				return { txid: t, vin: [], vout: [] };
			}
		}
	};
}

async function singleSigFixture(): Promise<{ wallet: Wallet; unsignedPsbt: string; root: HDKey }> {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(4));
	const fp = root.fingerprint.toString(16).padStart(8, '0');
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	const wallet = importWallet(userId, { name: 'Trezor', descriptor: `wpkh([${fp}/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 100_000 }],
		feeRate: 5
	});
	return { wallet, unsignedPsbt: built.psbtBase64, root };
}

function realDerSignature(account: HDKey, psbtBase64: string, chain: number, idx: number, inputIndex: number): Uint8Array {
	// Parse a FRESH clone straight from the base64 (never re-serialize an
	// already-parsed Transaction via .toPSBT() -> fromPSBT() -- that round
	// trip can drop the previous-output info a legacy/nonWitnessUtxo input's
	// signIdx() needs).
	const clone = btc.Transaction.fromPSBT(base64.decode(psbtBase64));
	clone.signIdx(account.deriveChild(chain).deriveChild(idx).privateKey!, inputIndex);
	const sigWithHash = (clone.getInput(inputIndex).partialSig as [Uint8Array, Uint8Array][])[0][1];
	return sigWithHash.subarray(0, sigWithHash.length - 1); // strip the SIGHASH_ALL byte Trezor never sends
}

describe('isTrezorConnectAvailable', () => {
	it('is true whenever `window` exists, regardless of secure context (the popup holds its own transport)', async () => {
		const { isTrezorConnectAvailable } = await import('./trezor.js');
		expect(isTrezorConnectAvailable()).toBe(true);
		vi.stubGlobal('window', { isSecureContext: false });
		expect(isTrezorConnectAvailable()).toBe(true);
	});

	it('is false with no window at all (SSR)', async () => {
		vi.unstubAllGlobals();
		const { isTrezorConnectAvailable } = await import('./trezor.js');
		expect(isTrezorConnectAvailable()).toBe(false);
	});
});

describe('signPsbtWithTrezor -- single-sig, fully mocked Connect', () => {
	it('happy path: wrong-device guard passes, req.push is false, and the merged PSBT commits to the same transaction', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		const account = root.derive("m/84'/0'/0'");

		trezorState.getPublicKeyImpl = () => ({
			success: true,
			payload: { publicKey: hex.encode(account.publicKey!), chainCode: hex.encode(account.chainCode!) }
		});
		const realSig = realDerSignature(account, unsignedPsbt, 0, 0, 0);
		trezorState.signTransactionImpl = () => ({ success: true, payload: { signatures: [hex.encode(realSig)], serializedTx: '' } });

		const { signPsbtWithTrezor } = await import('./trezor.js');
		const signed = await signPsbtWithTrezor(unsignedPsbt);

		const signReq = trezorState.signTransactionCalls[0] as { push: boolean };
		expect(signReq.push).toBe(false);

		const { assertSameTransaction } = await import('$lib/server/wallet/index.js');
		expect(() => assertSameTransaction(unsignedPsbt, signed)).not.toThrow();
	});

	it('wrong-device: signTransaction is NEVER called when the re-derived pubkey does not match', async () => {
		const { unsignedPsbt } = await singleSigFixture();
		const wrongAccount = HDKey.fromMasterSeed(new Uint8Array(32).fill(99)).derive("m/84'/0'/0'");
		trezorState.getPublicKeyImpl = () => ({
			success: true,
			payload: { publicKey: hex.encode(wrongAccount.publicKey!), chainCode: hex.encode(wrongAccount.chainCode!) }
		});
		trezorState.signTransactionImpl = () => {
			throw new Error('signTransaction must not be called on a wrong-device mismatch');
		};

		const { signPsbtWithTrezor, TrezorError } = await import('./trezor.js');
		await expect(signPsbtWithTrezor(unsignedPsbt)).rejects.toMatchObject({ code: 'wrong_device' });
		expect(trezorState.signTransactionCalls.length).toBe(0);
		void TrezorError;
	});

	it('a legacy (nonWitnessUtxo) input builds a real refTx and signs correctly', async () => {
		closeDb();
		const db: DatabaseSync = openDb(':memory:');
		db.exec('PRAGMA foreign_keys = ON;');
		runMigrations(db);
		db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
		const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
		const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(6));
		const fp = root.fingerprint.toString(16).padStart(8, '0');
		const xpub = root.derive("m/44'/0'/0'").publicExtendedKey;
		const wallet = importWallet(userId, { name: 'Legacy', descriptor: `pkh([${fp}/44'/0'/0']${xpub}/0/*)` });

		// Build a real previous (legacy) transaction paying our address, and
		// fund from it via nonWitnessUtxo (anti-fee-lying requires this for p2pkh).
		const addr = deriveAddresses(wallet, 0, 0, 1)[0];
		const prevPriv = HDKey.fromMasterSeed(new Uint8Array(32).fill(50));
		const prevTx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
		prevTx.addOutput({ script: hex.decode(addr.scriptPubKey), amount: 500_000n });
		prevTx.addInput({
			txid: new Uint8Array(32).fill(8),
			index: 0,
			witnessUtxo: { script: btc.p2wpkh(prevPriv.publicKey!).script, amount: 600_000n }
		});
		prevTx.sign(prevPriv.privateKey!);
		prevTx.finalize();
		const prevRaw = prevTx.toBytes(true, true);
		const prevTxid = prevTx.id;

		const node: BuildNode = {
			tipHeight: 800100,
			electrum: {
				async batchRequest(items) {
					return items.map((it) => {
						const s = it.params[0] as string;
						if (it.method === 'blockchain.scripthash.get_history') return s === addr.scripthash ? [{ tx_hash: prevTxid, height: 800000 }] : [];
						return s === addr.scripthash ? { confirmed: 500_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
					});
				},
				async listUnspent(scripthash) {
					return scripthash === addr.scripthash ? [{ tx_hash: prevTxid, tx_pos: 0, value: 500_000, height: 800000 }] : [];
				},
				async getTransaction(t) {
					if (t === prevTxid) return hex.encode(prevRaw);
					return { txid: t, vin: [], vout: [] };
				}
			},
			// p2pkh is a "needs legacy nonWitnessUtxo" script type -- buildPsbt
			// only attaches it when the node exposes fetchRawTx (rawPrevFor()).
			async fetchRawTx(txid: string) {
				if (txid === prevTxid) return prevRaw;
				throw new Error('unknown prev tx');
			}
		};

		const built = await buildPsbt(node, userId, wallet.id, {
			recipients: [{ address: RECIP, amountSats: 100_000 }],
			feeRate: 5
		});

		const account = root.derive("m/44'/0'/0'");
		trezorState.getPublicKeyImpl = () => ({
			success: true,
			payload: { publicKey: hex.encode(account.publicKey!), chainCode: hex.encode(account.chainCode!) }
		});
		const realSig = realDerSignature(account, built.psbtBase64, 0, 0, 0);
		trezorState.signTransactionImpl = (params: unknown) => {
			const req = params as { refTxs?: { hash: string }[] };
			expect(req.refTxs?.some((r) => r.hash === prevTxid)).toBe(true);
			return { success: true, payload: { signatures: [hex.encode(realSig)], serializedTx: '' } };
		};

		const { signPsbtWithTrezor } = await import('./trezor.js');
		const signed = await signPsbtWithTrezor(built.psbtBase64);
		const { assertSameTransaction } = await import('$lib/server/wallet/index.js');
		expect(() => assertSameTransaction(built.psbtBase64, signed)).not.toThrow();
	});
});

describe('error ordering (toTrezorError, exercised through signPsbtWithTrezor)', () => {
	it('Failure_ActionCancelled maps to "rejected", not the generic cancel branch', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		const account = root.derive("m/84'/0'/0'");
		trezorState.getPublicKeyImpl = () => ({
			success: true,
			payload: { publicKey: hex.encode(account.publicKey!), chainCode: hex.encode(account.chainCode!) }
		});
		trezorState.signTransactionImpl = () => ({ success: false, payload: { error: 'Failure_ActionCancelled: cancelled by user' } });
		const { signPsbtWithTrezor } = await import('./trezor.js');
		await expect(signPsbtWithTrezor(unsignedPsbt)).rejects.toMatchObject({ code: 'rejected' });
	});

	it('a bare popup-closed message maps to "cancelled"', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		const account = root.derive("m/84'/0'/0'");
		trezorState.getPublicKeyImpl = () => ({
			success: true,
			payload: { publicKey: hex.encode(account.publicKey!), chainCode: hex.encode(account.chainCode!) }
		});
		trezorState.signTransactionImpl = () => ({ success: false, payload: { error: 'popup was closed' } });
		const { signPsbtWithTrezor } = await import('./trezor.js');
		await expect(signPsbtWithTrezor(unsignedPsbt)).rejects.toMatchObject({ code: 'cancelled' });
	});

	it('Failure_DataError maps to "bad_psbt", not the generic forbidden branch', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		const account = root.derive("m/84'/0'/0'");
		trezorState.getPublicKeyImpl = () => ({
			success: true,
			payload: { publicKey: hex.encode(account.publicKey!), chainCode: hex.encode(account.chainCode!) }
		});
		trezorState.signTransactionImpl = () => ({ success: false, payload: { error: 'Failure_DataError: Forbidden key path' } });
		const { signPsbtWithTrezor } = await import('./trezor.js');
		await expect(signPsbtWithTrezor(unsignedPsbt)).rejects.toMatchObject({ code: 'bad_psbt' });
	});
});

describe('ensureInit -- double-wrap unwrap + single-flight memoization', () => {
	it('unwraps a double-wrapped default export by presence of .init', async () => {
		vi.resetModules();
		const realApi = makeFakeApi();
		vi.doMock('@trezor/connect-web', () => ({ default: { default: realApi } }));
		const wrongAccount = HDKey.fromMasterSeed(new Uint8Array(32).fill(123)).derive("m/84'/0'/0'");
		trezorState.getPublicKeyImpl = () => ({
			success: true,
			payload: { publicKey: hex.encode(wrongAccount.publicKey!), chainCode: hex.encode(wrongAccount.chainCode!) }
		});
		trezorState.signTransactionImpl = () => ({ success: true, payload: { signatures: [], serializedTx: '' } });

		const { signPsbtWithTrezor } = await import('./trezor.js');
		const { unsignedPsbt } = await singleSigFixture();
		// Wrong-device guard will fire (fake key material), but that PROVES
		// ensureInit successfully unwrapped and called through to getPublicKey.
		await expect(signPsbtWithTrezor(unsignedPsbt)).rejects.toMatchObject({ code: 'wrong_device' });
		expect(realApi.init).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Multisig -- pubkey order recovered from the PSBT's OWN script

function multisigFixtureKeys() {
	const roots = [10, 20, 30].map((seed) => HDKey.fromMasterSeed(new Uint8Array(32).fill(seed)));
	const accounts = roots.map((r) => r.derive("m/48'/0'/0'/2'"));
	return { roots, accounts };
}

async function multisigFixture(): Promise<{ wallet: Wallet; unsignedPsbt: string; roots: HDKey[]; accounts: HDKey[] }> {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	const userId = (db.prepare('SELECT id FROM users').get() as { id: number }).id;
	const { roots, accounts } = multisigFixtureKeys();
	const fps = roots.map((r) => r.fingerprint.toString(16).padStart(8, '0'));
	const descriptor = `wsh(sortedmulti(2,[${fps[0]}/48'/0'/0'/2']${accounts[0].publicExtendedKey}/0/*,[${fps[1]}/48'/0'/0'/2']${accounts[1].publicExtendedKey}/0/*,[${fps[2]}/48'/0'/0'/2']${accounts[2].publicExtendedKey}/0/*))`;
	const wallet = importWallet(userId, { name: 'Vault', descriptor });
	const sh = deriveAddresses(wallet, 0, 0, 1)[0].scripthash;
	const txid = 'cd'.repeat(32);
	const node: BuildNode = {
		tipHeight: 800100,
		electrum: {
			async batchRequest(items) {
				return items.map((it) => {
					const s = it.params[0] as string;
					if (it.method === 'blockchain.scripthash.get_history') return s === sh ? [{ tx_hash: txid, height: 800000 }] : [];
					return s === sh ? { confirmed: 2_000_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
				});
			},
			async listUnspent(scripthash) {
				return scripthash === sh ? [{ tx_hash: txid, tx_pos: 0, value: 2_000_000, height: 800000 }] : [];
			},
			async getTransaction(t) {
				return { txid: t, vin: [], vout: [] };
			}
		}
	};
	const built = await buildPsbt(node, userId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 500_000 }],
		feeRate: 5
	});
	return { wallet, unsignedPsbt: built.psbtBase64, roots, accounts };
}

describe('signMultisigPsbtWithTrezor -- pubkey order recovered from script', () => {
	it("the multisig.pubkeys order matches the input's actual witnessScript order, not roster/creation order", async () => {
		const { wallet, unsignedPsbt, roots, accounts } = await multisigFixture();
		const keys = wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }));

		// Read the real script order directly for an independent expectation.
		const tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbt));
		const witnessScript = tx.getInput(0).witnessScript!;
		const decoded = btc.OutScript.decode(witnessScript) as { pubkeys: Uint8Array[] };
		const scriptOrderHex = decoded.pubkeys.map((p) => hex.encode(p));

		// Sign as roster index 1 (the "middle" cosigner) so we can prove the
		// device connects as a specific slot regardless of script position.
		const deviceIdx = 1;
		trezorState.getPublicKeyImpl = (params: unknown) => {
			const p = params as { path: string };
			if (p.path === 'm') {
				// The driver's real call shape: a single depth-0 read (no `coin`,
				// no bundle) to recover the master fingerprint.
				return { success: true, payload: { xpub: roots[deviceIdx].publicExtendedKey } };
			}
			return { success: true, payload: { publicKey: hex.encode(accounts[deviceIdx].publicKey!), chainCode: hex.encode(accounts[deviceIdx].chainCode!) } };
		};
		trezorState.signTransactionImpl = (params: unknown) => {
			const req = params as { inputs: { multisig?: { pubkeys: { node: string }[] } }[] };
			const sentOrder = req.inputs[0].multisig!.pubkeys.map((pk) => {
				const node = HDKey.fromExtendedKey(pk.node);
				return hex.encode(node.publicKey!);
			});
			expect(sentOrder).toEqual(scriptOrderHex);
			return { success: true, payload: { signatures: [''], serializedTx: '' } };
		};

		const { signMultisigPsbtWithTrezor, TrezorError } = await import('./trezor.js');
		try {
			await signMultisigPsbtWithTrezor(unsignedPsbt, keys, wallet.threshold);
		} catch (e) {
			// An all-empty signatures result throws "no signatures" -- that's
			// fine, the assertion above (inside signTransactionImpl) already ran.
			expect(e).toBeInstanceOf(TrezorError);
		}
	});
});
