/**
 * db module public surface (DECISIONS.md §4.1). Other modules import from
 * here only -- never reach into `./client.js` or `./migrations.js` directly.
 */
export { openDb, getDb, closeDb, withTransaction } from './client.js';
export { runMigrations, listMigrations, type Migration } from './migrations.js';
export { getMeta, setMeta, deleteMeta } from './meta.js';
