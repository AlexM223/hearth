/**
 * The ONE unified wallet engine (DECISIONS.md §0 rule 3, §4.2, §4.9):
 * xpub/descriptor import, derivation, PSBT build -> review -> sign ->
 * commitment-check -> broadcast. "kind" is a data column, never a second
 * code path -- especially never a second broadcast path. Stub for M0,
 * built in M2. Server-side only; hardware wallets live in src/lib/hw
 * (browser-side, WebHID/WebSerial) and are never imported here.
 */
export type WalletKind = 'single' | 'multisig';
