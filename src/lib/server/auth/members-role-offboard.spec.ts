/**
 * T11 acceptance (COME-ABOARD.md §5.2, §5.3, §7.5, §8): last-Owner guard,
 * offboard remove-all (cascade), offboard transfer (wallets re-parented,
 * drafts dropped, sessions killed).
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { openDb, getDb, closeDb, runMigrations } from '../db/index.js';
import { createSession, getSessionUser } from './session.js';
import { changeMemberRole, offboardMember, MemberError } from './members.js';
import { importWallet, buildPsbt, deriveAddresses, type BuildNode, type Wallet } from '../wallet/index.js';

let ownerId: number;
let memberId: number;

beforeEach(() => {
	closeDb();
	const db: DatabaseSync = openDb(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	runMigrations(db);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', 'h', 'owner');
	ownerId = Number((db.prepare("SELECT id FROM users WHERE username='owner'").get() as { id: number }).id);
	db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mum', 'h2', 'member');
	memberId = Number((db.prepare("SELECT id FROM users WHERE username='mum'").get() as { id: number }).id);
});

describe('T11: last-Owner guard (§5.2)', () => {
	it('demoting the SOLE Owner is rejected -- no change committed', () => {
		expect(() => changeMemberRole(ownerId, 'member')).toThrow(MemberError);
		try {
			changeMemberRole(ownerId, 'member');
		} catch (e) {
			expect((e as MemberError).code).toBe('last_owner');
		}
		const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(ownerId) as { role: string };
		expect(row.role).toBe('owner'); // unchanged -- the transaction rolled back
	});

	it('demoting one of TWO Owners succeeds (at least one keeper remains)', () => {
		getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('alex2', 'h3', 'owner');
		const secondOwnerId = Number(
			(getDb().prepare("SELECT id FROM users WHERE username='alex2'").get() as { id: number }).id
		);
		expect(() => changeMemberRole(secondOwnerId, 'member')).not.toThrow();
		const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(secondOwnerId) as { role: string };
		expect(row.role).toBe('member');
	});

	it('promoting a Member to Owner, then that Member offboarding the original Owner, is fine (2 keepers -> 1)', () => {
		changeMemberRole(memberId, 'owner');
		expect(() => offboardMember(memberId, ownerId, 'remove')).not.toThrow();
		const remaining = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'").get() as { n: number };
		expect(remaining.n).toBe(1);
	});

	it('rejects an invalid role string', () => {
		expect(() => changeMemberRole(memberId, 'superadmin')).toThrow(MemberError);
	});

	it('rejects a nonexistent target', () => {
		expect(() => changeMemberRole(999999, 'guest')).toThrow(MemberError);
	});
});

describe('T11: offboard -- remove (default, §5.3)', () => {
	it('kills sessions immediately -- a subsequent lookup finds nothing', () => {
		const { token } = createSession(memberId);
		expect(getSessionUser(token)).not.toBeNull();

		offboardMember(ownerId, memberId, 'remove');
		expect(getSessionUser(token)).toBeNull();
	});

	it('cascade-deletes the user, their wallets, and their drafts', () => {
		const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(7));
		const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
		const wallet = importWallet(memberId, { name: 'Mums wallet', descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)` });

		offboardMember(ownerId, memberId, 'remove');

		expect(getDb().prepare('SELECT id FROM users WHERE id = ?').get(memberId)).toBeUndefined();
		expect(getDb().prepare('SELECT id FROM wallets WHERE id = ?').get(wallet.id)).toBeUndefined();
	});

	it('the offboarding Owner survives and stays the sole Owner', () => {
		offboardMember(ownerId, memberId, 'remove');
		const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(ownerId) as { role: string };
		expect(row.role).toBe('owner');
	});

	it('throws not_found for an already-gone/nonexistent member', () => {
		expect(() => offboardMember(ownerId, 999999, 'remove')).toThrow(MemberError);
	});
});

describe('T11: offboard -- transfer (§5.3)', () => {
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

	it('re-parents the wallet to the offboarding Owner and drops its drafts', async () => {
		const root = HDKey.fromMasterSeed(new Uint8Array(32).fill(9));
		const xpub = root.derive("m/84'/0'/0'").publicExtendedKey;
		const wallet = importWallet(memberId, {
			name: "Grandad's watch-only",
			descriptor: `wpkh([00000000/84'/0'/0']${xpub}/0/*)`
		});
		const built = await buildPsbt(fundingNode(wallet, 1_000_000), memberId, wallet.id, {
			recipients: [{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', amountSats: 100_000 }],
			feeRate: 5
		});
		expect(built.draftId).toBeGreaterThan(0);

		offboardMember(ownerId, memberId, 'transfer');

		const walletRow = getDb().prepare('SELECT user_id FROM wallets WHERE id = ?').get(wallet.id) as {
			user_id: number;
		};
		expect(walletRow.user_id).toBe(ownerId);

		const draftRows = getDb().prepare('SELECT id FROM psbt_drafts WHERE wallet_id = ?').all(wallet.id);
		expect(draftRows.length).toBe(0); // dropped, never inherited (§4's justification)

		expect(getDb().prepare('SELECT id FROM users WHERE id = ?').get(memberId)).toBeUndefined();
	});

	it('kills the offboarded member sessions even under transfer', () => {
		const { token } = createSession(memberId);
		offboardMember(ownerId, memberId, 'transfer');
		expect(getSessionUser(token)).toBeNull();
	});
});
