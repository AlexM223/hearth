/**
 * Password hashing -- scrypt via node:crypto (DECISIONS.md §4.3), computed
 * OFF the transaction path (it's async; node:sqlite's DatabaseSync has no
 * notion of a pending transaction across an event-loop tick -- see
 * db/client.ts's withTransaction doc). Cost params run on the libuv
 * threadpool via the callback form, not scryptSync, so a hash never freezes
 * the whole event loop (SSE heartbeats, Electrum IO) for its ~100-300ms cost.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** Minimum acceptable password length. */
export const MIN_PASSWORD_LENGTH = 8;

function scryptAsync(
	password: string,
	salt: Buffer,
	keylen: number,
	options: { N: number; r: number; p: number }
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, keylen, options, (err, derivedKey) => {
			if (err) reject(err);
			else resolve(derivedKey);
		});
	});
}

/** Encodes as `scrypt:N:r:p:saltB64:hashB64` so cost params can change without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split(':');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
	const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
	const salt = Buffer.from(saltB64, 'base64');
	const expected = Buffer.from(hashB64, 'base64');
	const actual = await scryptAsync(password, salt, expected.length, {
		N: parseInt(nStr, 10),
		r: parseInt(rStr, 10),
		p: parseInt(pStr, 10)
	});
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
