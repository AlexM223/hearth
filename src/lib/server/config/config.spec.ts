import { describe, expect, it } from 'vitest';
import { detectPlatform, loadConfig } from './index.js';

describe('config: platform detection', () => {
	it('defaults to dev when HEARTH_PLATFORM is unset', () => {
		expect(detectPlatform({})).toBe('dev');
	});

	it('is umbrel only when HEARTH_PLATFORM=umbrel exactly', () => {
		expect(detectPlatform({ HEARTH_PLATFORM: 'umbrel' })).toBe('umbrel');
		expect(detectPlatform({ HEARTH_PLATFORM: 'production' })).toBe('dev');
	});
});

describe('config: loadConfig dev mode (Windows dev fallback, DECISIONS.md §5.3)', () => {
	it('defaults Core RPC to 127.0.0.1:8332 user alex', () => {
		const config = loadConfig({});
		expect(config.platform).toBe('dev');
		expect(config.core.host).toBe('127.0.0.1');
		expect(config.core.port).toBe(8332);
		expect(config.core.user).toBe('alex');
	});

	it('defaults Electrum to umbrel.local:50002 plaintext', () => {
		const config = loadConfig({});
		expect(config.electrum.host).toBe('umbrel.local');
		expect(config.electrum.port).toBe(50002);
		expect(config.electrum.tls).toBe(false);
	});

	it('defaults the data dir and db path to a repo-local ./data', () => {
		const config = loadConfig({});
		expect(config.dataDir).toBe('./data');
		expect(config.dbPath).toBe('./data/hearth.db');
	});
});

describe('config: loadConfig umbrel mode (DECISIONS.md §5.3)', () => {
	const umbrelEnv = { HEARTH_PLATFORM: 'umbrel', APP_DATA_DIR: '/app-data' };

	it('defaults Core RPC to the fixed 10.21.21.8:8332 service address', () => {
		const config = loadConfig(umbrelEnv);
		expect(config.platform).toBe('umbrel');
		expect(config.core.host).toBe('10.21.21.8');
		expect(config.core.port).toBe(8332);
	});

	it('defaults Electrum (Fulcrum) to the fixed 10.21.21.200:50002 plaintext address', () => {
		const config = loadConfig(umbrelEnv);
		expect(config.electrum.host).toBe('10.21.21.200');
		expect(config.electrum.port).toBe(50002);
		expect(config.electrum.tls).toBe(false);
	});

	it('derives the data dir from APP_DATA_DIR', () => {
		const config = loadConfig(umbrelEnv);
		expect(config.dataDir).toBe('/app-data/data');
		expect(config.dbPath).toBe('/app-data/data/hearth.db');
	});

	it('never hardcodes Core RPC credentials -- user/pass come from env only', () => {
		const config = loadConfig(umbrelEnv);
		expect(config.core.user).toBeUndefined();
		expect(config.core.passEnvVar).toBeUndefined();

		const withCreds = loadConfig({
			...umbrelEnv,
			HEARTH_CORE_RPC_USER: 'injected-user'
		});
		expect(withCreds.core.user).toBe('injected-user');
		expect(withCreds.core.passEnvVar).toBe('HEARTH_CORE_RPC_PASS');
	});
});

describe('config: httpsExternalPort (SIGNING.md §4.3 -- the hop URL never guesses 4489)', () => {
	it('is null when no HTTPS listener is advertised at all', () => {
		expect(loadConfig({}).httpsExternalPort).toBeNull();
	});

	it('falls back to HEARTH_HTTPS_PORT when no external port is set', () => {
		expect(loadConfig({ HEARTH_HTTPS_PORT: '3443' }).httpsExternalPort).toBe(3443);
	});

	it('prefers HEARTH_HTTPS_EXTERNAL_PORT over HEARTH_HTTPS_PORT (Docker port mapping)', () => {
		const config = loadConfig({ HEARTH_HTTPS_PORT: '3443', HEARTH_HTTPS_EXTERNAL_PORT: '4489' });
		expect(config.httpsExternalPort).toBe(4489);
	});
});

describe('config: explicit overrides win over both platform defaults', () => {
	it('honors HEARTH_DB / HEARTH_ORIGIN / PORT regardless of platform', () => {
		const config = loadConfig({
			PORT: '4000',
			HEARTH_DB: '/custom/hearth.db',
			HEARTH_ORIGIN: 'https://hearth.example'
		});
		expect(config.port).toBe(4000);
		expect(config.dbPath).toBe('/custom/hearth.db');
		expect(config.origin).toBe('https://hearth.example');
	});
});
