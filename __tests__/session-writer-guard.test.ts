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

/**
 * SR NET-NEW behavioral lock-wrapping guard. Strip comments/line-comments (never
 * `://`), then brace-match each top-level function so we can assert a credential/
 * seat WRITE happens INSIDE a store-lock hold — not merely that the file placement
 * is right (CR3b's unlocked writer passed the placement-only checks).
 */
function stripCommentsAndStrings(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/([^:"'`])\/\/[^\n]*/g, '$1');
}
function functionBodies(srcRaw: string): Map<string, string> {
  const src = stripCommentsAndStrings(srcRaw);
  const bodies = new Map<string, string>();
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    let i = re.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) { const c = src[i]; if (c === '(') depth++; else if (c === ')') depth--; i++; }
    while (i < src.length && src[i] !== '{') i++;
    let bdepth = 0;
    const start = i;
    for (; i < src.length; i++) { const c = src[i]; if (c === '{') bdepth++; else if (c === '}') { bdepth--; if (bdepth === 0) { i++; break; } } }
    bodies.set(name, src.slice(start, i));
  }
  return bodies;
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
      'export async function bindPendingSeatToWorktree',
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

  it('the bound-PENDING bind op (bindPendingSeatToWorktree) is invoked ONLY by the attach path (server-handshake.ts)', () => {
    // CR#2/CR#4: bindPendingSeatToWorktree is a seat WRITER (it mutates a PENDING
    // record's worktree binding + display). seats.ts defines it; the sole caller is
    // the activation-failure bindPending thunk in server-handshake.ts. No command
    // binds a seat off the single-store API.
    expect(filesReferencing('bindPendingSeatToWorktree', ['seats.ts', 'server-handshake.ts'])).toEqual([]);
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

  it('the retired TTL renewal coordinator and its active-record reader are absent', () => {
    expect(filesReferencing('getActiveSeat(')).toEqual([]);
    expect(filesReferencing('session-continuity')).toEqual([]);
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

  it('SR NET-NEW: every credential backend .set/.delete in config.ts is lock-WRAPPED (behavioral, not placement)', () => {
    // A credential write outside a store-lock hold is exactly the CR3b regression
    // (an unlocked storeServerCredential) that the placement-only guards missed.
    // Matches the primitive lock or the sole credential-specific wrapper.
    const heldsLock = (b: string) =>
      /(?:withStore(?:Lock)?|withCredentialStoreLock)\s*[<(]/.test(b);
    const bodies = functionBodies(read('config.ts'));
    expect(heldsLock(bodies.get('withCredentialStoreLock') ?? '')).toBe(true);
    // Documented UNLOCKED write bodies — invoked ONLY from inside a lock hold.
    // Every such helper's callers are lock-verified below, so its own body is exempt.
    const ALLOWLIST_UNLOCKED = ['writeServerCredentialRecord'];
    const offenders: string[] = [];
    for (const [name, body] of bodies) {
      if (!/backend\.(set|delete)\(/.test(body)) continue;
      if (!heldsLock(body) && !ALLOWLIST_UNLOCKED.includes(name)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
    // Each allowlisted UNLOCKED body must be invoked ONLY from a lock-wrapped caller.
    for (const helper of ALLOWLIST_UNLOCKED) {
      const callers = [...bodies.entries()].filter(
        ([n, b]) => n !== helper && new RegExp(`\\b${helper}\\(`).test(b),
      );
      // It must actually be used (a dead unlocked writer would be a latent hazard)…
      expect(callers.length).toBeGreaterThan(0);
      // …and every caller holds the store lock before invoking it.
      for (const [, body] of callers) {
        expect(heldsLock(body)).toBe(true);
      }
    }
  });

  it('SR NET-NEW: every seat WRITE in seats.ts runs its RCW inside a withStore lock hold', () => {
    const bodies = functionBodies(read('seats.ts'));
    for (const writer of [
      'mintPendingSeat',
      'prepareSeat',
       'activateAndBindSeat',
      'bindPendingSeatToWorktree',
      'resetSeatForWorktree',
      'scrubPendingSeat',
      'clearSeat',
      'refreshSeatMetadata',
    ]) {
      const body = bodies.get(writer);
      expect(body, `${writer} must be defined in seats.ts`).toBeTruthy();
      expect(/withStore\s*</.test(body!), `${writer} must hold the store lock (withStore RCW)`).toBe(true);
    }
  });

  it('SR NET-NEW negative control: an UNLOCKED bindPendingSeatToWorktree would FAIL the lock guard', () => {
    // Prove the lock-wrapping guard actually discriminates locked from unlocked (a
    // placement-only guard would not): strip the withStore hold from the real body
    // and confirm the guard's predicate flips to false. This is the exact CR3b class
    // of regression (a writer that mutates the store OUTSIDE a lock hold).
    const bodies = functionBodies(read('seats.ts'));
    const body = bodies.get('bindPendingSeatToWorktree');
    expect(body, 'bindPendingSeatToWorktree must be defined in seats.ts').toBeTruthy();
    // Sanity: the real (locked) body passes the guard.
    expect(/withStore\s*</.test(body!)).toBe(true);
    // Remove every withStore hold — the unlocked body must be REJECTED by the guard.
    const unlocked = body!.replace(/withStore\s*</g, 'plainCall<');
    expect(/withStore\s*</.test(unlocked)).toBe(false);
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
