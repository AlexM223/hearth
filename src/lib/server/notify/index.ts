/**
 * Five-channel fail-closed, SPV-verified notifier -- the watchtower's
 * detection side (DECISIONS.md §4.9, §4.2, M6): email / Telegram / ntfy /
 * Nostr / webhook. Hard invariant: detection failure never fires a false
 * positive (SPV-before-notify). Stub for M0, built in M6.
 */
export type NotifyChannel = 'email' | 'telegram' | 'ntfy' | 'nostr' | 'webhook';
