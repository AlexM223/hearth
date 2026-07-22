<script lang="ts">
	// Self notification routing (WATCHTOWER.md §2.6/§2.7, T7): every role
	// reaches this from /me -- each member manages ONLY their own channels,
	// routing matrix, and quiet hours. "Send test" calls the real test-send
	// API route directly (no form submit / page reload) so the result shows
	// inline next to the button it was requested from.
	import type { PageProps } from './$types';
	import type {
		RedactedEmailConfig,
		RedactedTelegramConfig,
		RedactedNtfyConfig,
		RedactedNostrConfig,
		RedactedWebhookConfig
	} from '$lib/server/notify/config/channelConfig.js';

	let { data, form }: PageProps = $props();

	const EVENT_LABEL: Record<string, string> = {
		tx_received: 'Payment received',
		tx_confirmed: 'Payment confirmed',
		tx_large: 'Large payment',
		tx_replaced: 'Payment reversed/cancelled'
	};

	const CHANNEL_HINT: Record<string, string> = {
		email: 'Email',
		telegram: 'Telegram',
		ntfy: 'ntfy',
		nostr: 'Nostr',
		webhook: 'Webhook'
	};

	function channelData(id: string) {
		return data.channels.find((c) => c.id === id)!;
	}
	// channelData() returns the general RedactedChannelConfig union (the loader
	// builds it from a variable channel id); each accessor here is only ever
	// called with the matching literal id above, so the shape is known.
	const email = $derived(channelData('email').config as RedactedEmailConfig);
	const telegram = $derived(channelData('telegram').config as RedactedTelegramConfig);
	const ntfy = $derived(channelData('ntfy').config as RedactedNtfyConfig);
	const nostr = $derived(channelData('nostr').config as RedactedNostrConfig);
	const webhook = $derived(channelData('webhook').config as RedactedWebhookConfig);

	let testBusy = $state<Record<string, boolean>>({});
	let testResult = $state<Record<string, { ok: boolean; error?: string } | null>>({});

	async function sendTest(channel: string) {
		testBusy = { ...testBusy, [channel]: true };
		testResult = { ...testResult, [channel]: null };
		try {
			const res = await fetch(`/api/me/notifications/channels/${channel}/test`, { method: 'POST' });
			const body = await res.json();
			testResult = { ...testResult, [channel]: body };
		} catch {
			testResult = { ...testResult, [channel]: { ok: false, error: 'request failed' } };
		} finally {
			testBusy = { ...testBusy, [channel]: false };
		}
	}
</script>

<svelte:head>
	<title>Notifications -- Hearth</title>
</svelte:head>

<section class="panel">
	<p class="t-micro">Your account</p>
	<h1 class="t-title">Notifications</h1>
	<p class="t-label muted">
		The in-app feed is always on. Everything below is optional -- add a channel, then choose which
		of your own events reach it.
	</p>
</section>

<section class="panel matrix-panel">
	<p class="t-micro">Routing</p>
	{#if form?.savedPrefs}<p class="t-label ok">Saved.</p>{/if}
	{#if form?.error}<p class="t-label err">{form.error}</p>{/if}

	<form method="POST" action="?/savePrefs">
		<div class="matrix-scroll">
			<table class="matrix">
				<thead>
					<tr>
						<th class="t-label">Event</th>
						{#each data.channels as c (c.id)}
							<th class="t-label center">{CHANNEL_HINT[c.id]}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each data.eventTypes as eventType (eventType)}
						<tr class="hairline">
							<td class="t-label event-name">{EVENT_LABEL[eventType]}</td>
							{#each data.channels as c (c.id)}
								<td class="center">
									<input
										type="checkbox"
										name={`pref_${eventType}_${c.id}`}
										checked={data.matrix[eventType][c.id]}
										disabled={!c.isConfigured}
									/>
								</td>
							{/each}
						</tr>
						{#if eventType === 'tx_large'}
							<tr class="hairline sub-row">
								<td colspan={data.channels.length + 1}>
									<label class="inline-field t-label">
										Threshold (sats)
										<input
											class="input small"
											type="number"
											min="1"
											name="thresholdSats"
											value={data.thresholdSats ?? ''}
											placeholder="e.g. 1000000"
										/>
									</label>
								</td>
							</tr>
						{/if}
						{#if eventType === 'tx_confirmed'}
							<tr class="hairline sub-row">
								<td colspan={data.channels.length + 1}>
									<span class="t-label">Confirm at:</span>
									{#each [1, 3, 6] as n (n)}
										<label class="inline-checkbox t-label">
											<input type="checkbox" name={`confirm_${n}`} checked={data.confirmations.includes(n)} />
											{n}
										</label>
									{/each}
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		<p class="t-label muted hint">
			A greyed-out box means that channel isn't configured yet -- set it up below first.
		</p>
		<button class="btn-primary" type="submit">Save routing</button>
	</form>
</section>

{#each data.channels as c (c.id)}
	<section class="panel channel-panel">
		<div class="channel-head">
			<p class="t-micro">{c.label}</p>
			<span class="pill {c.isConfigured ? 'pill-ok' : 'pill-off'}">
				{c.isConfigured ? 'Configured' : 'Not configured'}
			</span>
		</div>

		{#if form?.savedChannel === c.id}<p class="t-label ok">Saved.</p>{/if}

		{#if c.id === 'email'}
			<form method="POST" action="?/saveEmail">
				<label class="field">
					<span class="t-label">Destination address</span>
					<input class="input" type="email" name="address" value={email.address ?? ''} placeholder="you@example.com" />
				</label>
				<div class="hairline divider"></div>
				<p class="t-label section-title">Personal SMTP relay (optional -- otherwise uses the instance relay)</p>
				<label class="field">
					<span class="t-label">Host</span>
					<input class="input" type="text" name="smtpHost" value={email.smtp?.host ?? ''} placeholder="smtp.example.com" />
				</label>
				<label class="field">
					<span class="t-label">Port</span>
					<input class="input" type="number" name="smtpPort" value={email.smtp?.port ?? 587} />
				</label>
				<label class="field">
					<span class="t-label">Username</span>
					<input class="input" type="text" name="smtpUser" value={email.smtp?.user ?? ''} />
				</label>
				<label class="field">
					<span class="t-label">Password {email.smtp?.hasPass ? '(set -- leave blank to keep it)' : ''}</span>
					<input class="input" type="password" name="smtpPass" autocomplete="off" />
				</label>
				<label class="field">
					<span class="t-label">Encryption</span>
					<select class="input" name="smtpTls">
						<option value="starttls" selected={(email.smtp?.tls ?? 'starttls') === 'starttls'}>STARTTLS</option>
						<option value="tls" selected={email.smtp?.tls === 'tls'}>TLS</option>
						<option value="none" selected={email.smtp?.tls === 'none'}>None</option>
					</select>
				</label>
				<button class="btn-primary secondary" type="submit">Save email</button>
			</form>
		{:else if c.id === 'telegram'}
			<form method="POST" action="?/saveTelegram">
				<label class="field">
					<span class="t-label">Chat ID</span>
					<input class="input" type="text" name="chatId" value={telegram.chatId ?? ''} placeholder="123456789" />
				</label>
				<p class="t-label muted hint">
					Message your instance's Telegram bot once so it can reach you, then paste the chat ID your
					bot receives.
				</p>
				<button class="btn-primary secondary" type="submit">Save Telegram</button>
			</form>
		{:else if c.id === 'ntfy'}
			<form method="POST" action="?/saveNtfy">
				<label class="field">
					<span class="t-label">Server (optional -- defaults to the instance default, or ntfy.sh)</span>
					<input class="input" type="text" name="server" value={ntfy.server ?? ''} placeholder="https://ntfy.sh" />
				</label>
				<label class="field">
					<span class="t-label">Topic</span>
					<input class="input" type="text" name="topic" value={ntfy.topic ?? ''} placeholder="hearth-alex" />
				</label>
				<label class="field">
					<span class="t-label">Access token {ntfy.hasAccessToken ? '(set -- leave blank to keep it)' : '(optional)'}</span>
					<input class="input" type="password" name="accessToken" autocomplete="off" />
				</label>
				<button class="btn-primary secondary" type="submit">Save ntfy</button>
			</form>
		{:else if c.id === 'nostr'}
			<form method="POST" action="?/saveNostr">
				<label class="field">
					<span class="t-label">Your Nostr pubkey (npub or hex)</span>
					<input class="input mono" type="text" name="recipientPubkey" value={nostr.recipientPubkey ?? ''} placeholder="npub1..." />
				</label>
				<label class="field">
					<span class="t-label">Relays (optional -- one per line, otherwise uses the instance defaults)</span>
					<textarea class="input mono" name="relays" rows="3" placeholder="wss://relay.example.com">{(nostr.relays ?? []).join('\n')}</textarea>
				</label>
				<button class="btn-primary secondary" type="submit">Save Nostr</button>
			</form>
		{:else if c.id === 'webhook'}
			<form method="POST" action="?/saveWebhook">
				<label class="field">
					<span class="t-label">URL</span>
					<input class="input" type="text" name="url" value={webhook.url ?? ''} placeholder="https://example.com/hook" />
				</label>
				<label class="field">
					<span class="t-label">HMAC signing secret {webhook.hasSecret ? '(set -- leave blank to keep it)' : '(optional)'}</span>
					<input class="input" type="password" name="secret" autocomplete="off" />
				</label>
				<button class="btn-primary secondary" type="submit">Save webhook</button>
			</form>
		{/if}

		<div class="hairline divider"></div>
		<div class="test-row">
			<button
				class="link-btn t-label"
				type="button"
				disabled={!c.isConfigured || testBusy[c.id]}
				onclick={() => sendTest(c.id)}
			>
				{testBusy[c.id] ? 'Sending...' : 'Send test'}
			</button>
			{#if testResult[c.id]}
				<span class="t-label {testResult[c.id]?.ok ? 'ok' : 'err'}">
					{testResult[c.id]?.ok ? 'Test sent.' : (testResult[c.id]?.error ?? 'Test failed.')}
				</span>
			{/if}
		</div>
	</section>
{/each}

<section class="panel quiet-panel">
	<p class="t-micro">Quiet hours</p>
	{#if form?.savedQuietHours}<p class="t-label ok">Saved.</p>{/if}
	<p class="t-label muted">
		Routine notifications wait until quiet hours end; urgent alerts (reversed payments) still come
		through. In-app is unaffected.
	</p>
	<form method="POST" action="?/saveQuietHours">
		<label class="checkbox">
			<input type="checkbox" name="quietEnabled" checked={data.quietHours !== null} />
			<span class="t-label">Enable quiet hours</span>
		</label>
		<label class="inline-field t-label">
			From
			<input class="input small" type="time" name="quietStart" value={data.quietHours?.start ?? '22:00'} />
		</label>
		<label class="inline-field t-label">
			To
			<input class="input small" type="time" name="quietEnd" value={data.quietHours?.end ?? '07:00'} />
		</label>
		<button class="btn-primary secondary" type="submit">Save quiet hours</button>
	</form>
</section>

<style>
	.muted {
		color: var(--text-muted);
	}
	.ok {
		color: var(--sage);
	}
	.err {
		color: var(--error);
	}
	.matrix-panel,
	.channel-panel,
	.quiet-panel {
		margin-top: var(--space-3);
	}
	.matrix-scroll {
		overflow-x: auto;
	}
	.matrix {
		width: 100%;
		border-collapse: collapse;
		margin: var(--space-2) 0;
	}
	.matrix th,
	.matrix td {
		padding: 8px 10px;
		text-align: left;
	}
	.matrix th.center,
	.matrix td.center {
		text-align: center;
	}
	.event-name {
		white-space: nowrap;
	}
	.sub-row td {
		padding-top: 0;
		padding-bottom: 10px;
	}
	.hint {
		margin-top: var(--space-1);
	}
	.inline-field {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-right: var(--space-3);
	}
	.inline-checkbox {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-right: var(--space-2);
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
	.input.small {
		width: auto;
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
	.secondary {
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
	}
	.channel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.pill {
		font-size: var(--t-label);
		padding: 2px 10px;
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		color: var(--text-secondary);
	}
	.pill-ok {
		color: var(--sage);
	}
	.pill-off {
		color: var(--text-muted);
	}
	.link-btn {
		background: none;
		border: none;
		color: var(--accent);
		cursor: pointer;
		font-family: var(--font-ui);
		padding: 0;
	}
	.link-btn:disabled {
		color: var(--text-faint);
		cursor: default;
	}
	.test-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
