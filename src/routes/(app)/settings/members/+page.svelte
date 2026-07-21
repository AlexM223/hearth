<script lang="ts">
	// Settings -> Members & Invites (COME-ABOARD.md §5, §6.3): the roster
	// (read-only figures per §4), pending invites, and the invite-create form.
	import { invalidateAll } from '$app/navigation';
	import { formatSats } from '$lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let role = $state<'member' | 'guest'>('member');
	let note = $state('');
	let expiry = $state('7d');
	let allowMultiple = $state(false);
	let busy = $state(false);

	const ROLE_CAPTION: Record<'member' | 'guest', string> = {
		member: 'Own wallet, own mining, no settings, no invite.',
		guest: 'Read-only seat: explorer, node health, mining pool. No wallet, no spending.'
	};

	function roleLabel(r: string): string {
		return r === 'owner' ? 'Owner' : r === 'member' ? 'Member' : 'Guest';
	}

	async function submitCreate(e: SubmitEvent) {
		// Progressive-enhancement-lite: let the native form POST happen, but
		// flip a busy flag for feedback. No client JS is required for this to work.
		busy = true;
		setTimeout(() => (busy = false), 3000);
	}
</script>

<svelte:head>
	<title>Members &amp; Invites -- Hearth</title>
</svelte:head>

<section class="panel">
	<p class="t-micro">Settings</p>
	<h1 class="t-title">Members &amp; invites</h1>
	<p class="t-label muted">
		{data.household.memberCount === 0
			? 'Just you so far'
			: `${data.household.memberCount} invited aboard`} · household total {formatSats(
			data.household.confirmedSats
		)} sats
	</p>
</section>

<section class="panel roster">
	<p class="t-micro">The roster</p>
	<ul class="member-list">
		{#each data.members as m (m.id)}
			<li class="hairline member-row">
				<div class="who">
					<span class="t-body name">{m.displayName ?? m.username}</span>
					<span class="pill role-{m.role}">{roleLabel(m.role)}</span>
				</div>
				<span class="t-label balance">{formatSats(m.confirmedSats)} sats</span>
				<span class="t-label muted">Not mining</span>
				<span class="t-label muted activity">{m.activity}</span>
				<span class="t-label muted provenance"
					>{m.invitedByUsername ? `invited by ${m.invitedByUsername}` : '—'}</span
				>

				<form method="POST" action="?/changeRole" class="row-form">
					<input type="hidden" name="id" value={m.id} />
					<select class="input small" name="role">
						<option value="owner" selected={m.role === 'owner'}>Owner</option>
						<option value="member" selected={m.role === 'member'}>Member</option>
						<option value="guest" selected={m.role === 'guest'}>Guest</option>
					</select>
					<button class="link-btn t-label" type="submit">Save role</button>
				</form>

				{#if m.id !== data.ownUserId}
					<form method="POST" action="?/offboard" class="row-form">
						<input type="hidden" name="id" value={m.id} />
						<select class="input small" name="walletPolicy">
							<option value="remove">Remove wallets</option>
							<option value="transfer">Keep wallets (transfer to me)</option>
						</select>
						<button class="link-btn danger t-label" type="submit">Offboard</button>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
	{#if form?.error}<p class="err t-label">{form.error}</p>{/if}
</section>

<section class="panel invite-create">
	<p class="t-micro">Invite someone aboard</p>

	{#if form?.createdInvite}
		<div class="created-link hairline">
			<p class="t-label ok">
				Link created ({form.createdInvite.role}) — copy it now, it won't be shown again:
			</p>
			<input class="input mono" readonly value={form.createdInvite.url} onclick={(e) => (e.target as HTMLInputElement).select()} />
		</div>
	{/if}
	{#if form?.error}<p class="err t-label">{form.error}</p>{/if}

	<form method="POST" action="?/createInvite" onsubmit={submitCreate}>
		<fieldset class="role-choice">
			<label class="radio">
				<input type="radio" name="role" value="member" bind:group={role} />
				<span>Member — {ROLE_CAPTION.member}</span>
			</label>
			<label class="radio">
				<input type="radio" name="role" value="guest" bind:group={role} />
				<span>Guest — {ROLE_CAPTION.guest}</span>
			</label>
		</fieldset>

		<label class="field">
			<span class="t-label">Note (private, for your own list)</span>
			<input class="input" type="text" name="note" bind:value={note} placeholder="Mum's iPad" />
		</label>

		<label class="field">
			<span class="t-label">Expiry</span>
			<select class="input" name="expiry" bind:value={expiry}>
				<option value="1h">1 hour</option>
				<option value="24h">24 hours</option>
				<option value="7d">7 days (default)</option>
				<option value="30d">30 days</option>
				<option value="never">Never — a link that never expires is a standing key</option>
			</select>
		</label>

		<label class="checkbox">
			<input type="checkbox" name="allowMultiple" bind:checked={allowMultiple} />
			<span class="t-label"
				>Allow multiple people to use this link (up to 5) — single-use is safest</span
			>
		</label>

		<button class="btn-primary" type="submit" disabled={busy}>Create invite link</button>
	</form>
</section>

<section class="panel pending-invites">
	<p class="t-micro">Pending invites</p>
	{#if data.invites.filter((i) => i.state === 'active').length === 0}
		<p class="t-label muted">No active invites right now.</p>
	{:else}
		<ul class="invite-list">
			{#each data.invites.filter((i) => i.state === 'active') as i (i.id)}
				<li class="hairline invite-row">
					<span class="t-body">{i.note ?? '(no note)'}</span>
					<span class="pill role-{i.role}">{roleLabel(i.role)}</span>
					<span class="t-label muted">{i.expiresAt ? `expires ${i.expiresAt.slice(0, 10)}` : 'never expires'}</span>
					<span class="t-label muted">{i.usedCount}/{i.maxUses} used</span>
					<form
						method="POST"
						action="?/revokeInvite"
						onsubmit={() => invalidateAll()}
					>
						<input type="hidden" name="id" value={i.id} />
						<button class="link-btn t-label" type="submit">Revoke</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.invites.some((i) => i.state !== 'active')}
		<p class="t-micro history-label">History</p>
		<ul class="invite-list muted-list">
			{#each data.invites.filter((i) => i.state !== 'active') as i (i.id)}
				<li class="hairline invite-row">
					<span class="t-body">{i.note ?? '(no note)'}</span>
					<span class="pill role-{i.role}">{roleLabel(i.role)}</span>
					<span class="t-label muted">{i.state}</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.muted {
		color: var(--text-muted);
	}
	.roster,
	.invite-create,
	.pending-invites {
		margin-top: var(--space-3);
	}
	.member-list,
	.invite-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.member-row,
	.invite-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px 0;
		flex-wrap: wrap;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 160px;
	}
	.balance {
		font-variant-numeric: tabular-nums;
		min-width: 100px;
	}
	.activity {
		min-width: 100px;
	}
	.provenance {
		margin-left: auto;
	}
	.row-form {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.input.small {
		width: auto;
		padding: 6px 8px;
		font-size: var(--t-label);
	}
	.danger:hover {
		color: var(--error);
	}
	.pill {
		font-size: var(--t-label);
		padding: 2px 10px;
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		color: var(--text-secondary);
	}
	.pill.role-owner {
		color: var(--accent);
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
	.role-choice {
		border: none;
		padding: 0;
		margin: var(--space-2) 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.radio {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: var(--t-body);
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
	.created-link {
		padding-bottom: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.ok {
		color: var(--sage);
	}
	.err {
		color: var(--error);
	}
	.link-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-family: var(--font-ui);
	}
	.link-btn:hover {
		color: var(--error);
	}
	.history-label {
		margin-top: var(--space-3);
		color: var(--text-muted);
	}
	.muted-list {
		opacity: 0.6;
	}
</style>
