/**
 * Regression test for hearth-4yh (UX sweep finding #5, Medium): the Receive
 * tab had no QR code (`canvas`/`svg[class*=qr]`/`img[alt*=qr]` all absent)
 * and no copy button -- just the address as plain selectable text. Source-
 * level assertion (no component-test harness -- see mining/keyed-lists.spec.ts)
 * that a QR image and a copy button now exist, and that `qrcode` (already a
 * devDependency from the BC-UR signing work, SIGNING.md §1.7) is reached via
 * the same lazy dynamic import SignWithQr.svelte uses -- never a static
 * top-level import, which would pull it into every SSR render path.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');

describe('wallet Receive tab has a QR code and a copy button (hearth-4yh)', () => {
	it('renders a QR <img> built from the receive address', () => {
		expect(source).toMatch(/<img class="qr" src=\{receiveQrUrl\}/);
	});

	it('reaches `qrcode` via a lazy dynamic import, never a static top-level import', () => {
		expect(source).toMatch(/await import\('qrcode'\)/);
		expect(source).not.toMatch(/^import .* from 'qrcode'/m);
	});

	it('encodes a bitcoin: URI (scannable by another wallet), not just the bare address', () => {
		expect(source).toMatch(/`bitcoin:\$\{address\}`/);
	});

	it('has a copy-to-clipboard button', () => {
		expect(source).toContain('copyReceiveAddress');
		expect(source).toContain('navigator.clipboard.writeText(receiveAddress)');
	});

	it('a QR build failure degrades to no QR, never a crash (the address text still works)', () => {
		expect(source).toMatch(/catch\s*\{\s*\n\s*receiveQrUrl = null;/);
	});
});
