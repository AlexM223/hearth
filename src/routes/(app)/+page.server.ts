import { describeNodeHealth, getNodeClient } from '$lib/server/node/index.js';
import { listRecentEvents } from '$lib/server/notify/index.js';
import type { PageServerLoad } from './$types';

/** Home = the hearth (DECISIONS.md §4.2): live tip height, plain-language
 *  node health, and the watchtower-feed skeleton. */
export const load: PageServerLoad = async () => {
	const node = getNodeClient();
	const health = await node.health();
	return {
		health,
		healthText: describeNodeHealth(health),
		feed: listRecentEvents(20)
	};
};
