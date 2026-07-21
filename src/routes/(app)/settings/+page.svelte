<script lang="ts">
	// Settings: chain backend, display, notifications, members & invites
	// (DECISIONS.md §4.2). Members & Invites landed in M3; chain backend/
	// display/notifications remain M4/M6 shells.
</script>

<section class="panel">
	<p class="t-micro">Settings</p>
	<h1 class="t-title">Chain backend, display &amp; members</h1>
	<p class="t-label">Node auto-connect and sats-first display will live here starting in M4.</p>
</section>

<section class="panel entry">
	<p class="t-micro">Members &amp; invites</p>
	<p class="t-label">
		Invite the people you trust aboard, manage roles, and see the household's shared standing.
	</p>
	<a class="btn-primary" href="/settings/members">Manage members &amp; invites</a>
</section>

<section class="panel entry">
	<p class="t-micro">Notifications</p>
	<p class="t-label">
		Set the shared SMTP relay, the instance's Telegram bot, and ntfy/Nostr/webhook defaults every
		member's own channel rides on.
	</p>
	<a class="btn-primary" href="/settings/notifications">Manage notification settings</a>
</section>

<style>
	.entry {
		margin-top: var(--space-3);
	}
	.entry a {
		display: inline-block;
		margin-top: var(--space-2);
		text-decoration: none;
	}
</style>
