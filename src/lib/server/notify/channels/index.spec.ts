/**
 * T6 acceptance: the channel registry is exactly the five external channels,
 * each satisfying NotificationChannelPlugin, and is directly assignable to
 * the outbox worker's OutboxDeps.channels (the wiring T8 will use).
 */
import { describe, expect, it } from 'vitest';
import { CHANNELS } from './index.js';
import { EXTERNAL_NOTIFICATION_CHANNELS } from '../types.js';
import type { OutboxDeps } from '../queue/outbox.js';

describe('T6: the channel registry', () => {
	it('has exactly the five external channels, matching EXTERNAL_NOTIFICATION_CHANNELS', () => {
		expect(Object.keys(CHANNELS).sort()).toEqual([...EXTERNAL_NOTIFICATION_CHANNELS].sort());
	});

	it('every plugin has a matching id, a label, and the three required functions', () => {
		for (const [key, plugin] of Object.entries(CHANNELS)) {
			expect(plugin.id).toBe(key);
			expect(typeof plugin.label).toBe('string');
			expect(typeof plugin.send).toBe('function');
			expect(typeof plugin.test).toBe('function');
			expect(typeof plugin.isConfigured).toBe('function');
		}
	});

	it('is directly usable as OutboxDeps.channels (T8 wiring compiles)', () => {
		const deps: OutboxDeps = { channels: CHANNELS };
		expect(deps.channels.webhook).toBe(CHANNELS.webhook);
	});
});
