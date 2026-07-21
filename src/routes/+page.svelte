<script lang="ts">
	// Home = the hearth (DECISIONS.md §4.2). M0 ships the themed shell only --
	// live tip height, node health and the watchtower feed wire up in M1.
</script>

<section class="hero panel">
	<p class="t-micro">The hearth</p>
	<p class="t-hero">0.00000000 <span class="unit">BTC</span></p>
	<p class="status t-label">Come navigate Bitcoin with me.</p>

	<div class="actions">
		<button class="btn-primary" type="button" disabled>Send</button>
		<button class="btn-primary secondary" type="button" disabled>Receive</button>
	</div>
</section>

<section class="feed panel">
	<p class="t-micro">Watchtower</p>
	<p class="t-label empty">Nothing to watch yet -- connect your node in Settings to get started.</p>
</section>

<style>
	.hero {
		text-align: center;
		margin-bottom: var(--space-4);
	}

	.unit {
		font-family: var(--font-ui);
		font-size: 0.35em;
		color: var(--text-secondary);
		vertical-align: middle;
	}

	.status {
		margin-top: var(--space-1);
	}

	.actions {
		display: flex;
		justify-content: center;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}

	.secondary {
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
	}

	.feed .empty {
		color: var(--text-muted);
	}
</style>
