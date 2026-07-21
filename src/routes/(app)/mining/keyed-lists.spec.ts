/**
 * T7 acceptance (MINING-ENGINE.md §6.2): "keyed-list hydration regression
 * test -- worker/leaderboard/trophy rows are keyed by a stable id (miningId+
 * worker / userId / block_hash), unstable keys are the bug it guards." No
 * component-test harness exists in this repo (confirmed during the M4
 * explorer-snapshot bug fix -- no @testing-library/svelte, no browser vitest
 * project configured), so this is a static-source regression test: every
 * `{#each}` block in the mining dashboard template must carry an explicit
 * keying expression `(...)`. An `{#each}` without one re-keys by array
 * index on reorder/filter, which is exactly the class of bug this guards
 * against (a worker/leaderboard/block row silently swapping another row's
 * DOM state -- inputs, open/closed toggles -- across a live SSE-triggered
 * refetch).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');

describe('mining dashboard: every {#each} block is explicitly keyed', () => {
	// Count `{#each` openings vs. `as <ident> (` occurrences rather than trying
	// to regex-match a whole `{#each ... }` tag to its closing brace: some of
	// this template's keys are template-literal expressions
	// (`` `${m.userId}:${m.worker}` ``) whose own `${...}` braces would
	// otherwise confuse a naive "up to the next }" match.
	const eachCount = (source.match(/\{#each\b/g) ?? []).length;
	// "as ident (" (plain) or "as ident, index (" (Svelte's item+index form).
	const keyedAsCount = (source.match(/\bas\s+\w+(?:,\s*\w+)?\s+\(/g) ?? []).length;

	it('the template actually contains {#each} blocks (a vacuous pass would hide a regression)', () => {
		expect(eachCount).toBeGreaterThan(0);
	});

	it('every {#each ... as x} has a following key expression "as x (" -- none fall through unkeyed', () => {
		expect(keyedAsCount).toBe(eachCount);
	});

	it('the worker table keys by worker name, the leaderboard by rank, and blocks by block_hash/height (stable across a refetch, never array index)', () => {
		expect(source).toMatch(/data\.mine\.workers as w \(w\.name\)/);
		expect(source).toMatch(/data\.pool\.leaderboard as l \(l\.rank\)/);
		expect(source).toMatch(/data\.pool\.blocks as b \(b\.blockHash\)/);
		expect(source).toMatch(/data\.mine\.earnings\.blocksFound as b \(b\.height\)/);
		expect(source).toMatch(/data\.admin\.miners as m \(`\$\{m\.userId\}:\$\{m\.worker\}`\)/);
	});
});
