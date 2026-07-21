<script lang="ts">
	// Sign with device (Ledger WebHID / Trezor popup) -- SIGNING.md §2.2.1.
	// Per-device secure-context routing (T3) plus the actual Ledger flow (T4);
	// Trezor's real flow lands at T5. BROWSER-SIDE component -- never imports
	// $lib/server (SIGNING.md §0.3). All device libraries are lazy-imported
	// inside ledger.ts itself, never touched until a device tile is chosen.
	import { needsSecureContext, secureOrigin } from '$lib/hw/secureContext.js';
	import type { SigningWalletContext } from '$lib/shared/signing.js';
	import SecureContextNudge from './SecureContextNudge.svelte';

	let {
		walletId,
		psbt,
		onsigned,
		onerror,
		httpsExternalPort,
		wallet
	}: {
		walletId: number;
		psbt: string;
		onsigned: (signedPsbtBase64: string) => void;
		onerror: (message: string) => void;
		httpsExternalPort: number | null;
		wallet: SigningWalletContext;
	} = $props();

	type DeviceTile = 'ledger' | 'trezor';
	let device = $state<DeviceTile | null>(null);

	// Trezor's popup holds its own secure-context transport (works on plain
	// HTTP); Ledger's WebHID needs the page itself to be a secure context.
	const ledgerNeedsHop = $derived(needsSecureContext('ledger') && !secureOrigin());

	type Phase = 'idle' | 'connect' | 'device-approval' | 'registering' | 'signed' | 'error';
	let phase = $state<Phase>('idle');
	let message = $state<string | null>(null);
	let wrongDevice = $state(false);
	let timedOut = $state(false);

	function multisigKeys() {
		return wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }));
	}

	async function fetchRegistrations(): Promise<{ masterFp: string; policyHmac: string }[]> {
		try {
			const res = await fetch(`/api/wallets/${walletId}/ledger-registration`);
			if (!res.ok) return [];
			const j = (await res.json()) as { registrations: { masterFp: string; policyHmac: string }[] };
			return j.registrations;
		} catch {
			return [];
		}
	}

	async function saveRegistration(masterFp: string, policyName: string, policyHmac: string): Promise<void> {
		try {
			await fetch(`/api/wallets/${walletId}/ledger-registration`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ masterFp, policyName, policyHmac })
			});
		} catch {
			// Non-fatal: the sign already succeeded (or is about to) -- a failed
			// save just means the NEXT sign re-registers. Never block on this.
		}
	}

	async function signWithLedger() {
		phase = 'connect';
		message = null;
		wrongDevice = false;
		timedOut = false;
		try {
			const { signPsbtWithLedger, signMultisigPsbtWithLedger, registerMultisigPolicy, LedgerError } = await import(
				'$lib/hw/ledger.js'
			);
			if (wallet.kind === 'single') {
				phase = 'device-approval';
				const signed = await signPsbtWithLedger(psbt);
				phase = 'signed';
				onsigned(signed);
				return;
			}

			// Multisig: try a single already-known registration first (the
			// common case -- one cosigner, one device); anything else falls
			// through to a fresh registration ceremony.
			const scriptType = wallet.scriptType as 'p2sh' | 'p2sh-p2wsh' | 'p2wsh';
			const keys = multisigKeys();
			const registrations = await fetchRegistrations();
			const name = `Hearth ${wallet.threshold}-of-${keys.length}`;

			if (registrations.length === 1) {
				try {
					phase = 'device-approval';
					const signed = await signMultisigPsbtWithLedger(
						psbt,
						keys,
						wallet.threshold,
						scriptType,
						name,
						registrations[0].policyHmac
					);
					phase = 'signed';
					onsigned(signed);
					return;
				} catch (err) {
					if (!(err instanceof LedgerError) || (err.code !== 'policy_unregistered' && err.code !== 'wrong_device')) {
						throw err;
					}
					// Fall through to register-then-sign below.
				}
			}

			phase = 'registering';
			const reg = await registerMultisigPolicy(keys, wallet.threshold, scriptType, name);
			await saveRegistration(reg.masterFp, name, reg.policyHmac);

			phase = 'device-approval';
			const signed = await signMultisigPsbtWithLedger(psbt, keys, wallet.threshold, scriptType, name, reg.policyHmac);
			phase = 'signed';
			onsigned(signed);
		} catch (err) {
			phase = 'error';
			const { LedgerError } = await import('$lib/hw/ledger.js');
			if (err instanceof LedgerError) {
				message = err.message;
				wrongDevice = err.code === 'wrong_device';
				timedOut = err.code === 'timeout';
			} else {
				message = err instanceof Error ? err.message : 'Something went wrong signing with the Ledger.';
			}
			onerror(message ?? 'Something went wrong signing with the Ledger.');
		}
	}
</script>

{#if !device}
	<div class="device-tiles">
		<button class="device-tile t-label" type="button" onclick={() => (device = 'ledger')}>Ledger</button>
		<button class="device-tile t-label" type="button" onclick={() => (device = 'trezor')}>Trezor</button>
	</div>
{:else if device === 'ledger' && ledgerNeedsHop}
	<SecureContextNudge what="Ledger" {httpsExternalPort} />
{:else if device === 'ledger'}
	<div class="ledger-flow">
		{#if phase === 'idle'}
			<button class="btn-primary secondary" type="button" onclick={signWithLedger}>Connect your Ledger</button>
		{:else if phase === 'connect'}
			<p class="t-label muted">Plug in and unlock your Ledger, open the Bitcoin app…</p>
		{:else if phase === 'registering'}
			<p class="t-label muted">Registering this wallet with your Ledger -- check its screen…</p>
		{:else if phase === 'device-approval'}
			<p class="t-label muted">Check the amounts on your Ledger and approve.</p>
		{:else if phase === 'signed'}
			<p class="t-label ok">Signed.</p>
		{:else}
			<p class="t-label err">{message}</p>
			{#if timedOut}
				<button class="btn-primary secondary" type="button" onclick={signWithLedger}>Try again</button>
			{:else if wrongDevice}
				<p class="t-label muted">Connect the right Ledger for this wallet, then try again.</p>
				<button class="btn-primary secondary" type="button" onclick={signWithLedger}>Try again</button>
			{:else}
				<button class="btn-primary secondary" type="button" onclick={signWithLedger}>Try again</button>
			{/if}
		{/if}
	</div>
{:else}
	<p class="t-label muted">Trezor signing lands in a later step.</p>
{/if}

<style>
	.device-tiles {
		display: flex;
		gap: var(--space-2);
	}
	.device-tile {
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-input);
		padding: 10px 16px;
		cursor: pointer;
		color: var(--text);
		font-family: var(--font-ui);
	}
	.ledger-flow {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		align-items: flex-start;
	}
	.muted {
		color: var(--text-muted);
	}
	.ok {
		color: var(--sage);
	}
	.err {
		color: var(--error);
	}
</style>
