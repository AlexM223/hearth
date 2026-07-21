<script lang="ts">
	// Sign with file (SIGNING.md §2.2.2) -- the universal air-gap fallback.
	// Download the unsigned transaction, sign it externally (Sparrow /
	// Coldcard SD-card / any PSBT-capable signer), upload the signed
	// transaction back. Works on any browser/context, zero device libraries.
	// BROWSER-SIDE component -- never imports $lib/server (SIGNING.md §0.3).
	import { psbtBase64ToBytes, psbtFilename, readSignedPsbtUpload, InvalidPsbtFileError } from '$lib/hw/psbtFile.js';

	let {
		walletId,
		draftId,
		psbt,
		onsigned,
		onerror
	}: {
		walletId: number;
		draftId: number;
		psbt: string;
		onsigned: (signedPsbtBase64: string) => void;
		onerror: (message: string) => void;
	} = $props();

	let dragOver = $state(false);
	let uploadBusy = $state(false);
	let fileInput = $state<HTMLInputElement | undefined>(undefined);

	function downloadUnsigned() {
		const bytes = psbtBase64ToBytes(psbt);
		// Uint8Array<ArrayBufferLike> vs BlobPart's stricter ArrayBufferView<ArrayBuffer>
		// is a TS generic-strictness mismatch only -- Blob accepts any typed array at runtime.
		const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = psbtFilename(walletId, draftId);
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function handleFile(file: File | undefined) {
		if (!file) return;
		uploadBusy = true;
		try {
			const normalized = await readSignedPsbtUpload(file);
			onsigned(normalized);
		} catch (err) {
			onerror(
				err instanceof InvalidPsbtFileError
					? err.message
					: "That file doesn't look like the signed transaction."
			);
		} finally {
			uploadBusy = false;
		}
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		void handleFile(e.dataTransfer?.files?.[0]);
	}

	function onPick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		void handleFile(input.files?.[0]);
		input.value = '';
	}
</script>

<div class="file-sign">
	<div class="step">
		<p class="t-label muted">Step 1</p>
		<p class="t-body">Download the transaction to sign</p>
		<button class="btn-primary secondary" type="button" onclick={downloadUnsigned}>Download</button>
	</div>
	<div class="step">
		<p class="t-label muted">Step 2</p>
		<p class="t-body">Upload the signed transaction</p>
		<button
			class="dropzone"
			type="button"
			class:over={dragOver}
			ondragover={(e) => {
				e.preventDefault();
				dragOver = true;
			}}
			ondragleave={() => (dragOver = false)}
			ondrop={onDrop}
			onclick={() => fileInput?.click()}
			disabled={uploadBusy}
		>
			{uploadBusy ? 'Reading…' : 'Drop the signed file here, or click to choose'}
		</button>
		<input
			bind:this={fileInput}
			type="file"
			accept=".psbt,.txt"
			class="visually-hidden"
			onchange={onPick}
			aria-label="Upload the signed transaction"
		/>
	</div>
</div>

<style>
	.file-sign {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.step {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.muted {
		color: var(--text-muted);
	}
	.dropzone {
		border: 1px dashed var(--border);
		border-radius: var(--radius-input);
		background: var(--bg-input);
		color: var(--text-secondary);
		padding: 18px 12px;
		text-align: center;
		font-family: var(--font-ui);
		font-size: var(--t-body);
		cursor: pointer;
	}
	.dropzone.over {
		border-color: var(--accent);
		color: var(--text);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
