import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('auth: password hashing (scrypt)', () => {
	it('verifies a correct password against its own hash', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
	});

	it('rejects a wrong password', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(await verifyPassword('wrong password', hash)).toBe(false);
	});

	it('never stores the password in the hash string', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(hash).not.toContain('correct horse battery staple');
		expect(hash.startsWith('scrypt:')).toBe(true);
	});

	it('salts every hash uniquely -- same password, different hash', async () => {
		const a = await hashPassword('same password');
		const b = await hashPassword('same password');
		expect(a).not.toBe(b);
	});

	it('rejects a malformed stored hash instead of throwing', async () => {
		expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
		expect(await verifyPassword('anything', 'scrypt:only:four:parts')).toBe(false);
	});
});
