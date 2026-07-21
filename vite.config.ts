import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
	build: {
		// bitbox-api's WASM glue (src/lib/hw/bitbox02.ts, Stage 2) uses a
		// top-level `await` around WASM instantiation. Every browser this
		// signing surface can run in supports TLA natively (hardware signing
		// needs WebHID/WebUSB/BitBoxBridge, which set a far higher floor), so
		// emit it as-is instead of down-leveling. Deliberately NOT using
		// `vite-plugin-top-level-await` here even though SIGNING.md's original
		// plan called for it: cairn's own vite.config.ts (the pattern source)
		// found that plugin's esbuild re-transform of rolldown output breaks
		// the production build, and dropped it in favor of this `target`
		// setting alone -- carrying that proven fix forward rather than
		// reintroducing the bug it fixed.
		target: 'esnext'
	},
	optimizeDeps: {
		// The Ledger/Trezor/BBQr signing drivers (src/lib/hw/{ledger,trezor,bbqr}.ts)
		// reach these ONLY through a dynamic import() on the first "Sign with
		// device"/QR click (SIGNING.md §1). Left to on-demand discovery, Vite
		// meets a dozen new dependencies mid-session and re-optimizes, which can
		// abort the in-flight dynamic import with a stale "Outdated Optimize Dep"
		// 504. Pre-bundle the whole graph at dev-server start instead (cairn
		// vite.config.ts pattern). `buffer` is also the Node-global polyfill
		// ledger.ts installs before those libraries evaluate.
		include: [
			'@ledgerhq/hw-transport-webhid',
			'@ledgerhq/hw-app-btc/lib/newops/appClient.js',
			'@ledgerhq/hw-app-btc/lib/newops/policy.js',
			'@ledgerhq/hw-app-btc/lib/newops/clientCommands.js',
			'@ledgerhq/hw-app-btc/lib/newops/merkle.js',
			'@ledgerhq/hw-app-btc/lib/varint.js',
			'@ledgerhq/psbtv2',
			'buffer',
			'bbqr',
			'@trezor/connect-web'
		],
		// bitbox-api is a Rust core compiled to WASM with generated TS bindings
		// (src/lib/hw/bitbox02.ts loads it lazily). WASM packages must NOT be
		// esbuild-prebundled -- vite-plugin-wasm handles the .wasm asset itself.
		exclude: ['bitbox-api']
	},
	plugins: [
		// Required by bitbox-api's WASM bindings: the glue module uses
		// top-level await around the wasm instantiation -- supported natively
		// via build.target 'esnext' above.
		wasm(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
