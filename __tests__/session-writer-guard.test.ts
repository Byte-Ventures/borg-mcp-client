/**
 * Static source-enumeration guard for the drone-session keychain writer
 * inventory (ratified client-seat-reset-state-model, part D).
 *
 * The `borg-server-session:` credential group is security-critical: every
 * create / activate / delete / observe MUST flow through the sanctioned
 * config.ts wrappers (each of which takes the per-account keychain lock), the
 * cube write lock must always be OUTER (no keychain→cube inversion), and the
 * raw bearer must never be resolved outside the sanctioned hydration/composite
 * owner. This test enumerates those facts deterministically from source so a
 * future writer that bypasses the lock, inverts the lock order, or leaks a
 * bearer fails CI — no reviewer has to remember the invariant.
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
  return srcFiles.filter(
    (f) => !allow.includes(f) && read(f).includes(needle),
  );
}

describe('drone-session keychain writer guard (part D)', () => {
  it('the OS-keychain backend accessor is reached ONLY from config.ts (single writer layer)', () => {
    // getServerCredentialBackend() is the sole door to the keychain backend for
    // the server credential group. If any other module reaches it, a writer can
    // bypass the account-scoped locks in config.ts.
    expect(filesReferencing('getServerCredentialBackend', ['config.ts'])).toEqual([]);
  });

  it('no module outside config.ts performs a raw backend.set/delete/get', () => {
    for (const call of ['backend.set(', 'backend.delete(', 'backend.get(']) {
      expect(filesReferencing(call, ['config.ts'])).toEqual([]);
    }
  });

  it('the keychain layer NEVER acquires the cube lock (no keychain→cube inversion)', () => {
    const config = read('config.ts');
    // config.ts must not import the cube-lock owner, nor name its write lock.
    expect(config).not.toMatch(/from '\.\/cubes(\.js)?'/);
    expect(config).not.toContain('withCubesWriteLock');
  });

  it('CR #1: the worktree BINDING writer (writeCubesFile) lives ONLY in the cube-lock owner (cubes.ts)', () => {
    // Every cubes.json binding mutation flows through writeCubesFile, which is
    // private to cubes.ts and only ever called under withCubesWriteLock. No other
    // module may write a binding (a bypass writer outside the composite).
    expect(filesReferencing('writeCubesFile', ['cubes.ts'])).toEqual([]);
  });

  it('CR #1: the drone-SESSION credential SEND (attach `session_credential`) lives ONLY in server-handshake.ts', () => {
    // The only place a session bearer is put on the wire is the attach POST body.
    // A `session_credential` send anywhere else is an unsanctioned credential path.
    expect(filesReferencing('session_credential', ['server-handshake.ts'])).toEqual([]);
  });

  it('CR #1: the production orchestrator routes the MINT through the cube-lock composite, not a bypass attach', () => {
    const deps = read('assimilate-deps.ts');
    // assimilate-deps mints under cubes.prepareServerSeatAttachment (PREPARE-time
    // revalidation), and sends via the network-only sendBorgServerAttach...
    expect(deps).toContain('prepareServerSeatAttachment');
    expect(deps).toContain('sendBorgServerAttach');
    // ...and NEVER the mint+send(+activate) wrappers that skip the cube-lock
    // prepare revalidation.
    expect(deps).not.toContain('attachBorgServer');
    expect(deps).not.toContain('prepareBorgServerAttach');
  });

  it('CR #1: the pre-composite attach wrappers are confined to server-handshake.ts (no production caller elsewhere)', () => {
    // attachBorgServer / prepareBorgServerAttach mint (and attachBorgServer also
    // activates) without the cube-lock PREPARE revalidation — they are retained
    // only for lower-level tests and must have NO caller in any other src module.
    expect(filesReferencing('attachBorgServer', ['server-handshake.ts'])).toEqual([]);
    expect(filesReferencing('prepareBorgServerAttach', ['server-handshake.ts'])).toEqual([]);
  });

  it('the cube-lock owner reaches session credentials ONLY via sanctioned config exports (never a raw backend)', () => {
    const cubes = read('cubes.ts');
    // cubes.ts holds the OUTER cube lock; it must never construct or touch the
    // keychain backend directly — the keychain lock is taken INNER, inside the
    // config wrappers it calls (compareAndClearServerSessionCredential, etc.).
    expect(cubes).not.toContain('getServerCredentialBackend');
    expect(cubes).not.toContain('makeKeychainBackend');
    expect(cubes).not.toContain('AsyncEntry');
  });

  it('the raw-bearer accessor is resolved ONLY inside the sanctioned hydration/composite owner (cubes.ts)', () => {
    // getActiveServerSessionCredential is the ONLY function that returns a raw
    // session bearer. It is called only by cubes.ts (hydrateActiveCube +
    // snapshotLocalSeat / resetLocalSeatBinding) and defined in config.ts. No
    // command, remote-client, or handshake path may resolve a bearer directly.
    expect(filesReferencing('getActiveServerSessionCredential', ['config.ts', 'cubes.ts'])).toEqual([]);
  });

  it('the legacy generation-based session store/get is gone (retired writer surface)', () => {
    const config = read('config.ts');
    expect(config).not.toContain('storeServerSessionCredential');
    expect(config).not.toContain('getServerSessionCredential(');
  });

  it('the composite FINALIZE sanctioned wrappers live in the correct layer (config vs cube-owner)', () => {
    const config = read('config.ts');
    const cubes = read('cubes.ts');
    // Keychain-layer wrappers (each account-lock-guarded) live in config.ts.
    expect(config).toContain('export async function compareAndClearPendingServerSession');
    expect(config).toContain('export function serverSessionCredentialRef');
    // The cube-owned composite lives in cubes.ts and holds the OUTER cube lock.
    expect(cubes).toContain('export async function finalizeServerSeatAttachment');
    // The composite NEVER imports the raw keychain activation/scrub — those reach
    // it only as INJECTED thunks (prepared by server-handshake), so the keychain
    // lock is always taken INNER, inside config wrappers, under the cube lock.
    expect(cubes).not.toContain('activatePendingServerSession');
    expect(cubes).not.toContain('compareAndClearPendingServerSession');
  });

  it("config's every borg-server-session: backend mutation lives beside a per-account keychain lock", () => {
    // Sanity that the guard has real subject matter: the session account prefix
    // and the account-scoped lock both live in config.ts.
    const config = read('config.ts');
    expect(config).toContain('borg-server-session:');
    expect(config).toContain('withServerKeychainLock');
    // The unpinned delete path is now lock-wrapped (part D).
    expect(config).toMatch(/clearServerSessionCredential[\s\S]*withServerKeychainLock/);
  });
});
