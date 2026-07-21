/**
 * The channel registry (WATCHTOWER.md §2.1) -- the SINGLE place a channel is
 * added. Each plugin reads its own config internally; callers never pass
 * credentials in.
 */
import { email } from './email.js';
import { telegram } from './telegram.js';
import { ntfy } from './ntfy.js';
import { nostr } from './nostr.js';
import { webhook } from './webhook.js';
import type { NotificationChannelPlugin } from '../types.js';

export const CHANNELS = { email, telegram, ntfy, nostr, webhook } as const satisfies Record<
	string,
	NotificationChannelPlugin
>;

export { email, telegram, ntfy, nostr, webhook };
export { SsrfRejectedError, checkUrl, checkRelayUrl, safeFetch } from './ssrf.js';
