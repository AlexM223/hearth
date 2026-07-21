import { describe, expect, it, vi } from 'vitest';
import { LruCache } from './cache.js';

describe('chain/cache: LruCache', () => {
	it('evicts the least-recently-used entry once over capacity', () => {
		const c = new LruCache<string, number>(2);
		c.set('a', 1);
		c.set('b', 2);
		c.set('c', 3); // evicts 'a' (oldest, never touched)
		expect(c.get('a')).toBeUndefined();
		expect(c.get('b')).toBe(2);
		expect(c.get('c')).toBe(3);
	});

	it('a get() refreshes recency, protecting it from the next eviction', () => {
		const c = new LruCache<string, number>(2);
		c.set('a', 1);
		c.set('b', 2);
		c.get('a'); // 'a' is now more-recently-used than 'b'
		c.set('c', 3); // evicts 'b', not 'a'
		expect(c.get('a')).toBe(1);
		expect(c.get('b')).toBeUndefined();
		expect(c.get('c')).toBe(3);
	});

	it('with ttlMs: null (default), an entry never expires on its own -- only LRU eviction removes it', () => {
		const c = new LruCache<string, number>(10);
		c.set('a', 1);
		vi.useFakeTimers();
		vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365);
		expect(c.get('a')).toBe(1);
		vi.useRealTimers();
	});

	it('with a ttlMs, an entry expires and reads as a miss after the TTL elapses', () => {
		vi.useFakeTimers();
		const c = new LruCache<string, number>(10, 1000);
		c.set('a', 1);
		expect(c.get('a')).toBe(1);
		vi.advanceTimersByTime(1001);
		expect(c.get('a')).toBeUndefined();
		expect(c.has('a')).toBe(false);
		vi.useRealTimers();
	});

	it('delete() and clear() remove entries', () => {
		const c = new LruCache<string, number>(10);
		c.set('a', 1);
		c.set('b', 2);
		c.delete('a');
		expect(c.get('a')).toBeUndefined();
		expect(c.size).toBe(1);
		c.clear();
		expect(c.size).toBe(0);
	});
});
