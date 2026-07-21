/**
 * Per-user × event-type × channel routing (WATCHTOWER.md §2.7). Default
 * routing: every event type defaults to `inapp` only -- external channels
 * are opt-in. The resolver merges a user's saved rows over the default (a
 * saved `enabled` 0/1 always wins; a channel with no row falls back to the
 * default set) and only enqueues a target when the channel plugin reports
 * `isConfigured(userId) === true` (a toggle a user flipped on but never
 * finished configuring never silently queues a doomed send).
 */
import { getDb } from '../../db/index.js';
import { CHANNELS } from '../channels/index.js';
import { EXTERNAL_NOTIFICATION_CHANNELS, type NotificationChannelId, type NotificationEventType } from '../types.js';
import type { ExternalTarget } from '../dispatch.js';

/** External channels default to OFF (opt-in); `inapp` is always-on and never
 *  routed through here (dispatch.ts writes it unconditionally). */
const DEFAULT_ENABLED_EXTERNAL = false;

function savedPrefs(userId: number, eventType: string): Map<string, boolean> {
	const rows = getDb()
		.prepare('SELECT channel, enabled FROM notification_preferences WHERE user_id = ? AND event_type = ?')
		.all(userId, eventType) as { channel: string; enabled: number }[];
	return new Map(rows.map((r) => [r.channel, r.enabled === 1]));
}

/** The real resolveTargets implementation for dispatch()/dispatchInTransaction. */
export function resolveExternalTargets(userId: number, eventType: NotificationEventType): ExternalTarget[] {
	const saved = savedPrefs(userId, eventType);
	const targets: ExternalTarget[] = [];
	for (const channel of EXTERNAL_NOTIFICATION_CHANNELS) {
		const enabled = saved.has(channel) ? (saved.get(channel) as boolean) : DEFAULT_ENABLED_EXTERNAL;
		if (!enabled) continue;
		if (!CHANNELS[channel].isConfigured(userId)) continue;
		targets.push({ channel });
	}
	return targets;
}

export interface PreferenceConfig {
	thresholdSats?: number;
	confirmations?: number[];
}

export function getPreference(
	userId: number,
	eventType: NotificationEventType,
	channel: NotificationChannelId
): { enabled: boolean; config: PreferenceConfig | null } {
	const row = getDb()
		.prepare(
			'SELECT enabled, config FROM notification_preferences WHERE user_id = ? AND event_type = ? AND channel = ?'
		)
		.get(userId, eventType, channel) as { enabled: number; config: string | null } | undefined;
	if (!row) {
		return { enabled: channel === 'inapp' ? true : DEFAULT_ENABLED_EXTERNAL, config: null };
	}
	let config: PreferenceConfig | null = null;
	if (row.config) {
		try {
			config = JSON.parse(row.config);
		} catch {
			config = null;
		}
	}
	return { enabled: row.enabled === 1, config };
}

export function setPreference(
	userId: number,
	eventType: NotificationEventType,
	channel: NotificationChannelId,
	enabled: boolean,
	config?: PreferenceConfig
): void {
	getDb()
		.prepare(
			`INSERT INTO notification_preferences (user_id, event_type, channel, enabled, config) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, event_type, channel) DO UPDATE SET enabled = excluded.enabled, config = excluded.config`
		)
		.run(userId, eventType, channel, enabled ? 1 : 0, config ? JSON.stringify(config) : null);
}

export const DEFAULT_MILESTONES: readonly number[] = [1];

/** The confirmation-milestone list a user has opted into (WATCHTOWER.md
 *  §1.6, AVAILABLE_MILESTONES=[1,3,6]) -- read from ANY of the user's
 *  tx_confirmed preference rows that carry a `confirmations` config (channel
 *  choice doesn't matter for this read; the milestone list is per-user, not
 *  per-channel). Falls back to DEFAULT_MILESTONES ([1] only). */
export function getMilestonesForUser(userId: number): readonly number[] {
	const rows = getDb()
		.prepare(`SELECT config FROM notification_preferences WHERE user_id = ? AND event_type = 'tx_confirmed'`)
		.all(userId) as { config: string | null }[];
	for (const row of rows) {
		if (!row.config) continue;
		try {
			const parsed = JSON.parse(row.config) as PreferenceConfig;
			if (Array.isArray(parsed.confirmations) && parsed.confirmations.length > 0) {
				return parsed.confirmations;
			}
		} catch {
			// ignore malformed config, try the next row
		}
	}
	return DEFAULT_MILESTONES;
}

/** The tx_large sats threshold a user configured, if any (WATCHTOWER.md §1.4). */
export function getLargeThresholdSats(userId: number): number | null {
	const rows = getDb()
		.prepare(`SELECT config FROM notification_preferences WHERE user_id = ? AND event_type = 'tx_large'`)
		.all(userId) as { config: string | null }[];
	for (const row of rows) {
		if (!row.config) continue;
		try {
			const parsed = JSON.parse(row.config) as PreferenceConfig;
			if (typeof parsed.thresholdSats === 'number' && parsed.thresholdSats > 0) return parsed.thresholdSats;
		} catch {
			// ignore malformed config, try the next row
		}
	}
	return null;
}
