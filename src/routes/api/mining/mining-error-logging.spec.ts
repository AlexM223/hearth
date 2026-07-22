/**
 * Audit P2#9 (hearth-9bh): mining/config and mining/me used to swallow the
 * underlying error entirely (`catch { throw error(503, ...) }`) -- a real
 * engine bug there was undiagnosable in production since nothing was ever
 * logged. Both routes now call logError('mining', ...) before the 503; this
 * pins that behavior with a mocked read-model failure.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const logErrorMock = vi.fn();
vi.mock('$lib/server/log.js', () => ({
	log: vi.fn(),
	logWarn: vi.fn(),
	logError: logErrorMock
}));

vi.mock('$lib/server/mining/readModels.js', () => ({
	getAdminMiningView: vi.fn(async () => {
		throw new Error('engine exploded');
	}),
	getUserMiningView: vi.fn(async () => {
		throw new Error('engine exploded');
	})
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evt(role: 'owner' | 'member' | null): any {
	return {
		locals: { user: role == null ? null : { id: 7, username: role, role, mustResetPassword: false } }
	};
}

async function expectStatus(fn: () => unknown, status: number): Promise<void> {
	try {
		await fn();
		throw new Error('expected a thrown HttpError but got a value');
	} catch (e) {
		expect((e as { status?: number }).status).toBe(status);
	}
}

beforeEach(() => {
	logErrorMock.mockClear();
});

describe('P2#9: mining/config and mining/me log before the 503', () => {
	it('GET /api/mining/config logs a mining-tagged error, then throws 503', async () => {
		const { GET } = await import('./config/+server.js');
		await expectStatus(() => GET(evt('owner') as never), 503);
		expect(logErrorMock).toHaveBeenCalledTimes(1);
		const [tag, fields] = logErrorMock.mock.calls[0];
		expect(tag).toBe('mining');
		expect(String((fields as { err?: string }).err)).toMatch(/engine exploded/);
	});

	it('GET /api/mining/me logs a mining-tagged error (with the caller userId), then throws 503', async () => {
		const { GET } = await import('./me/+server.js');
		await expectStatus(() => GET(evt('member') as never), 503);
		expect(logErrorMock).toHaveBeenCalledTimes(1);
		const [tag, fields] = logErrorMock.mock.calls[0];
		expect(tag).toBe('mining');
		expect((fields as { userId?: number }).userId).toBe(7);
		expect(String((fields as { err?: string }).err)).toMatch(/engine exploded/);
	});
});
