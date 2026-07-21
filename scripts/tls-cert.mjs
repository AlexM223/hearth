/**
 * Self-signed TLS certificate for Hearth's optional HTTPS listener.
 *
 * Umbrel serves apps over plain HTTP on the LAN, which is not a browser
 * "secure context" -- so WebHID / Web Serial (hardware-wallet signing) and
 * camera QR scanning are unavailable. Hearth terminates TLS itself on a
 * second port with a certificate generated at first boot and persisted in
 * the data volume, rotating it shortly before expiry. The browser shows a
 * "connection is not private" warning (the user proceeds via Advanced ->
 * Continue); after that the origin is a genuine secure context.
 *
 * Deliberately standalone (imported by server.mjs, which runs OUTSIDE the
 * SvelteKit build): node builtins + the `selfsigned` package only, no
 * imports from src/.
 *
 * Pattern ported from cairn's scripts/tls-cert.mjs (DECISIONS.md §7 sources).
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Regenerate rather than serve a certificate with less than this left. */
const MIN_REMAINING_DAYS = 30;
/** Apple platforms refuse to trust a TLS server cert valid > 825 days. */
const VALIDITY_DAYS = 825;

/** DNS names the certificate claims. Best-effort completeness -- browsers warn regardless. */
export const DEFAULT_HOSTS = ['umbrel.local', 'localhost', '*.local'];

const WEAK_SIG_OIDS = [
	Buffer.from('06092a864886f70d010105', 'hex'), // sha1WithRSAEncryption
	Buffer.from('06092a864886f70d010104', 'hex') // md5WithRSAEncryption
];

/**
 * True when the PEM parses as X.509, isn't signed with a browser-rejected
 * algorithm, and keeps at least MIN_REMAINING_DAYS of validity.
 * @param {string} certPem
 * @param {Date} [now]
 */
export function certUsable(certPem, now = new Date()) {
	try {
		const cert = new X509Certificate(certPem);
		if (WEAK_SIG_OIDS.some((oid) => cert.raw.includes(oid))) return false;
		const expires = new Date(cert.validTo);
		const remainingMs = expires.getTime() - now.getTime();
		return remainingMs > MIN_REMAINING_DAYS * 24 * 60 * 60 * 1000;
	} catch {
		return false;
	}
}

/**
 * Generate a fresh self-signed key + certificate pair (PEM strings).
 * @param {string[]} [hosts]
 * @returns {Promise<{ key: string, cert: string }>}
 */
export async function generateCert(hosts = DEFAULT_HOSTS) {
	// Lazy import: cert assembly is only ever needed on the rare boot that
	// actually generates -- not on every start.
	const selfsigned = (await import('selfsigned')).default;
	const notAfterDate = new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
	const pems = await selfsigned.generate([{ name: 'commonName', value: hosts[0] }], {
		notAfterDate,
		keySize: 2048,
		algorithm: 'sha256',
		extensions: [
			{ name: 'basicConstraints', cA: false, critical: true },
			{ name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
			{ name: 'extKeyUsage', serverAuth: true },
			{
				name: 'subjectAltName',
				altNames: [
					...hosts.map((h) => ({ type: /** @type {2} */ (2), value: h })), // DNS
					{ type: /** @type {7} */ (7), ip: '127.0.0.1' } // IP
				]
			}
		]
	});
	return { key: pems.private, cert: pems.cert };
}

/**
 * Load the persisted certificate from `dir`, generating a fresh one when
 * missing, unparsable, weakly signed, or within MIN_REMAINING_DAYS of expiry.
 * Persisting the fresh pair is best-effort: a read-only data dir must
 * degrade to "new warning every boot", never to a dead HTTPS port.
 * @param {string} dir
 * @param {string[]} [hosts]
 * @returns {Promise<{ key: string, cert: string }>}
 */
export async function ensureCert(dir, hosts = DEFAULT_HOSTS) {
	const keyPath = path.join(dir, 'key.pem');
	const certPath = path.join(dir, 'cert.pem');

	if (existsSync(keyPath) && existsSync(certPath)) {
		try {
			const key = readFileSync(keyPath, 'utf8');
			const cert = readFileSync(certPath, 'utf8');
			if (certUsable(cert)) return { key, cert };
		} catch {
			// unreadable -> fall through and regenerate
		}
	}

	const fresh = await generateCert(hosts);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(keyPath, fresh.key, { mode: 0o600 });
		writeFileSync(certPath, fresh.cert, { mode: 0o644 });
	} catch (err) {
		console.error(
			`hearth: could not persist TLS certificate to ${dir} (serving it from memory; ` +
				`expect a fresh browser warning on every restart) —`,
			err instanceof Error ? err.message : err
		);
	}
	return fresh;
}
