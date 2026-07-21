/**
 * PARKED (DECISIONS.md §4.7). PSBT coordination between Hearth instances is
 * a phase-2 spec, gated on whether umbrelOS 1.x still exposes a per-app
 * `.onion`. NOT built in M0-M7. This module exists only to reserve the
 * boundary in src/lib/server -- it intentionally exports nothing callable.
 */
export {};
