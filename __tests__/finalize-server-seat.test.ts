/**
 * Part (C) — COMPOSITE cube-owned attach FINALIZE (finalizeServerSeatAttachment).
 * Closes Race 2 on the attach path: binding-FIRST persist, then the single
 * keychain pending→ACTIVE flip, under the cube lock held OUTER; typed
 * prepare-time expectation revalidated at commit; abort compare-and-scrubs only
 * the own pending record. "ACTIVE credential without a binding" is unreachable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExpectedBinding } from '../src/cubes.js';

const keychainMocks = vi.hoisted(() => ({
  getActiveServerSessionCredential: vi.fn(async () => null as string | null),
  clearServerSessionCredential: vi.fn(async () => {}),
  compareAndClearServerSessionCredential: vi.fn(async () => true),
}));
vi.mock('../src/config.js', () => keychainMocks);

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const fixtures: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) {
    try { chmodSync(join(f, '.config', 'borgmcp'), 0o700); } catch { /* ignore */ }
    rmSync(f, { recursive: true, force: true });
  }
  keychainMocks.getActiveServerSessionCredential.mockReset();
  keychainMocks.getActiveServerSessionCredential.mockResolvedValue(null);
  vi.resetModules();
});

const REF = `borg-server-session:${'a'.repeat(64)}`;
const meta = {
  cubeId: '11111111-1111-4111-8111-111111111111',
  droneId: '22222222-2222-4222-8222-222222222222',
  name: 'local-cube',
  droneLabel: 'builder-1',
  apiUrl: 'https://localhost:8787',
  serverTrustIdentity: 'spki-sha256:test-server',
  localSessionCredentialRef: REF,
  localSessionExpiresAt: '2026-07-20T00:00:00.000Z',
  roleName: 'Builder',
};

async function setup() {
  const fixture = mkdtempSync(join(tmpdir(), 'borg-finalize-'));
  fixtures.push(fixture);
  const project = join(fixture, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  process.env.HOME = fixture;
  process.chdir(project);
  vi.resetModules();
  return { fixture, cubes: await import('../src/cubes.js') };
}
const cubesJson = (fixture: string) => join(fixture, '.config', 'borgmcp', 'cubes.json');
const readOrEmpty = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

describe('finalizeServerSeatAttachment', () => {
  it('ABSENT first-enroll: commits BINDING-FIRST (binding persisted BEFORE activate runs)', async () => {
    const { fixture, cubes } = await setup();
    let bindingVisibleWhenActivated = false;
    const activate = vi.fn(async () => {
      bindingVisibleWhenActivated = readOrEmpty(cubesJson(fixture)).includes(REF);
    });
    const scrubPending = vi.fn(async () => {});
    const res = await cubes.finalizeServerSeatAttachment({
      active: { ...meta }, expected: { kind: 'absent' }, activate, scrubPending,
    });
    expect(res).toEqual({ committed: true });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(scrubPending).not.toHaveBeenCalled();
    // Binding-FIRST: the binding was already on disk when activate ran.
    expect(bindingVisibleWhenActivated).toBe(true);
    expect(readOrEmpty(cubesJson(fixture))).toContain(REF);
  });

  it('ABSENT but a binding appeared: ABORTS, scrubs own pending, NEVER activates', async () => {
    const { fixture, cubes } = await setup();
    // A competing enroll wrote a binding for this worktree between PREPARE and FINALIZE.
    await cubes.setActiveCube({ ...meta, localSessionCredentialRef: `borg-server-session:${'b'.repeat(64)}`, sessionToken: 'x' });
    const activate = vi.fn(async () => {});
    const scrubPending = vi.fn(async () => {});
    const res = await cubes.finalizeServerSeatAttachment({
      active: { ...meta }, expected: { kind: 'absent' }, activate, scrubPending,
    });
    expect(res).toEqual({ committed: false, reason: 'expectation-mismatch' });
    expect(activate).not.toHaveBeenCalled();
    expect(scrubPending).toHaveBeenCalledTimes(1);
    // The competing binding is preserved (never overwritten).
    expect(readOrEmpty(cubesJson(fixture))).toContain('b'.repeat(64));
  });

  it('EXACT reattach (live bearer digest matches): commits', async () => {
    const { cubes } = await setup();
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    const bearer = 'live-bearer-'.padEnd(43, 'z');
    keychainMocks.getActiveServerSessionCredential.mockResolvedValue(bearer);
    const activate = vi.fn(async () => {});
    const scrubPending = vi.fn(async () => {});
    const expected: ExpectedBinding = {
      kind: 'exact', credentialRef: REF, sessionDigest: createHash('sha256').update(bearer).digest('hex'),
    };
    const res = await cubes.finalizeServerSeatAttachment({ active: { ...meta }, expected, activate, scrubPending });
    expect(res).toEqual({ committed: true });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(scrubPending).not.toHaveBeenCalled();
  });

  it('RACE 2: PREPARE-paused, offline reset commits in the gap → FINALIZE ABORTS, no orphan ACTIVE, binding+credential absent', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    // Offline reset committed in the network gap: credential-first delete, then
    // binding removal. Model the end state — the binding is gone.
    await cubes.clearActiveCube();
    expect(readOrEmpty(cubesJson(fixture))).not.toContain(REF);

    const activate = vi.fn(async () => {});
    const scrubPending = vi.fn(async () => {});
    const expected: ExpectedBinding = { kind: 'exact', credentialRef: REF, sessionDigest: 'a'.repeat(64) };
    const res = await cubes.finalizeServerSeatAttachment({ active: { ...meta }, expected, activate, scrubPending });
    expect(res).toEqual({ committed: false, reason: 'expectation-mismatch' });
    // NEVER activates → no orphan ACTIVE credential; the reset stays complete.
    expect(activate).not.toHaveBeenCalled();
    expect(scrubPending).toHaveBeenCalledTimes(1);
    expect(readOrEmpty(cubesJson(fixture))).not.toContain(REF);
  });

  it('EXACT same-ref replacement (live bearer digest changed by a reset+re-enroll): ABORTS', async () => {
    const { cubes } = await setup();
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    // The ref is unchanged but the LIVE bearer is a fresh one (different digest).
    keychainMocks.getActiveServerSessionCredential.mockResolvedValue('fresh-bearer-'.padEnd(43, 'q'));
    const activate = vi.fn(async () => {});
    const scrubPending = vi.fn(async () => {});
    const expected: ExpectedBinding = { kind: 'exact', credentialRef: REF, sessionDigest: 'a'.repeat(64) };
    const res = await cubes.finalizeServerSeatAttachment({ active: { ...meta }, expected, activate, scrubPending });
    expect(res).toEqual({ committed: false, reason: 'expectation-mismatch' });
    expect(activate).not.toHaveBeenCalled();
    expect(scrubPending).toHaveBeenCalledTimes(1);
  });

  it('EXACT ref-only (eviction remint): commits without consulting the live-bearer digest', async () => {
    const { cubes } = await setup();
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    const activate = vi.fn(async () => {});
    const res = await cubes.finalizeServerSeatAttachment({
      active: { ...meta }, expected: { kind: 'exact', credentialRef: REF }, activate, scrubPending: vi.fn(async () => {}),
    });
    expect(res).toEqual({ committed: true });
    expect(activate).toHaveBeenCalledTimes(1);
    // No digest pinned → the live-bearer read is skipped entirely.
    expect(keychainMocks.getActiveServerSessionCredential).not.toHaveBeenCalled();
  });

  it('activation-failure leaves binding-present/credential-PENDING (never ACTIVE-without-binding); a retry converges', async () => {
    const { fixture, cubes } = await setup();
    // First FINALIZE: binding persists, then activation THROWS.
    const failing = vi.fn(async () => { throw new Error('keychain locked'); });
    await expect(cubes.finalizeServerSeatAttachment({
      active: { ...meta }, expected: { kind: 'absent' }, activate: failing, scrubPending: vi.fn(async () => {}),
    })).rejects.toThrow(/keychain/i);
    // Binding was written (PENDING-without-ACTIVE forward state) — never rolled back.
    expect(readOrEmpty(cubesJson(fixture))).toContain(REF);

    // Retry PREPARE+FINALIZE (EXACT ref-only, same ref) with a working activate → converges.
    const activate = vi.fn(async () => {});
    const res = await cubes.finalizeServerSeatAttachment({
      active: { ...meta }, expected: { kind: 'exact', credentialRef: REF }, activate, scrubPending: vi.fn(async () => {}),
    });
    expect(res).toEqual({ committed: true });
    expect(activate).toHaveBeenCalledTimes(1);
    // The binding was present the ENTIRE time — activation only ever ran with a binding on disk.
    expect(readOrEmpty(cubesJson(fixture))).toContain(REF);
  });

  it('binding-write-failure never reaches activate (no orphan ACTIVE credential)', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1;
    if (uid === 0) return; // root ignores mode bits; skip this permission-based test
    const { fixture, cubes } = await setup();
    // A sibling worktree keeps the projects map non-empty (so the write path is a
    // rewrite, not an unlink). Then make the state dir read-only so writeCubesFile fails.
    const sibling = join(fixture, 'sibling');
    mkdirSync(join(sibling, '.git'), { recursive: true });
    process.chdir(sibling);
    await cubes.setActiveCube({ ...meta, localSessionCredentialRef: `borg-server-session:${'c'.repeat(64)}`, sessionToken: 'x' });
    process.chdir(join(fixture, 'project'));
    chmodSync(join(fixture, '.config', 'borgmcp'), 0o500);

    const activate = vi.fn(async () => {});
    await expect(cubes.finalizeServerSeatAttachment({
      active: { ...meta }, expected: { kind: 'absent' }, activate, scrubPending: vi.fn(async () => {}),
    })).rejects.toBeTruthy();
    expect(activate).not.toHaveBeenCalled();
  });

  it('lock-order coherence: two concurrent FINALIZE calls for the same worktree serialize — exactly one commits', async () => {
    const { cubes } = await setup();
    // Both race to first-enroll (ABSENT). The cube lock serializes them: the loser
    // observes a binding appeared and aborts. No deadlock, no inversion, no throw.
    const a = cubes.finalizeServerSeatAttachment({
      active: { ...meta }, expected: { kind: 'absent' }, activate: vi.fn(async () => {}), scrubPending: vi.fn(async () => {}),
    });
    const b = cubes.finalizeServerSeatAttachment({
      active: { ...meta, localSessionCredentialRef: `borg-server-session:${'d'.repeat(64)}` }, expected: { kind: 'absent' }, activate: vi.fn(async () => {}), scrubPending: vi.fn(async () => {}),
    });
    const [ra, rb] = await Promise.all([a, b]);
    const committed = [ra, rb].filter((r) => r.committed).length;
    expect(committed).toBe(1);
  });
});
