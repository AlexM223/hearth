import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
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
		]
	},
	plugins: [
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
