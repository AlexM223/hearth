<script lang="ts">
	// Three-way System / Dark / Light toggle persisted to localStorage
	// (`hearth.theme`), applied via `data-theme` on <html> (DECISIONS.md §3).
	// The pre-paint script in app.html handles first-load; this component
	// keeps subsequent clicks in sync without a flash.
	type ThemeChoice = 'system' | 'dark' | 'light';

	function readStored(): ThemeChoice {
		if (typeof localStorage === 'undefined') return 'system';
		const stored = localStorage.getItem('hearth.theme');
		return stored === 'dark' || stored === 'light' ? stored : 'system';
	}

	let choice = $state<ThemeChoice>(readStored());

	function apply(next: ThemeChoice) {
		choice = next;
		if (next === 'system') {
			localStorage.removeItem('hearth.theme');
			document.documentElement.removeAttribute('data-theme');
		} else {
			localStorage.setItem('hearth.theme', next);
			document.documentElement.setAttribute('data-theme', next);
		}
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
