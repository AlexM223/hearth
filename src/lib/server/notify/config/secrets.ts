/**
 * Instance secret-key management + AES-256-GCM envelope encryption
 * (WATCHTOWER.md §2.3). Bearer secrets (SMTP password, Telegram bot token,
 * webhook HMAC signing secret, Nostr sender identity, ntfy access token) are
 * encrypted at rest with a key that never leaves the box and is excluded
 * from Umbrel backups (`packaging/umbrel/hearth/umbrel-app.yml`'s
 * `backupIgnore`) -- a leaked SQLite DB copy alone must never leak a live
 * credential. Non-secret config stays plaintext (WATCHTOWER.md §2.3).
 *
 * Mirrors the db/client.ts singleton idiom (openDb/getDb): `initSecretKey`
 * is called once at boot (hooks.server.ts); every encrypt/decrypt call after
 * that reads the cached key. Fails closed -- an undecryptable envelope
 * throws `SecretDecryptionError` rather than silently minting a fresh key or
 * returning a guess (WATCHTOWER.md §2.3: a present-but-undecryptable secret
 * means investigate, never silently regenerate -- especially the Nostr
 * identity, where a fresh key would orphan every prior DM's peer trust).
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;

interface Envelope {
	v: number;
	iv: string; // base64
	tag: string; // base64
	ct: string; // base64
}

export class SecretDecryptionError extends Error {
	constructor(message = 'stored secret could not be decrypted') {
		super(message);
		this.name = 'SecretDecryptionError';
	}
}

let cachedKey: Buffer | null = null;

export function secretKeyPath(dataDir: string): string {
	return `${dataDir}/secret.key`;
}

/**
 * Generates (on first use) or loads the instance secret key at
 * `${dataDir}/secret.key`, mode 0600. Idempotent -- safe to call on every
 * boot. Must run before any encryptSecret/decryptSecret call.
 */
export function initSecretKey(dataDir: string): void {
	const path = secretKeyPath(dataDir);
	mkdirSync(dataDir, { recursive: true });
	if (existsSync(path)) {
		const key = readFileSync(path);
		if (key.length !== KEY_BYTES) {
			throw new Error(
				`hearth notify: secret.key at ${path} has unexpected length ${key.length} (expected ${KEY_BYTES}) -- investigate before continuing, never regenerate over it`
			);
		}
		cachedKey = key;
		return;
	}
	const key = randomBytes(KEY_BYTES);
	// mode is best-effort on platforms without POSIX permission bits (Windows
	// dev); the Umbrel container runtime (uid 1000:1000, DECISIONS.md §5.1)
	// honors it for real.
	writeFileSync(path, key, { mode: 0o600 });
	cachedKey = key;
}

function getSecretKey(): Buffer {
	if (!cachedKey) {
		throw new Error('hearth notify: secret key not initialized -- call initSecretKey(dataDir) first');
	}
	return cachedKey;
}

/** Encrypts `plain` into a base64 envelope string (`{v,iv,tag,ct}`). */
export function encryptSecret(plain: string): string {
	const key = getSecretKey();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGO, key, iv);
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	const envelope: Envelope = {
		v: ENVELOPE_VERSION,
		iv: iv.toString('base64'),
		tag: tag.toString('base64'),
		ct: ct.toString('base64')
	};
	return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

/** Decrypts a base64 envelope back to plaintext. Fails closed: any parse,
 *  version, or auth-tag mismatch throws SecretDecryptionError -- never a
 *  guess, never a silent empty string. */
export function decryptSecret(envelopeB64: string): string {
	const key = getSecretKey();
	let envelope: Envelope;
	try {
		envelope = JSON.parse(Buffer.from(envelopeB64, 'base64').toString('utf8'));
	} catch {
		throw new SecretDecryptionError();
	}
	if (
		typeof envelope !== 'object' ||
		envelope === null ||
		envelope.v !== ENVELOPE_VERSION ||
		typeof envelope.iv !== 'string' ||
		typeof envelope.tag !== 'string' ||
		typeof envelope.ct !== 'string'
	) {
		throw new SecretDecryptionError();
	}
	try {
		const decipher = createDecipheriv(ALGO, key, Buffer.from(envelope.iv, 'base64'));
		decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
		const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
		return pt.toString('utf8');
	} catch {
		throw new SecretDecryptionError();
	}
}

/** Test-only: force a fresh initSecretKey() call to take effect (clears the cache). */
export function __resetSecretKeyForTests(): void {
	cachedKey = null;
}
