/**
 * Minimal structured JSON logging, matching the shape already used by
 * server.mjs / hooks.server.ts ({ t, tag, ...fields }). Not a module boundary
 * of its own (DECISIONS.md §4.1 lists db/events/node/auth/wallet/chain/notify/
 * mining/federation) -- a tiny cross-cutting leaf every module may import.
 */
export function log(tag: string, fields: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ t: new Date().toISOString(), tag, ...fields }));
}

export function logWarn(tag: string, fields: Record<string, unknown> = {}): void {
	console.warn(JSON.stringify({ t: new Date().toISOString(), tag, ...fields }));
}

export function logError(tag: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ t: new Date().toISOString(), tag, ...fields }));
}
