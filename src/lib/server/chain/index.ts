/**
 * Explorer read models -- blocks/tx/address/mempool/fees (DECISIONS.md
 * §4.2, §4.4). Tiered richness by which rail (Electrum/Core) answered; no
 * third-party HTTP explorer API, ever. Stub for M0, built in M4.
 */
export type ExplorerRichness = 'none' | 'basic' | 'full';
