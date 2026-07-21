<script lang="ts">
	// Three-way System / Dark / Light toggle persisted to localStorage
	// (`hearth.theme`), applied via `data-theme` on <html> (DECISIONS.md §3).
	// The pre-paint script in app.html handles first-load; this component
	// keeps subsequent clicks in sync without a flash.
	//
	// Reconciled with /me's Display form (UX sweep hearth-i2x) through the
	// shared $lib/theme module: this is still the only control that decides
	// what THIS device renders (localStorage stays authoritative for the
	// pre-paint script), but every change is also best-effort mirrored to the
	// server-persisted account preference so /me agrees with it.
	import { readStoredTheme, applyThemeLocally, mirrorThemeToServer, type ThemeChoice } from '$lib/theme.js';

	let choice = $state<ThemeChoice>(readStoredTheme());

	function apply(next: ThemeChoice) {
		choice = next;
		applyThemeLocally(next);
		void mirrorThemeToServer(next);
	}

	const order: ThemeChoice[] = ['system', 'dark', 'light'];
	function cycle() {
		const next = order[(order.indexOf(choice) + 1) % order.length];
		apply(next);
	}

	const labels: Record<ThemeChoice, string> = {
		system: 'System',
		dark: 'Dark',
		light: 'Light'
	};
</script>

<button type="button" class="theme-toggle t-micro" onclick={cycle} title="Toggle theme">
	{labels[choice]}
</button>

<style>
	.theme-toggle {
		background: transparent;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-pill);
		padding: 6px 14px;
		cursor: pointer;
		color: var(--text-secondary);
	}

	.theme-toggle:hover {
		border-color: var(--border);
		color: var(--text);
	}
</style>
