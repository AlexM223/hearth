/**
 * Typed wallet-engine errors (WALLET-ENGINE §5, §6.1). Every hostile-input path
 * must fail with a CAUGHT, typed Error carrying a clean message (non-empty,
 * < 500 chars, no stack frame, no buffer dump) -- never an uncaught crash and
 * never a silent `return false`. Keeping them in one file lets callers and
 * tests import a single surface.
 */

/** Base class so a caller can `instanceof WalletError` to catch the whole family. */
export class WalletError extends Error {
	constructor(message: string) {
		// Defensive: clamp pathological messages so a giant buffer dump can never
		// ride out in an error surfaced to the UI (WALLET-ENGINE §6.1).
		super(message.length > 480 ? message.slice(0, 477) + '...' : message);
		this.name = 'WalletError';
	}
}

/** A PSBT that could not be parsed / has the wrong shape (base64/magic/truncation). */
export class InvalidPsbtError extends WalletError {
	constructor(message = 'not a valid PSBT') {
		super(message);
		this.name = 'InvalidPsbtError';
	}
}

/** Commitment-check failure: signed PSBT inputs/outputs differ from what was reviewed. */
export class CommitmentError extends WalletError {
	constructor(message = 'the signed transaction does not match what you reviewed') {
		super(message);
		this.name = 'CommitmentError';
	}
}

/** combine() of two PSBTs describing different transactions. */
export class DifferentTransactionError extends CommitmentError {
	constructor(message = 'these signatures are for a different transaction') {
		super(message);
		this.name = 'DifferentTransactionError';
	}
}

/** A partialSig whose pubkey is not among the input's expected cosigner keys. */
export class ForeignSignatureError extends WalletError {
	constructor(message = 'a signature came from a key that is not a cosigner of this wallet') {
		super(message);
		this.name = 'ForeignSignatureError';
	}
}

/** A signature not using SIGHASH_ALL (blocks SINGLE/NONE/ANYONECANPAY tricks). */
export class WrongSighashError extends WalletError {
	constructor(message = 'a signature does not use SIGHASH_ALL and was refused') {
		super(message);
		this.name = 'WrongSighashError';
	}
}

/** finalize() attempted on a PSBT that has not reached the required signatures. */
export class NotFullySignedError extends WalletError {
	constructor(message = 'the transaction is not fully signed yet') {
		super(message);
		this.name = 'NotFullySignedError';
	}
}

/** Coin selection could not fund the request. */
export class InsufficientFundsError extends WalletError {
	constructor(message = 'not enough spendable funds to cover this send plus fees') {
		super(message);
		this.name = 'InsufficientFundsError';
	}
}

/** A recipient (or change) address failed validation. */
export class InvalidRecipientError extends WalletError {
	constructor(message = 'that is not a valid bitcoin address for this network') {
		super(message);
		this.name = 'InvalidRecipientError';
	}
}

/** A fee rate outside the accepted band. */
export class InvalidFeeRateError extends WalletError {
	constructor(message = 'that fee rate is not acceptable') {
		super(message);
		this.name = 'InvalidFeeRateError';
	}
}

/** Lost the atomic broadcast claim -- another caller already sent (or is sending). */
export class AlreadyBroadcastError extends WalletError {
	constructor(message = 'this draft is already being broadcast') {
		super(message);
		this.name = 'AlreadyBroadcastError';
	}
}

/** An RBF replacement collided with an existing live replacement of the same tx. */
export class AlreadyReplacedError extends WalletError {
	constructor(message = 'this transaction already has a live replacement') {
		super(message);
		this.name = 'AlreadyReplacedError';
	}
}

/** The caller's role does not permit this action (service-layer gate, §5.3). */
export class ForbiddenError extends WalletError {
	constructor(message = 'you do not have permission to do that') {
		super(message);
		this.name = 'ForbiddenError';
	}
}

/** A wallet / draft was not found (or not visible to this caller). */
export class NotFoundError extends WalletError {
	constructor(message = 'not found') {
		super(message);
		this.name = 'NotFoundError';
	}
}
