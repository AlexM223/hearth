import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ElectrumClient } from './client.js';

/**
 * A minimal newline-delimited JSON-RPC test server standing in for Fulcrum,
 * so the framing/dispatch logic (line-splitting, buffer accumulation across
 * chunks, malformed-line tolerance, the buffer-size DoS cap) is exercised
 * over a REAL socket rather than mocked net.Socket internals.
 */
function startTestServer(
	onLine: (line: string, socket: net.Socket) => void
): Promise<{ server: net.Server; port: number; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server = net.createServer((socket) => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buffer += chunk;
				let idx: number;
				while ((idx = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (line.trim()) onLine(line, socket);
				}
			});
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as net.AddressInfo).port;
			resolve({
				server,
				port,
				close: () => new Promise<void>((res) => server.close(() => res()))
			});
		});
	});
}

function reply(socket: net.Socket, id: number, result: unknown): void {
	socket.write(JSON.stringify({ jsonrpc: '2.0', id, result, error: null }) + '\n');
}

describe('node/electrum: client wire framing', () => {
	let cleanup: (() => Promise<void>) | null = null;

	afterEach(async () => {
		if (cleanup) {
			await cleanup();
			cleanup = null;
		}
	});

	it('completes the handshake and round-trips a request/response', async () => {
		const { port, close } = await startTestServer((line, socket) => {
			const msg = JSON.parse(line) as { id: number; method: string; params: unknown[] };
			if (msg.method === 'server.version') {
				reply(socket, msg.id, ['TestServer 1.0', '1.4']);
			} else if (msg.method === 'blockchain.headers.subscribe') {
				reply(socket, msg.id, { height: 900_000, hex: 'deadbeef' });
			}
		});
		const client = new ElectrumClient({ host: '127.0.0.1', port, tls: false, timeoutMs: 2000 });
		cleanup = async () => {
			client.close();
			await close();
		};

		const header = await client.headersSubscribe();
		expect(header).toEqual({ height: 900_000, hex: 'deadbeef' });
	});

	it('accumulates a response split across multiple TCP chunks', async () => {
		const { server, port, close } = await startTestServer(() => {});
		// Override: reply to server.version normally, but dribble the SECOND
		// response out one byte at a time to exercise the cross-chunk buffer.
		server.removeAllListeners('connection');
		server.on('connection', (socket) => {
			let buffer = '';
			let handshakeDone = false;
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buffer += chunk;
				let idx: number;
				while ((idx = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { id: number; method: string };
					if (!handshakeDone) {
						handshakeDone = true;
						reply(socket, msg.id, ['TestServer 1.0', '1.4']);
					} else {
						const full = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 12345, error: null }) + '\n';
						let i = 0;
						const trickle = () => {
							if (i >= full.length) return;
							socket.write(full[i]);
							i++;
							setImmediate(trickle);
						};
						trickle();
					}
				}
			});
		});

		const client = new ElectrumClient({ host: '127.0.0.1', port, tls: false, timeoutMs: 2000 });
		cleanup = async () => {
			client.close();
			await close();
		};

		const result = await client.request('blockchain.estimatefee', [6]);
		expect(result).toBe(12345);
	});

	it('ignores a malformed (non-JSON) line without crashing or breaking later requests', async () => {
		const { server, port, close } = await startTestServer(() => {});
		server.removeAllListeners('connection');
		server.on('connection', (socket) => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buffer += chunk;
				let idx: number;
				while ((idx = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (!line.trim()) continue;
					if (line.includes('server.version')) {
						const msg = JSON.parse(line) as { id: number };
						// Send garbage BEFORE the real reply.
						socket.write('not json at all\n');
						reply(socket, msg.id, ['TestServer 1.0', '1.4']);
					} else {
						const msg = JSON.parse(line) as { id: number };
						reply(socket, msg.id, 'still-works');
					}
				}
			});
		});

		const client = new ElectrumClient({ host: '127.0.0.1', port, tls: false, timeoutMs: 2000 });
		cleanup = async () => {
			client.close();
			await close();
		};

		const result = await client.request('server.ping', []);
		expect(result).toBe('still-works');
	});

	it('destroys the connection when the unterminated receive buffer exceeds the cap (DoS guard)', async () => {
		const { server, port, close } = await startTestServer(() => {});
		server.removeAllListeners('connection');
		server.on('connection', (socket) => {
			let buffer = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buffer += chunk;
				let idx: number;
				while ((idx = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { id: number };
					reply(socket, msg.id, ['TestServer 1.0', '1.4']);
					// After the handshake, stream a huge unterminated payload.
					socket.write('x'.repeat(2048));
				}
			});
		});

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port,
			tls: false,
			timeoutMs: 1000,
			maxBufferBytes: 1024 // small cap so the 2048-byte tail trips it
		});
		cleanup = async () => {
			client.close();
			await close();
		};

		let disconnected = false;
		client.on('disconnect', () => {
			disconnected = true;
		});
		// Trigger the handshake (connects lazily).
		await client.ping().catch(() => {});
		await new Promise((r) => setTimeout(r, 200));
		expect(disconnected).toBe(true);
	});

	it('rejects with a timeout error when the server never replies', async () => {
		const { port, close } = await startTestServer((line, socket) => {
			const msg = JSON.parse(line) as { id: number; method: string };
			if (msg.method === 'server.version') reply(socket, msg.id, ['TestServer 1.0', '1.4']);
			// Deliberately never reply to anything else.
		});
		const client = new ElectrumClient({ host: '127.0.0.1', port, tls: false, timeoutMs: 100 });
		cleanup = async () => {
			client.close();
			await close();
		};

		await expect(client.request('blockchain.estimatefee', [6])).rejects.toThrow(/timed out/);
	});
});
