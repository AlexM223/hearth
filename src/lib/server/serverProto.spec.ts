/**
 * fillForwardedProto tests (SIGNING.md §4.5, DECISIONS.md §5.2). Standalone
 * pure-function test for the helper server.mjs runs on BOTH listeners before
 * the SvelteKit handler ever sees a request -- the piece of Hearth's own
 * code the HTTPS-hop CSRF story depends on. (adapter-node's own origin
 * derivation from the resulting header is framework internals, verified by
 * reading -- SIGNING.md §4.5 -- not re-implemented here.)
 */
import { describe, expect, it } from 'vitest';
import { fillForwardedProto } from '../../../scripts/serverProto.mjs';

describe('fillForwardedProto', () => {
	it('stamps x-forwarded-proto when absent', () => {
		const headers: Record<string, string | undefined> = {};
		fillForwardedProto(headers, 'https');
		expect(headers['x-forwarded-proto']).toBe('https');
	});

	it('the HTTP listener stamps http, the HTTPS listener stamps https', () => {
		expect(fillForwardedProto({}, 'http')['x-forwarded-proto']).toBe('http');
		expect(fillForwardedProto({}, 'https')['x-forwarded-proto']).toBe('https');
	});

	it('never clobbers an already-present header -- load-bearing for app_proxy', () => {
		// Umbrel's app_proxy sets its own X-Forwarded-Proto; this listener's
		// own default must not override a real reverse-proxy's value.
		const headers = { 'x-forwarded-proto': 'https' };
		fillForwardedProto(headers, 'http');
		expect(headers['x-forwarded-proto']).toBe('https');
	});

	it('mutates in place AND returns the same object', () => {
		const headers: Record<string, string | undefined> = {};
		const returned = fillForwardedProto(headers, 'https');
		expect(returned).toBe(headers);
	});

	it('touches no other header', () => {
		const headers = { host: 'hearth.local:4489', 'user-agent': 'test' };
		fillForwardedProto(headers as never, 'https');
		expect(headers.host).toBe('hearth.local:4489');
		expect(headers['user-agent']).toBe('test');
	});
});
