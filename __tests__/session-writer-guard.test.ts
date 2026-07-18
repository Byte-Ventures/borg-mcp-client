/**
 * SR#5 behavioral guard for the COLLAPSED single-store seat model (seats.ts).
 *
 * The `borg-server-session:` seat group is security-critical: in the collapsed
 * model every seat WRITE (mint / activate+bind / reset / scrub / clear / refresh)
 * and the SOLE raw-bearer read flow through the seats.ts single-store API, the
 * session-credential SEND lives only in server-handshake.ts, and the raw bearer
 * never leaves the store owner (digest-only everywhere else, never logged). This
 * test enumerates those facts deterministically from source so a future writer
 * that bypasses the store, sends a bearer elsewhere, or leaks/logs one fails CI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'src');
const read = (rel: string) => readFileSync(join(srcDir, rel), 'utf8');
const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

/** src files that reference a name (excluding an optional allowlist). */
function filesReferencing(needle: string, allow: string[] = []): string[] {
  return srcFiles.filter((f) => !allow.includes(f) && read(f).includes(needle));
}

describe('seat single-store writer guard (SR#5)', () => {
  it('the seat store file (SEATS_FILE) is reached ONLY from seats.ts', () => {
    // SEATS_FILE (the 0600 seats.json) is the single home of the seat map; only
    // seats.ts may name it, so no module writes/reads the store off-API.
    expect(filesReferencing('SEATS_FILE', ['seats.ts'])).toEqual([]);
  });

  it('the low-level store primitives (withStore/atomicWrite0600) are reached ONLY by seats.ts + config.ts', () => {
    // seat-store.ts is the shared 0600 flock primitive; only seats.ts (seat map)
    // and config.ts (enrollment/credential group) drive it. No command/handshake
    // module opens the store directly.
    expect(filesReferencing('withStore<', ['seat-store.ts', 'seats.ts'])).toEqual([]);
    expect(filesReferencing('atomicWrite0600', ['seat-store.ts', 'token-store.ts'])).toEqual([]);
  });

  it('every seat WRITE + the pending→ACTIVE+bind transition is DEFINED in seats.ts', () => {
    const seats = read('seats.ts');
    for (const fn of [
      'export async function mintPendingSeat',
      'export async function prepareSeat',
      'export async function activateAndBindSeat',
      'export async function resetSeatForWorktree',
      'export async function scrubPendingSeat',
      'export async function clearSeat',
      'export async function refreshSeatMetadata',
    ]) {
      expect(seats).toContain(fn);
    }
  });

  it('the pending→ACTIVE+bind op (activateAndBindSeat) is invoked ONLY by the attach FINALIZE (server-handshake.ts)', () => {
    // seats.ts defines it; the sole caller is the FINALIZE activate thunk. No
    // command mints/activates a seat off the single-store API.
    expect(filesReferencing('activateAndBindSeat', ['seats.ts', 'server-handshake.ts'])).toEqual([]);
  });

  it('the session-credential SEND (attach `session_credential`) lives ONLY in server-handshake.ts', () => {
    // The only place a seat bearer is put on the wire is the attach POST body.
    expect(filesReferencing('session_credential', ['server-handshake.ts'])).toEqual([]);
  });

  it('the SOLE raw-bearer reader (getActiveSeatCredential) is resolved ONLY in seats.ts + cubes.ts', () => {
    // getActiveSeatCredential is the ONLY function that returns a raw seat bearer;
    // it is called only by the cubes.ts hydration adapter and defined in seats.ts.
    // No command, remote-client, or handshake path resolves a bearer directly.
    expect(filesReferencing('getActiveSeatCredential', ['seats.ts', 'cubes.ts'])).toEqual([]);
  });

  it('the cubes.ts hydration adapter never reaches a raw store backend', () => {
    const cubes = read('cubes.ts');
    // cubes.ts is a thin adapter over the seats.ts API — never the store itself.
    expect(cubes).not.toContain('getServerCredentialBackend');
    expect(cubes).not.toContain('readStoreFile');
    expect(cubes).not.toContain('withStore');
    expect(cubes).not.toContain('SEATS_FILE');
  });

  it('the credential-store backend (enrollment/credential group) is reached ONLY from config.ts', () => {
    expect(filesReferencing('getServerCredentialBackend', ['config.ts'])).toEqual([]);
    for (const call of ['backend.set(', 'backend.delete(', 'backend.get(']) {
      expect(filesReferencing(call, ['config.ts'])).toEqual([]);
    }
  });

  it('the retired two-store composite + the cubes.json seat map are GONE from the tree', () => {
    // The cross-store PREPARE/FINALIZE composite and the cubes.json seat map were
    // collapsed into seats.ts; none of their symbols survive anywhere.
    expect(filesReferencing('prepareServerSeatAttachment')).toEqual([]);
    expect(filesReferencing('finalizeServerSeatAttachment')).toEqual([]);
    expect(filesReferencing('__setCubesWriteFailureForTest')).toEqual([]);
    // The cubes.json seat-map read/write is gone from cubes.ts.
    const cubes = read('cubes.ts');
    expect(cubes).not.toContain('readCubesFile');
    expect(cubes).not.toContain('writeCubesFile');
    // The retired config-layer session accessors are gone everywhere.
    for (const sym of [
      'getActiveServerSessionCredential',
      'compareAndActivatePendingServerSession',
      'observeServerSessionRecord',
      'compareAndClearSessionRecord',
      'getOrCreatePendingServerSession',
    ]) {
      expect(filesReferencing(sym)).toEqual([]);
    }
  });

  it('the raw seat bearer is never logged (no console sink of a credential field)', () => {
    for (const f of ['seats.ts', 'cubes.ts', 'server-handshake.ts', 'assimilate-deps.ts']) {
      expect(read(f)).not.toMatch(/console\.[a-z]+\([^)]*\bcredential\b/);
    }
  });
});
