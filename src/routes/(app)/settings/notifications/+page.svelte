<script lang="ts">
	// Settings -> Notifications: instance-wide channel config (WATCHTOWER.md
	// §2.2/§2.3, T7). Owner-only (redirected away otherwise by hooks.server.ts).
	// Each member still configures their OWN destination/routing at /me/notifications;
	// this page only sets the shared plumbing (the SMTP relay, the one Telegram
	// bot, ntfy/webhook/Nostr defaults) that every member's channel rides on.
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const s = $derived(data.settings);
</script>

<svelte:head>
	<title>Settings -- Notifications -- Hearth</title>
</svelte:head>

<section class="panel">
	<p class="t-micro">Settings</p>
	<h1 class="t-title">Notifications</h1>
	<p class="t-label muted">
		The shared plumbing every member's own channel rides on. Each member still chooses their own
		destination and routing at <a href="/me/notifications">their own Notifications page</a>.
	</p>
</section>

<section class="panel form-panel">
	{#if form?.saved}<p class="t-label ok">Saved.</p>{/if}

	<form method="POST" action="?/save">
		<p class="t-label section-title">SMTP relay (for the Email channel)</p>
		<label class="field">
			<span class="t-label">Host</span>
			<input class="input" type="text" name="smtpHost" value={s.smtp.host ?? ''} placeholder="smtp.example.com" />
		</label>
		<label class="field">
			<span class="t-label">Port</span>
			<input class="input" type="number" name="smtpPort" value={s.smtp.port} />
		</label>
		<label class="field">
			<span class="t-label">Username</span>
			<input class="input" type="text" name="smtpUser" value={s.smtp.user ?? ''} />
		</label>
		<label class="field">
			<span class="t-label">Password {s.smtp.hasPass ? '(set -- leave blank to keep it)' : ''}</span>
			<input class="input" type="password" name="smtpPass" autocomplete="off" />
		</label>
		<label class="field">
			<span class="t-label">From address</span>
			<input class="input" type="text" name="smtpFrom" value={s.smtp.from ?? ''} placeholder="hearth@example.com" />
		</label>
		<label class="field">
			<span class="t-label">Encryption</span>
			<select class="input" name="smtpTls">
				<option value="starttls" selected={s.smtp.tls === 'starttls'}>STARTTLS</option>
				<option value="tls" selected={s.smtp.tls === 'tls'}>TLS</option>
				<option value="none" selected={s.smtp.tls === 'none'}>None</option>
			</select>
		</label>

		<div class="hairline divider"></div>
		<p class="t-label section-title">Telegram bot (one per instance)</p>
		<label class="field">
			<span class="t-label">Bot token {s.telegram.hasBotToken ? '(set -- leave blank to keep it)' : ''}</span>
			<input class="input" type="password" name="telegramBotToken" autocomplete="off" placeholder="123456:ABC-DEF..." />
		</label>

		<div class="hairline divider"></div>
		<p class="t-label section-title">ntfy</p>
		<label class="field">
			<span class="t-label">Default server</span>
			<input
				class="input"
				type="text"
				name="ntfyDefaultServer"
				value={s.ntfy.defaultServer ?? ''}
				placeholder="https://ntfy.sh"
			/>
		</label>

		<div class="hairline divider"></div>
		<p class="t-label section-title">Nostr</p>
		<label class="field">
			<span class="t-label">Default relays (one per line)</span>
			<textarea class="input mono" name="nostrDefaultRelays" rows="3" placeholder="wss://relay.damus.io"
				>{s.nostr.defaultRelays.join('\n')}</textarea
			>
		</label>

		<div class="hairline divider"></div>
		<p class="t-label section-title">Webhook</p>
		<label class="checkbox">
			<input type="checkbox" name="webhookAllowPrivateTargets" checked={s.webhook.allowPrivateTargets} />
			<span class="t-label"
				>Allow webhook targets on private/LAN addresses -- only for a self-hoster's own network</span
			>
		</label>

		<button class="btn-primary" type="submit">Save notification settings</button>
	</form>
</section>

<style>
	.muted {
		color: var(--text-muted);
	}
	.muted a {
		color: var(--accent);
	}
	.ok {
		color: var(--sage);
	}
	.form-panel {
		margin-top: var(--space-3);
	}
	.field,
	.checkbox {
		display: block;
		margin: var(--space-2) 0;
	}
	.field span {
		display: block;
		color: var(--text-secondary);
		margin-bottom: 6px;
	}
	.checkbox {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.input {
		width: 100%;
		background: var(--bg-input);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		color: var(--text);
		font-family: var(--font-ui);
		padding: 10px 12px;
		font-size: var(--t-body);
	}
	.input.mono {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.divider {
		margin: var(--space-3) 0;
	}
	.section-title {
		color: var(--text-secondary);
		margin-bottom: var(--space-2);
	}
</style>
