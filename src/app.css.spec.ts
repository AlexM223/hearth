/**
 * The fee-ramp squint test (EXPLORER.md §3.2, §7 T7), made falsifiable and
 * automated rather than eyeballed only: no --fee-N token may fall in the
 * banned Bitcoin-orange hue band (H 20-45deg, the same guardrail
 * DECISIONS.md §3 already enforces for --accent), and --fee-5 must read as
 * a distinguishably different hue from --error in both themes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8');

const BANNED_HUE_MIN = 20;
const BANNED_HUE_MAX = 45;
const MIN_HUE_DISTANCE_FROM_ERROR = 15; // degrees -- must read as a different color at a glance

function hexToHue(hex: string): number {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	if (delta === 0) return 0;
	let hue: number;
	if (max === r) hue = ((g - b) / delta) % 6;
	else if (max === g) hue = (b - r) / delta + 2;
	else hue = (r - g) / delta + 4;
	hue *= 60;
	return hue < 0 ? hue + 360 : hue;
}

function hueDistance(a: number, b: number): number {
	const diff = Math.abs(a - b) % 360;
	return diff > 180 ? 360 - diff : diff;
}

/** Extracts `--token: #hex;` from a specific block of app.css (identified by
 *  its opening selector line), so dark vs light values are pulled from the
 *  RIGHT block rather than the first match anywhere in the file. */
function extractBlock(selectorStart: string): string {
	const startIdx = APP_CSS.indexOf(selectorStart);
	if (startIdx === -1) throw new Error(`selector not found: ${selectorStart}`);
	const openBrace = APP_CSS.indexOf('{', startIdx);
	const closeBrace = APP_CSS.indexOf('}', openBrace);
	return APP_CSS.slice(openBrace, closeBrace);
}

function tokenValue(block: string, token: string): string {
	const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
	if (!match) throw new Error(`token ${token} not found in block`);
	return match[1];
}

const darkBlock = extractBlock(':root {');
const lightBlock = extractBlock(":root[data-theme='light'] {");

describe('app.css: the fee-ramp squint test (falsifiable, EXPLORER.md §3.2)', () => {
	for (const [themeName, block] of [
		['dark', darkBlock],
		['light', lightBlock]
	] as const) {
		it(`${themeName} theme: no --fee-N token falls in the banned Bitcoin-orange hue band (20-45deg)`, () => {
			for (let n = 1; n <= 5; n++) {
				const hex = tokenValue(block, `--fee-${n}`);
				const hue = hexToHue(hex);
				const inBannedBand = hue >= BANNED_HUE_MIN && hue <= BANNED_HUE_MAX;
				expect(inBannedBand, `--fee-${n} (${hex}) has hue ${hue.toFixed(1)}deg, in the banned band`).toBe(
					false
				);
			}
		});

		it(`${themeName} theme: --fee-5 reads as a distinguishably different hue from --error`, () => {
			const fee5Hue = hexToHue(tokenValue(block, '--fee-5'));
			const errorHue = hexToHue(tokenValue(block, '--error'));
			const distance = hueDistance(fee5Hue, errorHue);
			expect(
				distance,
				`--fee-5 hue ${fee5Hue.toFixed(1)}deg vs --error hue ${errorHue.toFixed(1)}deg`
			).toBeGreaterThanOrEqual(MIN_HUE_DISTANCE_FROM_ERROR);
		});

		it(`${themeName} theme: the ramp runs cool(economy)->warm(priority) -- fee-1's hue is cooler (bluer) than fee-5's`, () => {
			const fee1Hue = hexToHue(tokenValue(block, '--fee-1'));
			const fee5Hue = hexToHue(tokenValue(block, '--fee-5'));
			// Cooler = closer to blue/cyan (~180-240deg); warmer = closer to
			// red/pink (~330-360 or 0-20deg). Assert fee-1 sits further from the
			// red end of the hue wheel than fee-5 does.
			const rednessOf = (h: number) => Math.min(hueDistance(h, 0), hueDistance(h, 360));
			expect(rednessOf(fee1Hue)).toBeGreaterThan(rednessOf(fee5Hue));
		});
	}

	it('every --fee-N token is a valid 6-digit hex color (both themes)', () => {
		for (const block of [darkBlock, lightBlock]) {
			for (let n = 1; n <= 5; n++) {
				expect(() => tokenValue(block, `--fee-${n}`)).not.toThrow();
			}
		}
	});
});
