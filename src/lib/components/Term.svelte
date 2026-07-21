<script lang="ts">
	// The jargon-glossing mechanism DECISIONS.md §1 specifies: "Bitcoin jargon
	// (xpub, PSBT, UTXO, sat/vB) is glossed one tap down via a `<Term>`
	// mechanism, never in a primary row." A native <details>/<summary> is
	// exactly "one tap down" for free -- no JS state, keyboard-operable,
	// screen-reader-friendly (the disclosure semantics are built in), and it
	// degrades to plain text with no crash if styling fails to load.
	//
	// `label` is the jargon as it appears inline in the sentence (so callers
	// can keep it flowing in running prose, e.g. "paste an
	// <Term label="xpub" definition="..." /> or a descriptor"); `definition`
	// is the plain-language gloss shown when tapped, per DECISIONS.md §1's
	// brand voice (warm, plain-language, never assuming prior Bitcoin
	// literacy).
	let { label, definition }: { label: string; definition: string } = $props();
</script>

<details class="term">
	<summary class="term-summary t-mono">{label}</summary>
	<p class="term-gloss t-label">{definition}</p>
</details>

<style>
	.term {
		display: inline-block;
		vertical-align: baseline;
	}

	.term-summary {
		display: inline;
		cursor: pointer;
		color: var(--text);
		text-decoration: underline dotted var(--text-muted);
		text-underline-offset: 2px;
		list-style: none;
	}

	/* Remove the default disclosure triangle (Chromium/Firefox use ::marker,
	   Safari uses the -webkit- pseudo) -- the dotted underline is the only
	   affordance; this reads as glossed text, not an accordion. */
	.term-summary::marker,
	.term-summary::-webkit-details-marker {
		display: none;
		content: '';
	}

	.term-summary:hover {
		color: var(--accent);
	}

	.term-gloss {
		display: inline-block;
		margin: 4px 0 0;
		padding: 8px 10px;
		max-width: 320px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-input);
		color: var(--text-secondary);
	}
</style>
