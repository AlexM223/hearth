/**
 * The ONE unified wallet engine (DECISIONS.md §0 rule 3, §4.2, §4.9):
 * xpub/descriptor import, derivation, PSBT build -> review -> sign ->
 * commitment-check -> broadcast. "kind" is a data column, never a second
 * code path -- especially never a second broadcast path. Server-side only;
 * hardware wallets live in src/lib/hw (browser-side, WebHID/WebSerial) and are
 * never imported here (WALLET-ENGINE §0.3, §5.1).
 *
 * This file is the module's PUBLIC SURFACE -- the only file other modules import.
 */
export type {
	WalletKind,
	SingleScriptType,
	MultisigScriptType,
	ScriptType,
	ChainNetwork,
	DraftStatus,
	CosignerKey,
	Wallet,
	WalletAddress,
	SpendableUtxo,
	Recipient,
	SigningProgress,
	ReviewSummary,
	BuiltDraft,
	TxHistoryEntry,
	DraftRow,
	RedactedDraft
} from './types.js';
