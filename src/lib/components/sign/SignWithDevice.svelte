<script lang="ts">
	// Sign with device (Ledger WebHID / Trezor popup) -- SIGNING.md §2.2.1.
	// Per-device secure-context routing (T3), the Ledger flow (T4), and the
	// Trezor flow (T5). BROWSER-SIDE component -- never imports $lib/server
	// (SIGNING.md §0.3). All device libraries are lazy-imported inside
	// ledger.ts/trezor.ts themselves, never touched until a device tile is
	// chosen.
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
	// HTTP, including Umbrel's :3252 origin with no hop); Ledger's WebHID
	// needs the page itself to be a secure context.
	const ledgerNeedsHop = $derived(needsSecureContext('ledger') && !secureOrigin());

	type Phase = 'idle' | 'connect' | 'device-approval' | 'registering' | 'signed' | 'error';
	let phase = $state<Phase>('idle');
	let message = $state<string | null>(null);
	let wrongDevice = $state(false);
	let timedOut = $state(false);

	function multisigKeys() {
		return wallet.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }));
	}

	function resetPhase() {
		phase = 'connect';
		message = null;
		wrongDevice = false;
		timedOut = false;
	}

	// ---- Ledger -----------------------------------------------------------

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
		resetPhase();
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
			const { LedgerError } = await import('$lib/hw/ledger.js');
			failPhase(err, err instanceof LedgerError ? err.code : undefined, 'Something went wrong signing with the Ledger.');
		}
	}

	// ---- Trezor -------------------------------------------------------------

	async function signWithTrezor() {
		resetPhase();
		phase = 'device-approval'; // Trezor's popup IS the "connect" UI; no separate wait state
		try {
			const { signPsbtWithTrezor, signMultisigPsbtWithTrezor } = await import('$lib/hw/trezor.js');
			const signed =
				wallet.kind === 'single'
					? await signPsbtWithTrezor(psbt)
					: await signMultisigPsbtWithTrezor(psbt, multisigKeys(), wallet.threshold);
			phase = 'signed';
			onsigned(signed);
		} catch (err) {
			const { TrezorError } = await import('$lib/hw/trezor.js');
			failPhase(err, err instanceof TrezorError ? err.code : undefined, 'Something went wrong signing with the Trezor.');
		}
	}

	function failPhase(err: unknown, code: string | undefined, fallback: string): void {
		phase = 'error';
		message = err instanceof Error ? err.message : fallback;
		wrongDevice = code === 'wrong_device';
		timedOut = code === 'timeout';
		onerror(message ?? fallback);
	}

	function retry() {
		if (device === 'ledger') void signWithLedger();
		else void signWithTrezor();
	}
</script>

{#if !device}
	<div class="device-tiles">
		<button class="device-tile t-label" type="button" onclick={() => (device = 'ledger')}>Ledger</button>
		<button class="device-tile t-label" type="button" onclick={() => (device = 'trezor')}>Trezor</button>
	</div>
{:else if device === 'ledger' && ledgerNeedsHop}
	<SecureContextNudge what="Ledger" {httpsExternalPort} />
{:else}
	<div class="device-flow">
		{#if phase === 'idle'}
			<button class="btn-primary secondary" type="button" onclick={() => (device === 'ledger' ? signWithLedger() : signWithTrezor())}>
				{device === 'ledger' ? 'Connect your Ledger' : 'Sign with Trezor'}
			</button>
		{:else if phase === 'connect'}
			<p class="t-label muted">Plug in and unlock your Ledger, open the Bitcoin app…</p>
		{:else if phase === 'registering'}
			<p class="t-label muted">Registering this wallet with your Ledger -- check its screen…</p>
		{:else if phase === 'device-approval'}
			<p class="t-label muted">
				{device === 'ledger' ? 'Check the amounts on your Ledger and approve.' : 'Check the amounts in the Trezor popup and approve on your device.'}
			</p>
		{:else if phase === 'signed'}
			<p class="t-label ok">Signed.</p>
		{:else}
			<p class="t-label err">{message}</p>
			{#if wrongDevice}
				<p class="t-label muted">Connect the right {device === 'ledger' ? 'Ledger' : 'Trezor'} for this wallet, then try again.</p>
			{/if}
			<button class="btn-primary secondary" type="button" onclick={retry}>Try again</button>
		{/if}
	</div>
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
	.device-flow {
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
