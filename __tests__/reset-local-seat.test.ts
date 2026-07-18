import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseResetLocalSeatArgs,
  runResetLocalSeat,
  type ResetLocalSeatDeps,
  type ResetLocalSeatFlags,
} from '../src/reset-local-seat-cmd.js';
import type {
  LocalSeatSnapshot,
  ResetLocalSeatOutcome,
} from '../src/cubes.js';

// ---------------------------------------------------------------------------
// Command-level tests (stub deps) — S0/S1/S2 flow + copy invariants.
// ---------------------------------------------------------------------------

const SNAPSHOT_PRESENT: LocalSeatSnapshot = {
  apiUrl: 'https://server.test',
  serverTrustIdentity: 'spki-sha256:server-a',
  cubeId: '11111111-1111-4111-8111-111111111111',
  credentialRef: `borg-server-session:${'a'.repeat(64)}`,
  worktree: '/work/repo',
  observation: { kind: 'present', sessionDigest: 'a'.repeat(64) },
};

function makeDeps(overrides: Partial<ResetLocalSeatDeps> = {}): ResetLocalSeatDeps {
  return {
    snapshotLocalSeat: vi.fn(async () => SNAPSHOT_PRESENT),
    resetLocalSeatBinding: vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome),
    findProjectRoot: () => '/work/repo',
    normalizeHost: (h) => (h.startsWith('http') ? h : `https://${h}`),
    cwd: () => '/work/repo',
    isTTY: () => true,
    prompt: vi.fn(async () => 'y'),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

const out = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('');

describe('runResetLocalSeat', () => {
  it('TTY confirm (y) resets, makes NO server-revocation claim, gives live re-enroll guidance', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, stderr, resetLocalSeatBinding, isTTY: () => true, prompt: vi.fn(async () => 'y') });
    expect(await runResetLocalSeat({}, deps)).toBe(0);
    expect(resetLocalSeatBinding).toHaveBeenCalledTimes(1);
    const audit = out(stderr);
    expect(audit).toContain("this worktree's saved local seat");
    expect(audit).toContain('server, trust anchor, cube, and sibling worktrees unchanged');
    // No server-revocation claim (offline command).
    expect(audit).not.toMatch(/revoked server-side|server revoked/i);
    expect(out(stdout)).toContain('`borg assimilate --host https://server.test --enroll`');
  });

  it('TTY decline (empty → default No) makes NO changes and never touches the binding', async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => true, prompt: vi.fn(async () => '') });
    expect(await runResetLocalSeat({}, deps)).toBe(0);
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stderr)).toContain('no changes made');
  });

  it('non-TTY WITHOUT --yes makes NO changes and directs to --yes (exit 1)', async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({}, deps)).toBe(1);
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stderr)).toContain('--yes');
  });

  it('non-TTY WITH --yes resets without a prompt', async () => {
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const prompt = vi.fn(async () => { throw new Error('must not prompt in non-TTY'); });
    const deps = makeDeps({ resetLocalSeatBinding, isTTY: () => false, prompt });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(0);
    expect(resetLocalSeatBinding).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('no local seat → honest no-op (exit 0), never re-checks or mutates', async () => {
    const stdout = vi.fn();
    const snapshotLocalSeat = vi.fn(async () => null);
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: 'x' }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, snapshotLocalSeat, resetLocalSeatBinding });
    expect(await runResetLocalSeat({}, deps)).toBe(0);
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stdout)).toMatch(/nothing to reset/i);
  });

  it('--host normalized-mismatch is a no-op BEFORE any prompt or mutation', async () => {
    const stdout = vi.fn();
    const prompt = vi.fn(async () => 'y');
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: 'x' }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, prompt, resetLocalSeatBinding });
    expect(await runResetLocalSeat({ host: 'other.host' }, deps)).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stdout)).toMatch(/not https:\/\/other\.host/);
  });

  it('--host matching the saved seat proceeds to reset', async () => {
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ host: 'server.test', yes: true }, deps)).toBe(0);
    expect(resetLocalSeatBinding).toHaveBeenCalledTimes(1);
  });

  it("a 'changed' recheck outcome is an honest no-op (never clobbers a replacement)", async () => {
    const stdout = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'changed' }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(0);
    expect(out(stdout)).toMatch(/changed since it was read/);
  });

  it('a reset-binding throw fails closed (exit 1) with a retry-safe audit, no false success', async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => { throw new Error('keychain locked'); });
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(1);
    const audit = out(stderr);
    expect(audit).toContain('could not complete');
    expect(audit).not.toContain('was cleared');
  });
});

describe('parseResetLocalSeatArgs', () => {
  const ok = (r: ReturnType<typeof parseResetLocalSeatArgs>): ResetLocalSeatFlags => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.flags;
  };

  it('parses --host / --host= / --yes / -y', () => {
    expect(ok(parseResetLocalSeatArgs([]))).toEqual({});
    expect(ok(parseResetLocalSeatArgs(['--yes']))).toEqual({ yes: true });
    expect(ok(parseResetLocalSeatArgs(['-y']))).toEqual({ yes: true });
    expect(ok(parseResetLocalSeatArgs(['--host', 'localhost:7091', '--yes']))).toEqual({ host: 'localhost:7091', yes: true });
    expect(ok(parseResetLocalSeatArgs(['--host=https://s.test']))).toEqual({ host: 'https://s.test' });
  });

  it('rejects --host without a value and unknown args', () => {
    expect(parseResetLocalSeatArgs(['--host']).ok).toBe(false);
    expect(parseResetLocalSeatArgs(['--host', '--yes']).ok).toBe(false);
    expect(parseResetLocalSeatArgs(['--bogus']).ok).toBe(false);
    expect(parseResetLocalSeatArgs(['role-arg']).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cubes.ts primitive tests (real fs fixture + mocked keychain).
// ---------------------------------------------------------------------------

const keychainMocks = vi.hoisted(() => ({
  getActiveServerSessionCredential: vi.fn(async () => 'k'.repeat(43)),
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
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  keychainMocks.getActiveServerSessionCredential.mockReset();
  keychainMocks.getActiveServerSessionCredential.mockResolvedValue('k'.repeat(43));
  keychainMocks.compareAndClearServerSessionCredential.mockReset();
  keychainMocks.compareAndClearServerSessionCredential.mockResolvedValue(true);
  vi.resetModules();
});

const meta = {
  cubeId: '11111111-1111-4111-8111-111111111111',
  droneId: '22222222-2222-4222-8222-222222222222',
  name: 'local-cube',
  droneLabel: 'builder-1',
  apiUrl: 'https://localhost:8787',
  serverTrustIdentity: 'spki-sha256:test-server',
  localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
  localSessionExpiresAt: '2026-07-14T16:00:00.000Z',
};

async function setup() {
  const fixture = mkdtempSync(join(tmpdir(), 'borg-reset-seat-'));
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

describe('cubes.snapshotLocalSeat', () => {
  it('reports PRESENT with a token-safe digest of the observed bearer (raw bearer never surfaced)', async () => {
    const { cubes } = await setup();
    keychainMocks.getActiveServerSessionCredential.mockResolvedValue('secret-bearer-'.padEnd(43, 'z'));
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    const snap = await cubes.snapshotLocalSeat();
    expect(snap).not.toBeNull();
    expect(snap!.observation).toEqual({
      kind: 'present',
      sessionDigest: createHash('sha256').update('secret-bearer-'.padEnd(43, 'z')).digest('hex'),
    });
    expect(JSON.stringify(snap)).not.toContain('secret-bearer');
  });

  it('reports ABSENT when the keychain credential is gone (only the binding remains)', async () => {
    const { cubes } = await setup();
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    keychainMocks.getActiveServerSessionCredential.mockResolvedValue(null as unknown as string);
    const snap = await cubes.snapshotLocalSeat();
    expect(snap!.observation).toEqual({ kind: 'absent' });
  });

  it('returns null when this worktree has no local seat', async () => {
    const { cubes } = await setup();
    expect(await cubes.snapshotLocalSeat()).toBeNull();
  });
});

describe('cubes.resetLocalSeatBinding', () => {
  async function snapWith(cubes: typeof import('../src/cubes.js')): Promise<LocalSeatSnapshot> {
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    const snap = await cubes.snapshotLocalSeat();
    return snap!;
  }

  it('PRESENT: credential-FIRST atomic delete, THEN binding removal (rerunnable)', async () => {
    const { fixture, cubes } = await setup();
    const snap = await snapWith(cubes);
    keychainMocks.compareAndClearServerSessionCredential.mockResolvedValue(true);
    const res = await cubes.resetLocalSeatBinding(snap);
    expect(res).toEqual({ outcome: 'reset', credentialRef: meta.localSessionCredentialRef });
    expect(keychainMocks.compareAndClearServerSessionCredential).toHaveBeenCalledWith(
      meta.localSessionCredentialRef,
      { origin: meta.apiUrl, trustIdentity: meta.serverTrustIdentity, cubeId: meta.cubeId },
      snap.observation.kind === 'present' ? snap.observation.sessionDigest : '',
    );
    expect(readOrEmpty(cubesJson(fixture))).not.toContain(meta.localSessionCredentialRef);
  });

  it('PRESENT: a non-matching atomic compare (same-ref remint / stale digest) is an honest no-op, binding intact', async () => {
    const { fixture, cubes } = await setup();
    const snap = await snapWith(cubes);
    keychainMocks.compareAndClearServerSessionCredential.mockResolvedValue(false);
    const res = await cubes.resetLocalSeatBinding(snap);
    expect(res).toEqual({ outcome: 'changed' });
    expect(readOrEmpty(cubesJson(fixture))).toContain(meta.localSessionCredentialRef);
  });

  it('ABSENT: the safe forward state removes the dangling binding (no credential to delete)', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    keychainMocks.getActiveServerSessionCredential.mockResolvedValue(null as unknown as string);
    const snap = await cubes.snapshotLocalSeat();
    const res = await cubes.resetLocalSeatBinding(snap!);
    expect(res).toEqual({ outcome: 'reset', credentialRef: meta.localSessionCredentialRef });
    expect(keychainMocks.compareAndClearServerSessionCredential).not.toHaveBeenCalled();
    expect(readOrEmpty(cubesJson(fixture))).not.toContain(meta.localSessionCredentialRef);
  });

  it('ABSENT: a fresh credential appearing under the same ref is a same-ref replacement — no clobber', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube({ ...meta, sessionToken: 'x' });
    // S0 observed ABSENT...
    keychainMocks.getActiveServerSessionCredential.mockResolvedValueOnce(null as unknown as string);
    const snap = await cubes.snapshotLocalSeat();
    // ...but by S2 a fresh bearer landed under the same deterministic ref.
    keychainMocks.getActiveServerSessionCredential.mockResolvedValue('r'.repeat(43));
    const res = await cubes.resetLocalSeatBinding(snap!);
    expect(res).toEqual({ outcome: 'changed' });
    expect(readOrEmpty(cubesJson(fixture))).toContain(meta.localSessionCredentialRef);
  });

  it("recheck no-op when the live binding's ref drifted from the snapshot", async () => {
    const { fixture, cubes } = await setup();
    const snap = await snapWith(cubes);
    // A concurrent re-enroll rewrote the binding to a different ref.
    await cubes.setActiveCube({ ...meta, localSessionCredentialRef: `borg-server-session:${'c'.repeat(64)}`, sessionToken: 'x' });
    const res = await cubes.resetLocalSeatBinding(snap);
    expect(res).toEqual({ outcome: 'changed' });
    expect(readOrEmpty(cubesJson(fixture))).toContain('c'.repeat(64));
  });

  it("no-binding when the worktree binding is gone by commit time", async () => {
    const { cubes } = await setup();
    const snap = await snapWith(cubes);
    await cubes.clearActiveCube();
    const res = await cubes.resetLocalSeatBinding(snap);
    expect(res).toEqual({ outcome: 'no-binding' });
  });
});
