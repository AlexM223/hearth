/**
 * Config module (DECISIONS.md §5.3, §5.4) -- layered HEARTH_* env defaults for
 * Umbrel vs Windows-dev, with platform auto-detection. This is the ONLY place
 * that reads process.env for node/data-directory settings; every other module
 * takes a `HearthConfig` (or a narrower slice of it) as a constructor/function
 * argument instead of reading `process.env` itself.
 *
 * Hard rule: never hardcode credentials. Core RPC creds come from
 * HEARTH_CORE_RPC_USER / HEARTH_CORE_RPC_PASS (Umbrel: interpolated from the
 * bitcoin app's exports in docker-compose.yml) or a cookie file path
 * (HEARTH_CORE_RPC_COOKIE, the Windows-dev default lives outside the repo).
 */

export type Platform = 'umbrel' | 'dev';

export interface CoreRpcConfig {
	host: string;
	port: number;
	/** RPC username, when auth is by user/pass rather than cookie file. */
	user?: string;
	/** Path to Core's .cookie file, when auth is by cookie (typical dev setup). */
	cookiePath?: string;
	/** Env var name the password was read from, for diagnostics only -- never the value itself. */
	passEnvVar?: string;
}

export interface ElectrumConfig {
	host: string;
	port: number;
	/** Fulcrum is reached PLAINTEXT (not TLS) in both Umbrel and dev, per DECISIONS.md §4.4. */
	tls: boolean;
}

export interface HearthConfig {
	platform: Platform;
	/** HTTP port the SvelteKit/adapter-node handler binds to. */
	port: number;
	/** Optional self-signed HTTPS port (secure context for WebHID/WebSerial/camera QR). */
	httpsPort: number | null;
	/** The HOST-visible HTTPS port the UI should link to for the secure-context
	 * hop (SIGNING.md §4.3) -- may differ from `httpsPort` under Docker port
	 * mapping. `HEARTH_HTTPS_EXTERNAL_PORT`, falling back to `HEARTH_HTTPS_PORT`.
	 * `null` when no HTTPS listener is advertised at all (device/camera signing
	 * methods are hidden rather than the UI guessing a literal port). */
	httpsExternalPort: number | null;
	/** Externally-visible origin, used for CSRF/session-cookie correctness behind app_proxy. */
	origin: string | null;
	dataDir: string;
	dbPath: string;
	logFile: string | null;
	core: CoreRpcConfig;
	electrum: ElectrumConfig;
}

/** Platform is detected from a single explicit flag -- never sniffed from the filesystem. */
export function detectPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
	return env.HEARTH_PLATFORM === 'umbrel' ? 'umbrel' : 'dev';
}

function num(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build the full config from environment. Pass a custom `env` (e.g. in tests)
 * instead of mutating `process.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HearthConfig {
	const platform = detectPlatform(env);

	// Data directory: Umbrel bind-mounts ${APP_DATA_DIR}/data; Windows dev uses
	// a repo-local ./data (gitignored). DECISIONS.md §5.4.
	const dataDir = env.HEARTH_DATA_DIR ?? (env.APP_DATA_DIR ? `${env.APP_DATA_DIR}/data` : './data');
	const dbPath = env.HEARTH_DB ?? `${dataDir}/hearth.db`;
	const logFile = env.HEARTH_LOG_FILE ?? (platform === 'umbrel' ? `${dataDir}/logs/hearth.log` : null);

	const core: CoreRpcConfig =
		platform === 'umbrel'
			? {
					// Umbrel injects these via `dependencies: [bitcoin]` interpolation
					// in docker-compose.yml (APP_BITCOIN_NODE_IP / RPC_PORT / RPC_USER /
					// RPC_PASS) -- fixed service address confirmed at 10.21.21.8:8332.
					host: env.HEARTH_CORE_RPC_HOST ?? '10.21.21.8',
					port: num(env.HEARTH_CORE_RPC_PORT, 8332),
					user: env.HEARTH_CORE_RPC_USER,
					passEnvVar: env.HEARTH_CORE_RPC_USER ? 'HEARTH_CORE_RPC_PASS' : undefined
				}
			: {
					// Windows dev fallback: Alex's local node, txindex on, user `alex`.
					host: env.HEARTH_CORE_RPC_HOST ?? '127.0.0.1',
					port: num(env.HEARTH_CORE_RPC_PORT, 8332),
					user: env.HEARTH_CORE_RPC_USER ?? 'alex',
					cookiePath: env.HEARTH_CORE_RPC_COOKIE,
					passEnvVar: env.HEARTH_CORE_RPC_PASS ? 'HEARTH_CORE_RPC_PASS' : undefined
				};

	const electrum: ElectrumConfig =
		platform === 'umbrel'
			? {
					// Normally arrives via docker-compose.yml's HEARTH_ELECTRUM_HOST/PORT,
					// interpolated from ${APP_ELECTRS_NODE_IP}/${APP_ELECTRS_NODE_PORT} --
					// umbrel-app.yml declares `electrs` as a dependency (DECISIONS.md §8,
					// 2026-07-21 amendment) so umbrelOS guarantees install order and
					// injects the real address for whichever provider (electrs, or Fulcrum
					// via its `implements: [electrs]` contract) the user picked. The
					// literal fallback below is Fulcrum's own fixed service address on the
					// umbrel_main_network bridge -- it only fires if those vars ever come
					// through unset (e.g. a hand-rolled compose that skips the dependency).
					host: env.HEARTH_ELECTRUM_HOST ?? '10.21.21.200',
					port: num(env.HEARTH_ELECTRUM_PORT, 50002),
					tls: false
				}
			: {
					// Alex's Umbrel Fulcrum, reachable from Windows dev via mDNS.
					host: env.HEARTH_ELECTRUM_HOST ?? 'umbrel.local',
					port: num(env.HEARTH_ELECTRUM_PORT, 50002),
					tls: false
				};

	const httpsExternalPortRaw = env.HEARTH_HTTPS_EXTERNAL_PORT ?? env.HEARTH_HTTPS_PORT;

	return {
		platform,
		port: num(env.PORT, 3000),
		httpsPort: env.HEARTH_HTTPS_PORT ? num(env.HEARTH_HTTPS_PORT, 3443) : null,
		httpsExternalPort: httpsExternalPortRaw ? num(httpsExternalPortRaw, 4489) : null,
		origin: env.HEARTH_ORIGIN ?? null,
		dataDir,
		dbPath,
		logFile,
		core,
		electrum
	};
}

/**
 * Minimal instance-wide feature-flag gate (DECISIONS.md §4.6/§6 M5: the
 * mining engine's three-gate start sequence is "feature flag AND operator
 * setting AND Core RPC configured"). Hearth has no dynamic/admin-configurable
 * feature-flag system yet (unlike the cairn reference's `isFeatureEnabled`,
 * which reads a flags table with per-instance overrides) -- M0-M4 never
 * built one. Rather than invent that whole system as a side effect of M5,
 * this is a deliberately minimal env-var-backed placeholder: `HEARTH_FEATURE_
 * <NAME>` (uppercased), default enabled. The meaningful "off by default" gate
 * for mining is the `mining_enabled` operator setting (mining/settings.ts),
 * which defaults false -- this flag exists only as the coarse instance-wide
 * kill switch the three-gate design calls for. Reads `process.env` directly
 * (never cached) so a flag flip takes effect on the next check, matching the
 * "never freeze config at module load" rule this file already follows for
 * loadConfig(). Documented deviation from the richer system MINING-ENGINE.md
 * anchors to cairn's `isFeatureEnabled('mining', null)` call shape.
 */
export function isFeatureEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const key = `HEARTH_FEATURE_${name.toUpperCase()}`;
	const v = env[key];
	if (v === undefined) return true;
	return v !== '0' && v.toLowerCase() !== 'false';
}
