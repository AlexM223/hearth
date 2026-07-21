/**
 * Fill-when-absent x-forwarded-proto helper.
 *
 * adapter-node's get_origin() treats a request as https whenever NEITHER
 * `ORIGIN` NOR `PROTOCOL_HEADER` is configured. server.mjs's bare-node
 * deployments (no reverse proxy, no ORIGIN set) hit that default on the
 * PLAIN HTTP listener too, so a login request "looks" https to the auth
 * module's cookie-secure logic, which would stamp the session cookie
 * `Secure`. Browsers silently drop a `Secure` cookie set over plain HTTP, so
 * the cookie never sticks.
 *
 * The fix (paired with server.mjs setting `PROTOCOL_HEADER=x-forwarded-proto`
 * for unconfigured deployments): stamp each listener's own protocol onto the
 * request BEFORE it reaches the SvelteKit handler, but only when the header
 * isn't already present -- load-bearing for reverse-proxy topologies (e.g.
 * Umbrel's app_proxy): those set their own X-Forwarded-Proto and it must be
 * honored, not clobbered by this listener's default.
 *
 * Deliberately standalone (imported by server.mjs, which runs OUTSIDE the
 * SvelteKit build): no imports from src/, pure function over a header bag.
 *
 * Pattern ported from cairn's scripts/serverProto.mjs (DECISIONS.md §7 sources).
 */

/**
 * Mutates `headers` in place, setting `x-forwarded-proto` to `proto` only if
 * it is not already present. Never touches any other header.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {'http' | 'https'} proto
 * @returns {Record<string, string | string[] | undefined>}
 */
export function fillForwardedProto(headers, proto) {
	if (headers['x-forwarded-proto'] === undefined) {
		headers['x-forwarded-proto'] = proto;
	}
	return headers;
}
