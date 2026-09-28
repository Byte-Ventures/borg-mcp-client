/**
 * Test helpers for the representative state database and 5.x inputs.
 * Everything resolves under the isolated HOME/BORG_STATE_ROOT the test set.
 */
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readCurrent, representativeStateRoot } from '../../src/representative-db.js';
import { bindingFingerprint, type RepresentativeBinding } from '../../src/representative-store.js';

export const configRoot = (root: string) => join(root, '.config', 'borgmcp');

/** Run `body` on a direct handle to the CURRENT generation's database, then close it. */
export function withStateDb<T>(body: (db: DatabaseSync) => T): T {
  const stateRoot = representativeStateRoot();
  const gen = readCurrent(stateRoot);
  if (gen === null) throw new Error('no representative state generation is published');
  const db = new DatabaseSync(join(stateRoot, gen, 'state.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    return body(db);
  } finally {
    db.close();
  }
}

export function stateInitialized(): boolean {
  return readCurrent(representativeStateRoot()) !== null;
}

export function deliveryRow(binding: RepresentativeBinding): Record<string, unknown> | undefined {
  return withStateDb((db) => db.prepare('SELECT * FROM delivery WHERE generation = ?').get(bindingFingerprint(binding)) as
    Record<string, unknown> | undefined);
}

export function returnedRows(binding: RepresentativeBinding): Array<{ entry_id: string; created_at: string }> {
  return withStateDb((db) => db.prepare('SELECT entry_id, created_at FROM returned WHERE generation = ? ORDER BY created_at, entry_id')
    .all(bindingFingerprint(binding)) as Array<{ entry_id: string; created_at: string }>);
}

export function seatHash(binding: RepresentativeBinding): string {
  return createHash('sha256').update(JSON.stringify([
    binding.origin, binding.trustIdentity, binding.cubeId, binding.representativeDroneId,
  ])).digest('hex');
}

/** mkdir -p with 0700 on every directory from `<root>/.config` down. */
export function privateTree(root: string, directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let current = directory; current.startsWith(join(root, '.config')); current = join(current, '..')) chmodSync(current, 0o700);
}

/** Plant a 5.x binding file holding `bindings`. */
export function plantLegacyBindings(root: string, bindings: RepresentativeBinding[]): string {
  privateTree(root, configRoot(root));
  const file = join(configRoot(root), 'representative.json');
  writeFileSync(file, JSON.stringify({ version: 1, bindings: Object.fromEntries(bindings.map((b) => [b.worktree, b])) }), { mode: 0o600 });
  return file;
}

export const legacyDeliveryRoot = (root: string) => join(configRoot(root), 'representative-delivery');

/** Plant a 5.x checkpoint.json for `generation` (default: the binding's own). */
export function plantLegacyCheckpoint(
  root: string,
  binding: RepresentativeBinding,
  content: unknown,
  generation = bindingFingerprint(binding),
): string {
  const directory = join(legacyDeliveryRoot(root), generation);
  privateTree(root, directory);
  const file = join(directory, 'checkpoint.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  return file;
}

/** Plant the 5.x seat tombstone directory `seat-<seat>`. */
export function plantLegacyTombstone(root: string, binding: RepresentativeBinding): string {
  const directory = join(legacyDeliveryRoot(root), `seat-${seatHash(binding)}`);
  privateTree(root, directory);
  writeFileSync(join(directory, 'migration.json'), JSON.stringify({ version: 1, seat: seatHash(binding), cursor: null, complete: true }), { mode: 0o600 });
  return directory;
}

/** Corrupt one table's root page header of a generation (still openable; quick_check fails). */
export function corruptTable(gen: string, table = 'requests'): void {
  const path = join(representativeStateRoot(), gen, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const { rootpage } = db.prepare('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(table) as { rootpage: number };
  const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  db.close();
  const fd = openSync(path, 'r+');
  try { writeSync(fd, Buffer.alloc(8, 0xff), 0, 8, (rootpage - 1) * pageSize); } finally { closeSync(fd); }
}

/** Replace a generation's database with non-database bytes (mode kept). */
export function notADatabase(gen: string): void {
  writeFileSync(join(representativeStateRoot(), gen, 'state.sqlite'), Buffer.alloc(8192, 0x5a));
}
