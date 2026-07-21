/**
 * No-native-deps guard (DECISIONS.md §2, §5.1). Smart App Control blocks
 * unsigned native `.node` addons on Windows, and a transitive native addon in
 * the SERVER path is the cairn `@trezor/connect-web` -> `usb` lesson. This
 * walks the PRODUCTION dependency closure (devDependencies like rollup /
 * lightningcss legitimately ship platform binaries and run only at build time,
 * never in the runtime image) and fails if any production package ships a
 * compiled `.node` addon or a `binding.gyp`.
 *
 * Exit 0 = clean; exit 1 = a native addon reached the runtime closure.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} dir @returns {any} */
function readPkg(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Resolve a package's install dir, walking up node_modules like Node does.
 * @param {string} name @param {string} fromDir @returns {string | null}
 */
function resolvePkgDir(name, fromDir) {
	let cur = fromDir;
	for (;;) {
		const candidate = join(cur, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json'))) return candidate;
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/**
 * Shallow-ish recursive scan for compiled addons, skipping nested node_modules.
 * @param {string} dir @param {string[]} hits @param {number} [depth]
 */
function findNativeArtifacts(dir, hits, depth = 0) {
	if (depth > 6) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name === 'node_modules') continue; // handled by closure walk
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			findNativeArtifacts(full, hits, depth + 1);
		} else if (e.name.endsWith('.node') || e.name === 'binding.gyp') {
			hits.push(full);
		}
	}
}

const rootPkg = readPkg(root);
const prodDeps = Object.keys(rootPkg.dependencies ?? {});

/** @type {Set<string>} */
const visited = new Set();
/** @type {string[]} */
const queue = [...prodDeps];
/** @type {{ name: string; hits: string[] }[]} */
const nativeHits = [];

while (queue.length) {
	const name = /** @type {string} */ (queue.shift());
	if (visited.has(name)) continue;
	visited.add(name);
	const dir = resolvePkgDir(name, root);
	if (!dir) continue;
	const pkg = readPkg(dir);
	if (!pkg) continue;
	/** @type {string[]} */
	const hits = [];
	findNativeArtifacts(dir, hits);
	if (hits.length) nativeHits.push({ name, hits });
	for (const dep of Object.keys(pkg.dependencies ?? {})) {
		if (!visited.has(dep)) queue.push(dep);
	}
	// optionalDependencies are commonly the platform-binary trick (rollup) --
	// include them so we catch a native optional dep pulled into production.
	for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
		if (!visited.has(dep)) queue.push(dep);
	}
}

export function scanProductionClosure() {
	return { packagesScanned: visited.size, nativeHits };
}

// When run directly (npm script / CI), print + set exit code.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-no-native-deps.mjs')) {
	const { packagesScanned, nativeHits: hits } = scanProductionClosure();
	if (hits.length) {
		console.error(`NATIVE ADDON in production closure (${packagesScanned} pkgs scanned):`);
		for (const { name, hits: fs } of hits) console.error(`  ${name}: ${fs.join(', ')}`);
		process.exit(1);
	}
	console.log(`no-native-deps guard: clean (${packagesScanned} production packages scanned)`);
}
