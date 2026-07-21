/**
 * Full paginated block list ("see all", EXPLORER.md §4.1). `?before=` walks
 * further back; calls chain/index.ts read models directly (no self-HTTP
 * round trip, matching the wallet module's own convention).
 */
import { listBlocksBefore, listRecentBlocks } from '$lib/server/chain/index.js';
import { getNodeClient } from '$lib/server/node/index.js';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 25;

export const load: PageServerLoad = async ({ locals, url }) => {
	const node = getNodeClient();
	const viewerUserId = locals.user?.id ?? null;
	const before = url.searchParams.get('before');

	const blocks = before
		? await listBlocksBefore(node, Number(before), PAGE_SIZE, viewerUserId)
		: await listRecentBlocks(node, PAGE_SIZE, viewerUserId);

	const nextBefore = blocks.length > 0 ? blocks[blocks.length - 1].height : null;

	return { blocks, nextBefore };
};
