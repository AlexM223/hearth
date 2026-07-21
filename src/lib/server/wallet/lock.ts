/**
 * A minimal per-key async mutex (WALLET-ENGINE §2.5, §5.4). buildPsbt serializes
 * per userId so the reserve -> select -> persist window is atomic across the
 * Electrum await (node:sqlite itself is synchronous, so a read->write with no
 * await between is atomic by construction; this lock closes the await gap).
 */
const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = chains.get(key) ?? Promise.resolve();
	const run = prev.then(fn, fn);
	// Keep the chain alive but swallow settlement so one rejection can't poison
	// the next waiter.
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	chains.set(key, tail);
	// Best-effort cleanup so the map doesn't grow unbounded for idle keys.
	void tail.then(() => {
		if (chains.get(key) === tail) chains.delete(key);
	});
	return run;
}
