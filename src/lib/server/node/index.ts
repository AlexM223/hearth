/**
 * NodeClient facade -- the Electrum (Fulcrum) / Bitcoin Core RPC split
 * (DECISIONS.md §4.4). Electrum is the fast wallet rail; Core RPC is the
 * canonical/explorer + mining rail. Stub for M0 -- the real plaintext
 * Electrum socket pool (interactive/background lanes) and the Core RPC
 * client (concurrency cap + 503 retry) land in M1.
 */
import type { CoreRpcConfig, ElectrumConfig } from '../config/index.js';

export interface NodeHealth {
	electrum: 'unknown' | 'connected' | 'down';
	core: 'unknown' | 'connected' | 'down';
}

export class NodeClient {
	constructor(
		private readonly electrumConfig: ElectrumConfig,
		private readonly coreConfig: CoreRpcConfig
	) {}

	/** M1: real Electrum `server.ping` + Core RPC `getblockchaininfo`. */
	async health(): Promise<NodeHealth> {
		return { electrum: 'unknown', core: 'unknown' };
	}
}
