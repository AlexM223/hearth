/**
 * T0 acceptance (WATCHTOWER.md §2.3, §6.4): the AES-256-GCM envelope round-
 * trips, fails closed on tamper/wrong-key/garbage input, and the key file is
 * generated once (mode 0600) and reused across re-inits at the same path.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	initSecretKey,
	encryptSecret,
	decryptSecret,
	secretKeyPath,
	SecretDecryptionError,
	__resetSecretKeyForTests
} from './secrets.js';

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hearth-secrets-'));
	__resetSecretKeyForTests();
});
afterEach(() => {
	__resetSecretKeyForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe('notify/config/secrets: envelope encryption', () => {
	it('round-trips plaintext through encrypt/decrypt', () => {
		initSecretKey(dir);
		const envelope = encryptSecret('super-secret-bot-token');
		expect(envelope).not.toContain('super-secret-bot-token');
		expect(decryptSecret(envelope)).toBe('super-secret-bot-token');
	});

	it('generates a 32-byte key file on first use', () => {
		initSecretKey(dir);
		const key = readFileSync(secretKeyPath(dir));
		expect(key.length).toBe(32);
	});

	it.skipIf(process.platform === 'win32')(
		'sets restrictive file permissions on the key file (POSIX platforms)',
		() => {
			initSecretKey(dir);
			const mode = statSync(secretKeyPath(dir)).mode & 0o777;
			expect(mode & 0o077).toBe(0);
		}
	);

	it('reuses the same key across repeated initSecretKey calls at the same path', () => {
		initSecretKey(dir);
		const envelope = encryptSecret('reused-key-plaintext');
		__resetSecretKeyForTests();
		initSecretKey(dir); // simulates a process restart re-reading the same file
		expect(decryptSecret(envelope)).toBe('reused-key-plaintext');
	});

	it('produces different ciphertext for the same plaintext each call (random IV)', () => {
		initSecretKey(dir);
		const a = encryptSecret('same-plaintext');
		const b = encryptSecret('same-plaintext');
		expect(a).not.toBe(b);
		expect(decryptSecret(a)).toBe('same-plaintext');
		expect(decryptSecret(b)).toBe('same-plaintext');
	});

	it('fails closed on a tampered envelope (auth tag mismatch)', () => {
		initSecretKey(dir);
		const envelope = encryptSecret('do-not-tamper');
		const decoded = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
		// Flip a byte in the ciphertext.
		const ctBytes = Buffer.from(decoded.ct, 'base64');
		ctBytes[0] ^= 0xff;
		decoded.ct = ctBytes.toString('base64');
		const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64');
		expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
	});

	it('fails closed when decrypting with the WRONG instance key (never returns garbage plaintext)', () => {
		const dir2 = mkdtempSync(join(tmpdir(), 'hearth-secrets-2-'));
		try {
			initSecretKey(dir);
			const envelope = encryptSecret('cross-instance-secret');
			__resetSecretKeyForTests();
			initSecretKey(dir2); // a different instance's key
			expect(() => decryptSecret(envelope)).toThrow(SecretDecryptionError);
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	});

	it('fails closed on garbage input', () => {
		initSecretKey(dir);
		expect(() => decryptSecret('not-a-valid-envelope')).toThrow(SecretDecryptionError);
	});

	it('encryptSecret/decryptSecret throw a clear error if called before initSecretKey', () => {
		expect(() => encryptSecret('x')).toThrow(/not initialized/);
	});
});
