/**
 * Address view + pagination (EXPLORER.md §1.6). Pure scripthash lookup --
 * NO wallet import, ever -- reusing the same `node/electrum/scripthash.js`
 * decoding the wallet module already uses, so address decoding logic is
 * never duplicated between modules. `isDecodableAddress` lands first (T1
 * needs it for `chain/search.ts`'s address branch); `getAddressView` /
 * `getAddressTxPage` land in T4.
 */
import { addressToScriptHash, addressToScriptPubKey } from '../node/index.js';

/** ECC-free decode probe -- true iff `addressToScriptPubKey` can build a
 *  scriptPubKey from `v` without throwing. No new decoding logic (§1.7). */
export function isDecodableAddress(v: string): boolean {
	try {
		addressToScriptPubKey(v);
		return true;
	} catch {
		return false;
	}
}

export { addressToScriptHash };
