/**
 * GET /api/health -- the Docker HEALTHCHECK target (DECISIONS.md §5.1) and
 * the M0 acceptance-test endpoint. Kept deliberately dependency-free: no DB
 * open, no node calls -- it must answer even while other subsystems are
 * degraded (per-datum graceful degrade is a chain/ concern, not this route's).
 */
import { json } from '@sveltejs/kit';
import { loadConfig } from '$lib/server/config/index.js';
import pkg from '../../../../package.json';

export function GET() {
	const config = loadConfig();

	return json({
		status: 'ok',
		version: pkg.version,
		mode: config.platform,
		time: new Date().toISOString()
	});
}
