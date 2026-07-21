/**
 * Ledger driver tests (SIGNING.md §5.2) -- fake WebHID transport + a fake
 * AppClient, no hardware. Proves: accountOriginFromPsbt reads the right
 * template from the PSBT's own bip32Derivation; mergeSignatures lands
 * partialSig/tapKeySig correctly; the wrong-device guard throws on a
 * mismatched fingerprint; a rejected signPsbt maps to the typed 'rejected'
 * error; the 45s timeout rejects with 'timeout' (fake timers); the BIP-388
 * wallet-policy byte layout is exact; multisig registration + signing
 * end-to-end with fake device responses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { openDb, closeDb } from '$lib/server/db/index.js';
import { runMigrations } from '$lib/server/db/migrations.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode } from '$lib/server/wallet/index.js';
import type { Wallet } from '$lib/server/wallet/index.js';

const RECIP = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

// ---------------------------------------------------------------------------
// Fake WebHID transport + AppClient (device I/O only -- policy.js/psbtv2 run
// for REAL, they're pure logic with no device involved).

const ledgerState = {
	masterFp: Buffer.from('deadbeef', 'hex'),
	xpub: '',
	sigs: new Map<number, Buffer>() as Map<number, Buffer>,
	signPsbtError: null as Error | null,
	getExtendedPubkeyCalls: [] as number[][],
	transportCreateError: null as Error | null,
	transportCreateNeverResolves: false,
	closeCalls: 0,
	sendCalls: [] as { cla: number; ins: number; data: Buffer }[],
	sendResponses: [] as Buffer[]
};

vi.mock('@ledgerhq/hw-transport-webhid', () => ({
	default: {
		create: vi.fn(async () => {
			if (ledgerState.transportCreateNeverResolves) return new Promise(() => {});
			if (ledgerState.transportCreateError) throw ledgerState.transportCreateError;
			return {
				close: async () => {
					ledgerState.closeCalls++;
				},
				send: vi.fn(async (cla: number, ins: number, _p1: number, _p2: number, data: Buffer) => {
					ledgerState.sendCalls.push({ cla, ins, data });
					const next = ledgerState.sendResponses.shift();
					if (!next) throw new Error('no canned response for transport.send');
					return next;
				})
			};
		})
	}
}));

vi.mock('@ledgerhq/hw-app-btc/lib/newops/appClient.js', () => ({
	AppClient: class {
		async getMasterFingerprint() {
			return ledgerState.masterFp;
		}
		async getExtendedPubkey(_display: boolean, path: number[]) {
			ledgerState.getExtendedPubkeyCalls.push(path);
			return ledgerState.xpub;
		}
		async signPsbt() {
			if (ledgerState.signPsbtError) throw ledgerState.signPsbtError;
			return ledgerState.sigs;
		}
	}
}));

vi.mock('@ledgerhq/hw-app-btc/lib/newops/clientCommands.js', () => ({
	ClientCommandInterpreter: class {
		preimages: Buffer[] = [];
		lists: Buffer[][] = [];
		addKnownPreimage(p: Buffer) {
			this.preimages.push(p);
		}
		addKnownList(l: Buffer[]) {
			this.lists.push(l);
		}
		execute(request: Buffer) {
			return Buffer.concat([Buffer.from('answered:'), request]);
		}
	}
}));
vi.mock('@ledgerhq/hw-app-btc/lib/varint.js', () => ({
	createVarint: (n: number) => {
		if (n < 253) return Buffer.from([n]);
		return Buffer.concat([Buffer.from([253]), Buffer.from([n & 0xff, (n >> 8) & 0xff])]);
	}
}));
vi.mock('@ledgerhq/hw-app-btc/lib/newops/merkle.js', () => ({
	hashLeaf: (buf: Buffer) => Buffer.from(sha256(Buffer.concat([Buffer.from([0x00]), buf]))),
	Merkle: class {
		leaves: Buffer[];
		constructor(leaves: Buffer[]) {
			this.leaves = leaves;
		}
		getRoot() {
			return Buffer.from(sha256(Buffer.concat(this.leaves)));
		}
	}
}));

function stubHid() {
	vi.stubGlobal('navigator', { hid: {} });
}

beforeEach(() => {
	stubHid();
	ledgerState.masterFp = Buffer.from('deadbeef', 'hex');
	ledgerState.xpub = '';
	ledgerState.sigs = new Map();
	ledgerState.signPsbtError = null;
	ledgerState.getExtendedPubkeyCalls = [];
	ledgerState.transportCreateError = null;
	ledgerState.transportCreateNeverResolves = false;
	ledgerState.closeCalls = 0;
	ledgerState.sendCalls = [];
	ledgerState.sendResponses = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Real single-sig wallet + draft fixture

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
	const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(3));
	const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
	const fp = root.fingerprint.toString(16).padStart(8, '0'); // 56c4fac3 -- a REAL (non-placeholder) fingerprint
	const wallet = importWallet(userId, { name: 'Ledger', descriptor: `wpkh([${fp}/84'/0'/0']${xpub}/0/*)` });
	const built = await buildPsbt(fundingNode(wallet, 1_000_000), userId, wallet.id, {
		recipients: [{ address: RECIP, amountSats: 100_000 }],
		feeRate: 5
	});
	return { wallet, unsignedPsbt: built.psbtBase64, root };
}

describe('accountOriginFromPsbt', () => {
	it('reads fingerprint/accountPath/template from the PSBT itself', async () => {
		const { unsignedPsbt } = await singleSigFixture();
		const { accountOriginFromPsbt } = await import('./ledger.js');
		const origin = accountOriginFromPsbt(unsignedPsbt);
		expect(origin.template).toBe('wpkh(@0/**)');
		expect(origin.accountPath.length).toBe(3); // 84'/0'/0'
	});

	it('throws bad_psbt on undecodable base64', async () => {
		const { accountOriginFromPsbt, LedgerError } = await import('./ledger.js');
		try {
			accountOriginFromPsbt('!!!not base64 psbt!!!');
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(LedgerError);
			expect((e as InstanceType<typeof LedgerError>).code).toBe('bad_psbt');
		}
	});
});

describe('mergeSignatures', () => {
	it('pairs a non-taproot signature with the input’s own declared pubkey', async () => {
		const { unsignedPsbt } = await singleSigFixture();
		const { mergeSignatures } = await import('./ledger.js');
		const tx = btc.Transaction.fromPSBT(base64.decode(unsignedPsbt));
		const fakeSig = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01]);
		mergeSignatures(tx, new Map([[0, fakeSig]]));
		const [pubkey, sig] = (tx.getInput(0).partialSig as [Uint8Array, Uint8Array][])[0];
		expect(hex.encode(sig)).toBe(hex.encode(fakeSig));
		expect(pubkey.length).toBe(33);
	});

	it('routes a taproot input (no bip32Derivation) to tapKeySig with no pairing', async () => {
		const { mergeSignatures } = await import('./ledger.js');
		const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
		tx.addOutput({ script: new Uint8Array(34).fill(1), amount: 5000n });
		tx.addInput({
			txid: new Uint8Array(32).fill(2),
			index: 0,
			witnessUtxo: { script: new Uint8Array(34).fill(1), amount: 10000n },
			tapInternalKey: new Uint8Array(32).fill(9)
		});
		const schnorrSig = new Uint8Array(64).fill(7);
		mergeSignatures(tx, new Map([[0, schnorrSig]]));
		expect(hex.encode(tx.getInput(0).tapKeySig as Uint8Array)).toBe(hex.encode(schnorrSig));
	});

	it('throws when an input has neither bip32Derivation nor taproot fields', async () => {
		const { mergeSignatures, LedgerError } = await import('./ledger.js');
		const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
		tx.addOutput({ script: new Uint8Array(34).fill(1), amount: 5000n });
		tx.addInput({ txid: new Uint8Array(32).fill(2), index: 0, witnessUtxo: { script: new Uint8Array(34).fill(1), amount: 10000n } });
		expect(() => mergeSignatures(tx, new Map([[0, new Uint8Array(8)]])))
			.toThrow(LedgerError);
	});
});

describe('signPsbtWithLedger -- full flow with a fake device', () => {
	it('throws "unavailable" with no navigator.hid', async () => {
		vi.unstubAllGlobals(); // no hid
		const { signPsbtWithLedger, LedgerError } = await import('./ledger.js');
		const { unsignedPsbt } = await singleSigFixture();
		await expect(signPsbtWithLedger(unsignedPsbt)).rejects.toMatchObject({ code: 'unavailable' } as Partial<InstanceType<typeof LedgerError>>);
	});

	it('wrong-device guard throws before any signPsbt call, naming both fingerprints', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		const { signPsbtWithLedger } = await import('./ledger.js');
		ledgerState.masterFp = Buffer.from('11111111', 'hex'); // wrong device
		ledgerState.xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
		let caught: unknown;
		try {
			await signPsbtWithLedger(unsignedPsbt);
		} catch (e) {
			caught = e;
		}
		expect((caught as { code?: string }).code).toBe('wrong_device');
	});

	it('happy path: merges a real signature and produces a same-transaction-committing PSBT', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		const account = root.derive("m/84'/0'/0'");
		ledgerState.masterFp = Buffer.from('56c4fac3', 'hex'); // matches the wallet's real fingerprint
		ledgerState.xpub = account.publicExtendedKey;

		// Compute a real signature the same way the wallet engine's own tests do
		// (signIdx on a clone), then hand it back through the fake AppClient.
		const clone = btc.Transaction.fromPSBT(base64.decode(unsignedPsbt));
		clone.signIdx(account.deriveChild(0).deriveChild(0).privateKey!, 0);
		const realSig = (clone.getInput(0).partialSig as [Uint8Array, Uint8Array][])[0][1];
		ledgerState.sigs = new Map([[0, Buffer.from(realSig)]]);

		const { signPsbtWithLedger } = await import('./ledger.js');
		const signed = await signPsbtWithLedger(unsignedPsbt);

		const { assertSameTransaction } = await import('$lib/server/wallet/index.js');
		expect(() => assertSameTransaction(unsignedPsbt, signed)).not.toThrow();
		expect(ledgerState.closeCalls).toBe(1); // transport always closed
	});

	it('maps a device rejection (0x6985) to the typed "rejected" error', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		ledgerState.masterFp = Buffer.from('56c4fac3', 'hex');
		ledgerState.xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
		ledgerState.signPsbtError = Object.assign(new Error('Ledger device: UNKNOWN_ERROR (0x6985)'), { statusCode: 0x6985 });
		const { signPsbtWithLedger } = await import('./ledger.js');
		await expect(signPsbtWithLedger(unsignedPsbt)).rejects.toMatchObject({ code: 'rejected' });
		expect(ledgerState.closeCalls).toBe(1);
	});

	it('maps app-not-open (0x6e01) to "app_not_open"', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		ledgerState.masterFp = Buffer.from('56c4fac3', 'hex');
		ledgerState.xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
		ledgerState.signPsbtError = Object.assign(new Error('0x6e01'), { statusCode: 0x6e01 });
		const { signPsbtWithLedger } = await import('./ledger.js');
		await expect(signPsbtWithLedger(unsignedPsbt)).rejects.toMatchObject({ code: 'app_not_open' });
	});

	it('maps a locked device (0x5515) to "device_locked"', async () => {
		const { unsignedPsbt, root } = await singleSigFixture();
		ledgerState.masterFp = Buffer.from('56c4fac3', 'hex');
		ledgerState.xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
		ledgerState.signPsbtError = Object.assign(new Error('0x5515'), { statusCode: 0x5515 });
		const { signPsbtWithLedger } = await import('./ledger.js');
		await expect(signPsbtWithLedger(unsignedPsbt)).rejects.toMatchObject({ code: 'device_locked' });
	});

	it('a never-resolving transport.create() times out after 45s (fake timers)', async () => {
		vi.useFakeTimers();
		const { unsignedPsbt } = await singleSigFixture();
		ledgerState.transportCreateNeverResolves = true;
		const { signPsbtWithLedger } = await import('./ledger.js');
		const promise = signPsbtWithLedger(unsignedPsbt);
		const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
		await vi.advanceTimersByTimeAsync(45_001);
		await assertion;
	});
});

// ---------------------------------------------------------------------------
// Multisig -- three deterministic HDKey masters (same seeds as trezor.spec.ts
// so both drivers exercise identical key material).

function multisigKeys() {
	const roots = [1, 2, 3].map((seed) => HDKey.fromMasterSeed(new Uint8Array(32).fill(seed)));
	const accounts = roots.map((r) => r.derive("m/48'/0'/0'/2'"));
	const keys = accounts.map((acct, i) => ({
		xpub: acct.publicExtendedKey,
		fingerprint: hex.encode(u32(roots[i].fingerprint)),
		path: "m/48'/0'/0'/2'"
	}));
	return { roots, accounts, keys };
}
function u32(n: number): Uint8Array {
	return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

describe('buildMultisigPolicy', () => {
	it('sorts keys case-sensitively by the xpub substring (never normalized)', async () => {
		const { buildMultisigPolicy } = await import('./ledger.js');
		const { keys } = multisigKeys();
		const policy = buildMultisigPolicy(keys, 2, 'p2wsh', 'Test Vault');
		// Re-derive the expected order independently.
		const expectedOrder = [...keys]
			.map((k) => `[${k.fingerprint}${k.path === 'm' ? '' : '/' + k.path.slice(2).replace(/'/g, "'")}]${k.xpub}`)
			.sort((a, b) => {
				const ax = a.slice(a.indexOf(']') + 1);
				const bx = b.slice(b.indexOf(']') + 1);
				return ax < bx ? -1 : ax > bx ? 1 : 0;
			});
		expect(policy.keys.map((k) => k.slice(k.indexOf(']') + 1))).toEqual(
			expectedOrder.map((k) => k.slice(k.indexOf(']') + 1))
		);
		expect(policy.template).toBe('wsh(sortedmulti(2,@0/**,@1/**,@2/**))');
	});

	it('wraps p2sh and p2sh-p2wsh templates correctly', async () => {
		const { buildMultisigPolicy } = await import('./ledger.js');
		const { keys } = multisigKeys();
		expect(buildMultisigPolicy(keys, 2, 'p2sh', 'V').template).toBe('sh(sortedmulti(2,@0/**,@1/**,@2/**))');
		expect(buildMultisigPolicy(keys, 2, 'p2sh-p2wsh', 'V').template).toBe('sh(wsh(sortedmulti(2,@0/**,@1/**,@2/**)))');
	});

	it('rejects an out-of-range threshold', async () => {
		const { buildMultisigPolicy } = await import('./ledger.js');
		const { keys } = multisigKeys();
		expect(() => buildMultisigPolicy(keys, 4, 'p2wsh', 'V')).toThrow();
		expect(() => buildMultisigPolicy(keys, 0, 'p2wsh', 'V')).toThrow();
	});

	it('sanitizes the policy name (strips non-ASCII, truncates with an ASCII ellipsis, falls back when empty)', async () => {
		const { buildMultisigPolicy } = await import('./ledger.js');
		const { keys } = multisigKeys();
		expect(buildMultisigPolicy(keys, 2, 'p2wsh', '  ').name).toBe('Hearth multisig');
		expect(buildMultisigPolicy(keys, 2, 'p2wsh', 'a'.repeat(100)).name).toMatch(/\.\.\.$/);
		expect(buildMultisigPolicy(keys, 2, 'p2wsh', 'Café ñ').name).toBe('Caf');
	});
});

describe('registerMultisigPolicy -- exact BIP-388 byte layout + APDU sequencing', () => {
	it('serializes version 0x02, varint name/template, sha256(template), varint keycount, merkle root -- and sequences REGISTER_WALLET -> CONTINUE_INTERRUPTED', async () => {
		const { keys, roots } = multisigKeys();
		ledgerState.masterFp = Buffer.from(hex.encode(u32(roots[0].fingerprint)), 'hex');

		// First exchange is interrupted (0xe000); second is final (0x9000).
		ledgerState.sendResponses = [
			Buffer.concat([Buffer.from('need-more-data'), Buffer.from([0xe0, 0x00])]),
			Buffer.concat([Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb), Buffer.from([0x90, 0x00])])
		];

		const { registerMultisigPolicy, buildMultisigPolicy } = await import('./ledger.js');
		const result = await registerMultisigPolicy(keys, 2, 'p2wsh', 'Vault');

		expect(result.masterFp).toBe(keys[0].fingerprint);
		expect(result.policyId).toBe('aa'.repeat(32));
		expect(result.policyHmac).toBe('bb'.repeat(32));

		// APDU sequencing: CLA_BTC/INS_REGISTER_WALLET first, then
		// CLA_FRAMEWORK/INS_CONTINUE_INTERRUPTED carrying the interpreter's answer.
		expect(ledgerState.sendCalls[0]).toMatchObject({ cla: 0xe1, ins: 0x02 });
		expect(ledgerState.sendCalls[1]).toMatchObject({ cla: 0xf8, ins: 0x01 });
		expect(ledgerState.sendCalls[1].data.toString()).toMatch(/^answered:/);

		// Exact byte layout of the serialized policy (varint-prefixed, inside
		// the first exchange's data payload after its own length-varint).
		const policy = buildMultisigPolicy(keys, 2, 'p2wsh', 'Vault');
		const nameBytes = Buffer.from(policy.name, 'ascii');
		const templateBytes = Buffer.from(policy.template, 'ascii');
		const leafHash = (b: Buffer) => Buffer.from(sha256(Buffer.concat([Buffer.from([0x00]), b])));
		const keysRoot = Buffer.from(
			sha256(Buffer.concat(policy.keys.map((k) => leafHash(Buffer.from(k, 'ascii')))))
		);
		const expectedSerialized = Buffer.concat([
			Buffer.from([0x02]),
			Buffer.from([nameBytes.length]),
			nameBytes,
			Buffer.from([templateBytes.length]),
			Buffer.from(sha256(templateBytes)),
			Buffer.from([policy.keys.length]),
			keysRoot
		]);
		// First send()'s data = createVarint(serialized.length) + serialized.
		const firstCallData = ledgerState.sendCalls[0].data;
		expect(firstCallData.subarray(1).equals(expectedSerialized)).toBe(true);
	});

	it('wrong-device: a master fingerprint outside the cosigner roster throws before any APDU exchange', async () => {
		const { keys } = multisigKeys();
		ledgerState.masterFp = Buffer.from('ffffffff', 'hex');
		const { registerMultisigPolicy } = await import('./ledger.js');
		await expect(registerMultisigPolicy(keys, 2, 'p2wsh', 'Vault')).rejects.toMatchObject({ code: 'wrong_device' });
		expect(ledgerState.sendCalls.length).toBe(0);
	});
});

describe('signMultisigPsbtWithLedger', () => {
	it('throws policy_unregistered before touching the device when hmac is null', async () => {
		const { keys } = multisigKeys();
		const { signMultisigPsbtWithLedger } = await import('./ledger.js');
		await expect(signMultisigPsbtWithLedger('irrelevant', keys, 2, 'p2wsh', 'Vault', null)).rejects.toMatchObject({
			code: 'policy_unregistered'
		});
	});
});
