/**
 * The SSRF guard (WATCHTOWER.md §2.5) -- mandatory for webhook and ntfy
 * (`safeFetch`) and Nostr relay URLs (`checkRelayUrl`), since all three are
 * user-supplied targets fetched/connected to from the SERVER. Fails closed:
 * an unresolvable host, a disallowed scheme, or any resolved IP landing in a
 * blocked range is a hard rejection (retryable:false at the call site).
 *
 * Range check: loopback (127/8, ::1), private (10/8, 172.16/12, 192.168/16,
 * fc00::/7), link-local (169.254/16 incl. the 169.254.169.254 cloud-metadata
 * address, fe80::/10), 0.0.0.0/8, and IPv4-mapped IPv6 (::ffff:a.b.c.d)
 * unwrapped and re-checked against the SAME IPv4 ranges.
 *
 * DNS-rebind protection: every resolved IP is validated BEFORE the request,
 * and the actual socket is pinned to that exact IP via a custom `lookup`
 * (undici's Agent `connect.lookup` option) -- so a hostname that resolves
 * differently between the check and the connect can never slip through.
 *
 * `webhook_allow_private_targets` (instance setting, off by default) disables
 * ONLY the range check, for a self-hoster deliberately POSTing to their own
 * LAN -- it never disables the scheme check.
 */
import net from 'node:net';
import dns from 'node:dns/promises';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

export const REQUEST_TIMEOUT_MS = 10_000;

export interface SsrfCheckResult {
	ok: boolean;
	reason?: string;
	/** The IP the caller should pin its connection to. */
	resolvedIp?: string;
}

// ---------------------------------------------------------------- IPv4

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let n = 0;
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const v = Number(p);
		if (v > 255) return null;
		n = (n << 8) | v;
	}
	return n >>> 0;
}

interface V4Range {
	base: number;
	bits: number;
}
function v4(base: string, bits: number): V4Range {
	return { base: ipv4ToInt(base)!, bits };
}
const V4_BLOCKED: V4Range[] = [
	v4('0.0.0.0', 8), // "this network"
	v4('127.0.0.0', 8), // loopback
	v4('10.0.0.0', 8), // private
	v4('172.16.0.0', 12), // private
	v4('192.168.0.0', 16), // private
	v4('169.254.0.0', 16) // link-local, INCLUDES the 169.254.169.254 cloud metadata address
];

function v4InRange(ipInt: number, range: V4Range): boolean {
	const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
	return (ipInt & mask) >>> 0 === (range.base & mask) >>> 0;
}

function isBlockedV4(ip: string): boolean {
	const n = ipv4ToInt(ip);
	if (n === null) return true; // unparseable -- fail closed
	return V4_BLOCKED.some((r) => v4InRange(n, r));
}

// ---------------------------------------------------------------- IPv6

/** Expands any valid IPv6 literal (including `::` compression and an
 *  embedded IPv4 tail like `::ffff:1.2.3.4`) into 8 16-bit groups. */
function expandIpv6(raw: string): number[] | null {
	if (!net.isIPv6(raw)) return null;
	let ip = raw;
	const pct = ip.indexOf('%');
	if (pct >= 0) ip = ip.slice(0, pct); // strip a zone id (fe80::1%eth0)

	let ipv4Tail: number[] | null = null;
	const lastColon = ip.lastIndexOf(':');
	const tailCandidate = ip.slice(lastColon + 1);
	if (tailCandidate.includes('.')) {
		const octets = tailCandidate.split('.');
		if (octets.length !== 4) return null;
		const nums = octets.map((o) => Number(o));
		if (!nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
		ipv4Tail = nums;
		ip = ip.slice(0, lastColon);
	}

	let headGroups: string[];
	let tailGroups: string[];
	let hasDoubleColon = false;
	if (ip.includes('::')) {
		hasDoubleColon = true;
		const idx = ip.indexOf('::');
		headGroups = ip.slice(0, idx).length ? ip.slice(0, idx).split(':') : [];
		tailGroups = ip.slice(idx + 2).length ? ip.slice(idx + 2).split(':') : [];
	} else {
		headGroups = ip.length ? ip.split(':') : [];
		tailGroups = [];
	}

	const v4Groups: string[] = ipv4Tail
		? [(((ipv4Tail[0] << 8) | ipv4Tail[1]) >>> 0).toString(16), (((ipv4Tail[2] << 8) | ipv4Tail[3]) >>> 0).toString(16)]
		: [];

	let allGroups: string[];
	if (hasDoubleColon) {
		const known = headGroups.length + tailGroups.length + v4Groups.length;
		const zeros = Array(Math.max(0, 8 - known)).fill('0');
		allGroups = [...headGroups, ...zeros, ...tailGroups, ...v4Groups];
	} else {
		allGroups = [...headGroups, ...v4Groups];
	}

	if (allGroups.length !== 8) return null;
	const nums = allGroups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
	if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
	return nums;
}

function isBlockedV6(ip: string): boolean {
	const g = expandIpv6(ip);
	if (!g) return true; // unparseable -- fail closed

	// ::1 -- loopback
	if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
	// :: -- unspecified
	if (g.every((x) => x === 0)) return true;
	// ::ffff:a.b.c.d -- IPv4-mapped, unwrap and re-check against the v4 ranges
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
		const a = (g[6] >> 8) & 0xff;
		const b = g[6] & 0xff;
		const c = (g[7] >> 8) & 0xff;
		const d = g[7] & 0xff;
		return isBlockedV4(`${a}.${b}.${c}.${d}`);
	}
	// fe80::/10 -- link-local
	if ((g[0] & 0xffc0) === 0xfe80) return true;
	// fc00::/7 -- unique-local
	if ((g[0] & 0xfe00) === 0xfc00) return true;
	return false;
}

function isBlockedIp(ip: string): boolean {
	if (net.isIPv4(ip)) return isBlockedV4(ip);
	if (net.isIPv6(ip)) return isBlockedV6(ip);
	return true; // neither -- fail closed
}

// ------------------------------------------------------------------- checks

/** http:/https: targets (webhook, ntfy). */
export async function checkUrl(rawUrl: string, opts: { allowPrivate?: boolean } = {}): Promise<SsrfCheckResult> {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return { ok: false, reason: 'not a valid URL' };
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return { ok: false, reason: `scheme not allowed: ${u.protocol}` };
	}
	return resolveAndCheck(u.hostname, opts.allowPrivate ?? false);
}

/** ws:/wss: targets (Nostr relays). */
export async function checkRelayUrl(rawUrl: string, opts: { allowPrivate?: boolean } = {}): Promise<SsrfCheckResult> {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return { ok: false, reason: 'not a valid URL' };
	}
	if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
		return { ok: false, reason: `scheme not allowed: ${u.protocol}` };
	}
	return resolveAndCheck(u.hostname, opts.allowPrivate ?? false);
}

async function resolveAndCheck(hostname: string, allowPrivate: boolean): Promise<SsrfCheckResult> {
	const bare = hostname.replace(/^\[|\]$/g, ''); // URL hostname keeps IPv6 brackets
	let ips: string[];
	if (net.isIP(bare)) {
		ips = [bare];
	} else {
		try {
			const results = await dns.lookup(bare, { all: true, verbatim: true });
			ips = results.map((r) => r.address);
		} catch {
			return { ok: false, reason: 'DNS resolution failed' };
		}
	}
	if (ips.length === 0) return { ok: false, reason: 'no addresses resolved' };
	if (!allowPrivate) {
		for (const ip of ips) {
			if (isBlockedIp(ip)) return { ok: false, reason: `blocked address range: ${ip}` };
		}
	}
	return { ok: true, resolvedIp: ips[0] };
}

// -------------------------------------------------------------- safe fetch

export interface SafeFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	allowPrivate?: boolean;
}

export class SsrfRejectedError extends Error {
	constructor(reason: string) {
		super(`request blocked (SSRF guard): ${reason}`);
		this.name = 'SsrfRejectedError';
	}
}

/** Fetch a user-supplied http(s) URL with the SSRF guard applied AND the
 *  socket pinned to the exact IP validated above (no DNS-rebind window). */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
	const check = await checkUrl(rawUrl, { allowPrivate: opts.allowPrivate });
	if (!check.ok) throw new SsrfRejectedError(check.reason ?? 'blocked');

	const pinnedIp = check.resolvedIp!;
	const agent = new Agent({
		connect: {
			lookup: (_hostname, _options, callback) => {
				callback(null, [{ address: pinnedIp, family: net.isIPv6(pinnedIp) ? 6 : 4 }]);
			}
		}
	});

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
	try {
		return (await undiciFetch(rawUrl, {
			method: opts.method ?? 'GET',
			headers: opts.headers,
			body: opts.body,
			dispatcher: agent as unknown as Dispatcher,
			signal: controller.signal
		})) as unknown as Response;
	} finally {
		clearTimeout(timer);
		void agent.close();
	}
}
