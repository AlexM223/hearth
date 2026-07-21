/**
 * T9 acceptance (COME-ABOARD.md §3.5, §7.4, §8): calls the REAL GET handler
 * (not just the bus, which events/index.spec.ts already proves generically)
 * so the connection-identity wiring itself is pinned -- an Owner session
 * registers isAdmin=true, a Member/Guest session registers isAdmin=false,
 * and each connection's userId is exactly its session's id. This is the
 * "the gate existed but the route never called it" class of risk, applied
 * to SSE registration instead of a PSBT route.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { publish, connectionCount } from '$lib/server/events/index.js';
import { GET } from './+server.js';

interface Conn {
	res: Response;
	reader: ReadableStreamDefaultReader<Uint8Array>;
	controller: AbortController;
	close: () => Promise<void>;
}

const decoder = new TextDecoder();
const openConns: Conn[] = [];

async function connect(role: 'owner' | 'member' | 'guest' | null, userId = 1): Promise<Conn | Response> {
	const controller = new AbortController();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const event: any = {
		locals: { user: role == null ? null : { id: userId, username: 'u' + userId, role, mustResetPassword: false } },
		request: { signal: controller.signal }
	};
	const res = await GET(event);
	if (res.status !== 200) return res;
	const reader = res.body!.getReader();
	const conn: Conn = {
		res,
		reader,
		controller,
		close: async () => {
			controller.abort();
			await reader.cancel().catch(() => {});
		}
	};
	openConns.push(conn);
	return conn;
}

async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const { value } = await reader.read();
	return decoder.decode(value);
}

afterEach(async () => {
	while (openConns.length) {
		const c = openConns.pop()!;
		await c.close();
	}
});

describe('T9: GET /api/events -- identity + scope wiring', () => {
	it('an anonymous caller is rejected (401), never registered', async () => {
		const res = (await connect(null)) as Response;
		expect(res.status).toBe(401);
		expect(connectionCount()).toBe(0);
	});

	it('an Owner session registers isAdmin=true -- receives an {admin}-scoped frame', async () => {
		const conn = (await connect('owner', 101)) as Conn;
		publish('mining:pool', { kind: 'admin' }, { note: 'owner-only-frame' });
		const frame = await nextFrame(conn.reader);
		expect(frame).toContain('owner-only-frame');
	});

	it('a Member session registers isAdmin=false -- never receives an {admin}-scoped frame', async () => {
		const owner = (await connect('owner', 201)) as Conn;
		const member = (await connect('member', 202)) as Conn;

		publish('mining:pool', { kind: 'admin' }, { note: 'admin-frame' });
		const ownerFrame = await nextFrame(owner.reader);
		expect(ownerFrame).toContain('admin-frame');

		// Prove the Member connection did NOT receive it by publishing a second,
		// broadcast frame afterward and checking THAT is the Member's first frame.
		publish('health', { kind: 'broadcast' }, { note: 'broadcast-frame' });
		const memberFrame = await nextFrame(member.reader);
		expect(memberFrame).toContain('broadcast-frame');
		expect(memberFrame).not.toContain('admin-frame');
	});

	it('a Guest session registers isAdmin=false -- same as Member for admin-scoped frames', async () => {
		const guest = (await connect('guest', 301)) as Conn;
		publish('health', { kind: 'broadcast' }, { note: 'guest-sees-broadcast' });
		const frame = await nextFrame(guest.reader);
		expect(frame).toContain('guest-sees-broadcast');
	});

	it("a connection's userId is exactly its session's id -- a user-scoped frame for a DIFFERENT id never arrives first", async () => {
		const memberA = (await connect('member', 401)) as Conn;
		const memberB = (await connect('member', 402)) as Conn;

		publish('wallet', { kind: 'user', userId: 402 }, { note: 'for-402-only' });
		publish('health', { kind: 'broadcast' }, { note: 'broadcast-for-everyone' });

		const aFrame = await nextFrame(memberA.reader); // A owns no scope match on the first publish
		expect(aFrame).toContain('broadcast-for-everyone');
		expect(aFrame).not.toContain('for-402-only');

		const bFrame = await nextFrame(memberB.reader); // B gets the user-scoped one first
		expect(bFrame).toContain('for-402-only');
	});
});
