/**
 * Mining engine settings, read from the `meta` kv store (`db/meta.ts` --
 * the same table `auth/household.ts` already uses for the household name and
 * per-user flags; DECISIONS.md §4.8's planned `settings (kv)` table, so no new
 * table is needed).
 *
 * These values are read FRESH on every call -- {@link readMiningSettings} does
 * one keyed lookup per field each time -- so a reconfigure after the operator
 * saves the mining form picks up the new values without a process restart.
 * Nothing here is cached at module scope (DECISIONS.md's "never freeze at
 * module load" rule, already followed by config/index.ts's loadConfig()).
 *
 * Ported as a pattern from cairn's mining/settings.ts.
 */
import { getMeta, setMeta } from '../db/index.js';
import { detectPlatform } from '../config/index.js';

/** Tri-state bind selector. Kept as a tri-state (not just a host) so the
 *  Settings UI can show honest copy about loopback-only vs LAN exposure; the
 *  engine only cares about the resolved {@link MiningSettings.bindHost}. */
export type MiningBind = 'loopback' | 'lan' | 'all';

export interface MiningSettings {
	/** Whether the operator has turned the engine on (separate from the `mining` feature flag). */
	enabled: boolean;
	/** The stored tri-state, for UI copy. */
	bind: MiningBind;
	/** Resolved Stratum bind host: loopback -> 127.0.0.1; lan/all -> 0.0.0.0. */
	bindHost: string;
	stratumPort: number;
	/**
	 * The port a miner on the LAN actually dials (hearth-ny4.1): on Umbrel the
	 * published HOST port differs from the container-internal listening port
	 * (docker-compose.yml maps host 3343 -> container 3333, host 3344 ->
	 * container 3334, to avoid colliding with cairn/Heartwood's own published
	 * 3333/3334) -- the dashboard's connection instructions (MINING-ENGINE.md
	 * §6.4) must show THIS number, never the internal `stratumPort`, or a
	 * Bitaxe pointed at the internal port would simply fail to connect.
	 * `HEARTH_MINING_STRATUM_EXTERNAL_PORT` is set only by the Umbrel compose;
	 * unset (dev, bare-metal) falls back to `stratumPort` (no remap).
	 */
	advertisedStratumPort: number;
	/** Vardiff floor + per-connection starting difficulty. */
	shareDifficulty: number;
	vardiffEnabled: boolean;
	/** Vardiff target, accepted shares per minute. */
	vardiffTargetPerMin: number;
	/** ASCII coinbase tag placed after the BIP34 height push. */
	poolTag: string;
	/** Whether the SECOND (ASIC-class) Stratum listener runs. On by default. */
	asicPortEnabled: boolean;
	/** Bind port for the ASIC listener (defaults 3334). */
	asicStratumPort: number;
	/** The LAN-facing port for the ASIC listener -- see {@link advertisedStratumPort}. */
	advertisedAsicStratumPort: number;
	/** Vardiff floor + starting difficulty for the ASIC listener (defaults 65536). */
	asicShareDifficulty: number;
	// --- SV2 seam (MINING-ENGINE.md §9.4): keys defined + read, no listener
	// built in M5. Never repurpose asicStratumPort/stratumPort for this.
	sv2Enabled: boolean;
	sv2Port: number;
	sv2ShareDifficulty: number;
	sv2VersionRolling: boolean;
}

/**
 * Default share difficulty. A deliberately LOW floor so even a sub-TH/s USB /
 * Bitaxe-class miner submits shares promptly on connect; vardiff (target 6
 * shares/min) then ratchets each connection up from here to its steady-state
 * weight.
 */
export const DEFAULT_SHARE_DIFFICULTY = 0.5;

/**
 * Default ASIC-listener share difficulty. Deliberately HIGH (2^16) so an
 * S19/S21-class machine -- which at the standard 0.5 floor would submit
 * millions of shares per second and swamp the share tracker -- starts at a
 * sane weight and lets vardiff ratchet from there.
 */
export const DEFAULT_ASIC_SHARE_DIFFICULTY = 65536;

const DEFAULT_SV2_SHARE_DIFFICULTY = DEFAULT_ASIC_SHARE_DIFFICULTY;

const DEFAULTS = {
	enabled: false,
	bind: 'loopback' as MiningBind,
	stratumPort: 3333,
	shareDifficulty: DEFAULT_SHARE_DIFFICULTY,
	vardiffEnabled: true,
	vardiffTargetPerMin: 6,
	poolTag: 'Hearth',
	asicPortEnabled: true,
	asicStratumPort: 3334,
	asicShareDifficulty: DEFAULT_ASIC_SHARE_DIFFICULTY,
	sv2Enabled: false,
	sv2Port: 3335,
	sv2ShareDifficulty: DEFAULT_SV2_SHARE_DIFFICULTY,
	sv2VersionRolling: false
};

/**
 * Resolve the DEFAULT bind selector, honouring the deployment platform. On a
 * container deployment (Umbrel) the app runs inside its own network
 * namespace: the docker-compose maps a HOST port to the container, but that
 * only reaches the app if the app is listening on 0.0.0.0 -- a loopback-only
 * bind (127.0.0.1) is unreachable from outside the container, so the
 * advertised Stratum address could never accept a connection. An explicit
 * operator-saved `mining_bind` value always wins over this default (see
 * {@link readMiningSettings}).
 */
function defaultBind(): MiningBind {
	return detectPlatform() === 'umbrel' ? 'all' : DEFAULTS.bind;
}

/** The published LAN-facing port, from an env var the Umbrel compose sets
 *  (see {@link MiningSettings.advertisedStratumPort}). Unset/invalid falls
 *  back to the internal port -- a bare-metal/dev install has no host-port
 *  remap, so the two are the same number there. */
function envPort(envVar: string, internalPort: number): number {
	const raw = process.env[envVar];
	if (!raw) return internalPort;
	const n = parseInt(raw, 10);
	return Number.isInteger(n) && n > 0 ? n : internalPort;
}

function boolSetting(key: string, dflt: boolean): boolean {
	const v = getMeta(key);
	if (v === null) return dflt;
	return v === '1' || v === 'true';
}

function intSetting(key: string, dflt: number): number {
	const v = getMeta(key);
	if (v === null) return dflt;
	const n = parseInt(v, 10);
	return Number.isInteger(n) && n > 0 ? n : dflt;
}

function floatSetting(key: string, dflt: number): number {
	const v = getMeta(key);
	if (v === null) return dflt;
	const n = parseFloat(v);
	return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Resolve the tri-state bind selector to a concrete host. LAN detection is
 *  intentionally NOT attempted -- lan/all both bind 0.0.0.0 and let the OS
 *  admit every interface; the tri-state exists only to drive UI copy about
 *  exposure. */
function bindHostFor(bind: MiningBind): string {
	return bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';
}

/**
 * Read the current mining settings from the kv store. Fresh every call -- see
 * the module note. Unset keys fall back to {@link DEFAULTS}; a malformed
 * stored value (non-numeric port/difficulty) also falls back rather than
 * propagating NaN into the engine config.
 */
export function readMiningSettings(): MiningSettings {
	const bindRaw = getMeta('mining_bind');
	const bind: MiningBind =
		bindRaw === 'lan' || bindRaw === 'all' || bindRaw === 'loopback' ? bindRaw : defaultBind();
	const stratumPort = intSetting('mining_stratum_port', DEFAULTS.stratumPort);
	const asicStratumPort = intSetting('mining_asic_stratum_port', DEFAULTS.asicStratumPort);
	return {
		enabled: boolSetting('mining_enabled', DEFAULTS.enabled),
		bind,
		bindHost: bindHostFor(bind),
		stratumPort,
		advertisedStratumPort: envPort('HEARTH_MINING_STRATUM_EXTERNAL_PORT', stratumPort),
		shareDifficulty: floatSetting('mining_share_difficulty', DEFAULTS.shareDifficulty),
		vardiffEnabled: boolSetting('mining_vardiff_enabled', DEFAULTS.vardiffEnabled),
		vardiffTargetPerMin: intSetting('mining_vardiff_target_rate', DEFAULTS.vardiffTargetPerMin),
		poolTag: getMeta('mining_pool_tag') || DEFAULTS.poolTag,
		asicPortEnabled: boolSetting('mining_asic_port_enabled', DEFAULTS.asicPortEnabled),
		asicStratumPort,
		advertisedAsicStratumPort: envPort('HEARTH_MINING_ASIC_EXTERNAL_PORT', asicStratumPort),
		asicShareDifficulty: floatSetting('mining_asic_share_difficulty', DEFAULTS.asicShareDifficulty),
		sv2Enabled: boolSetting('mining_sv2_enabled', DEFAULTS.sv2Enabled),
		sv2Port: intSetting('mining_sv2_port', DEFAULTS.sv2Port),
		sv2ShareDifficulty: floatSetting('mining_sv2_share_difficulty', DEFAULTS.sv2ShareDifficulty),
		sv2VersionRolling: boolSetting('mining_sv2_version_rolling', DEFAULTS.sv2VersionRolling)
	};
}

/** Persist one mining setting field. Values are stringified the same way
 *  {@link readMiningSettings} parses them back (booleans as '1'/'0'). */
export function writeMiningSetting(
	key:
		| 'mining_enabled'
		| 'mining_bind'
		| 'mining_stratum_port'
		| 'mining_share_difficulty'
		| 'mining_vardiff_enabled'
		| 'mining_vardiff_target_rate'
		| 'mining_pool_tag'
		| 'mining_asic_port_enabled'
		| 'mining_asic_stratum_port'
		| 'mining_asic_share_difficulty',
	value: string | number | boolean
): void {
	if (typeof value === 'boolean') setMeta(key, value ? '1' : '0');
	else setMeta(key, String(value));
}
