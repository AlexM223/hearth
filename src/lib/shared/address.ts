/**
 * Client-safe recipient-address FORMAT validation (UX sweep hearth-5vw). Lives
 * under `$lib/shared` -- NOT `$lib/server` -- specifically so the Send form
 * (`src/routes/(app)/wallets/[id]/+page.svelte`) can import it directly: any
 * `$lib/server/**` import from a `.svelte` component is a SvelteKit
 * server-only-module violation (same reasoning as `$lib/shared/signing.ts`).
 *
 * This is a fail-fast UI gate ONLY -- pure decode, no network, no DB. The
 * server's `$lib/server/wallet/address.ts` (`decodeAddress`) stays the sole
 * AUTHORITATIVE check before anything is built into a PSBT; this exists so
 * the Send form can show "not a valid bitcoin address" before a request ever
 * fires, per DECISIONS.md §3's friction ladder (calm, immediate, plain-
 * language feedback rather than a round trip to find out).
 */
import * as btc from '@scure/btc-signer';

export type ChainNetwork = 'mainnet' | 'testnet' | 'regtest';

const REGTEST_NET = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

function scureNetwork(network: ChainNetwork): typeof btc.NETWORK {
	if (network === 'mainnet') return btc.NETWORK;
	if (network === 'testnet') return btc.TEST_NETWORK;
	return REGTEST_NET;
}

/** True iff `address` decodes as a well-formed bitcoin address for `network`.
 *  Mirrors the server's decode-or-reject shape (whitespace/empty rejected,
 *  network-bound HRP/version checked) without needing the server's error
 *  taxonomy -- the Send form only needs a yes/no to gate the Review button. */
export function isValidAddressFormat(address: string, network: ChainNetwork): boolean {
	const trimmed = address.trim();
	if (trimmed === '' || /\s/.test(trimmed)) return false;
	try {
		btc.Address(scureNetwork(network)).decode(trimmed);
		return true;
	} catch {
		return false;
	}
}
