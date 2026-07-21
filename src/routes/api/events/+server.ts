/**
 * GET /api/events -- the single multiplexed SSE stream (DECISIONS.md §4.5).
 * One EventSource per browser tab; topics are multiplexed over it (`block`
 * now, `wallet`/`notification`/`mining`/`mining:pool` in later milestones).
 * hooks.server.ts's session guard already requires a session for every
 * non-public route, so `locals.user` is always set here.
 */
import { register } from '$lib/server/events/index.js';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();

export const GET: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) {
		return new Response('Unauthorized', { status: 401 });
	}

	let closed = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let unregister: (() => void) | null = null;

	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeat !== null) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (unregister !== null) {
			unregister();
			unregister = null;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (text: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					cleanup();
				}
			};

			unregister = register({
				userId: user.id,
				isAdmin: user.role === 'owner',
				send
			});

			// 25s heartbeat (DECISIONS.md §4.5) -- keeps proxies (incl. Umbrel's
			// app_proxy) from idling the connection out.
			heartbeat = setInterval(() => {
				send(`: ping\n\n`);
			}, HEARTBEAT_MS);
			heartbeat.unref?.();
		},
		cancel() {
			cleanup();
		}
	});

	request.signal.addEventListener('abort', cleanup, { once: true });

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
