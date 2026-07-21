/**
 * Wire-shape types shared between the server (`$lib/server/wallet`) and the
 * browser-side signing surface (`$lib/hw`, `$lib/components/sign`). Lives
 * under `$lib/shared` -- NOT `$lib/server` -- specifically so signing
 * components can import it without crossing the SIGNING.md §0.3 boundary
 * (`src/lib/hw/**` / `src/lib/components/sign/**` never import `$lib/server`).
 * These are plain data shapes describing the JSON already returned by
 * `GET /drafts/[id]` and `POST /drafts/[id]/sign` -- kept in sync with
 * `$lib/server/wallet/types.ts`'s `SigningProgress` by convention (both
 * describe the same wire response).
 */

export interface SigningProgress {
	required: number;
	collected: number;
	complete: boolean;
	keys: { fingerprint: string; path: string; signed: boolean }[];
	inputCount: number;
}

/** The slice of wallet identity the browser-side drivers need to build a
 *  Ledger/Trezor wallet policy (SIGNING.md §1.1, §1.2) -- cosigner xpubs are
 *  the owner's own already-known public key material, never a secret. */
export interface SigningWalletContext {
	kind: 'single' | 'multisig';
	scriptType: string;
	threshold: number;
	keys: { xpub: string; fingerprint: string; path: string; name: string | null }[];
}
