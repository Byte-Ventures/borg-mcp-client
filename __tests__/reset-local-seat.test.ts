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
  droneId: '22222222-2222-4222-8222-222222222222',
  credentialRef: `borg-server-session:${'a'.repeat(64)}`,
  worktree: '/work/repo',
  observation: { state: 'active', digest: 'a'.repeat(64), droneId: '22222222-2222-4222-8222-222222222222' },
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

  it("CR #4: a 'partial' outcome (credential gone, binding removal fs-failed) is reported honestly, rerunnable, exit 1 — never a plain store error", async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'partial', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(1);
    const audit = out(stderr);
    expect(audit).toMatch(/PARTIALLY reset/);
    expect(audit).toMatch(/credential.*was cleared/);
    expect(audit).toMatch(/re-run/i);
    // NOT the false "could not complete (local credential store error)" copy.
    expect(audit).not.toContain('local credential store error');
  });

  it("CR #4: a 'repair-required' outcome (delete-throw readback unknown) never reports success, exit 1", async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'repair-required', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(1);
    const audit = out(stderr);
    expect(audit).toMatch(/could NOT confirm the reset|final state is unknown/);
    expect(audit).not.toMatch(/was cleared;/);
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
// cubes.ts primitive tests — REAL config keychain backend + real fs fixture.
// (CR #3/#4: no stubbing the primitive; real records + real fs/failure.)
// ---------------------------------------------------------------------------

import { chmodSync } from 'node:fs';
import type { TokenBackend } from '../src/token-store.js';

function memoryBackend(): { backend: TokenBackend; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    backend: {
      name: 'keychain',
      get: async (a) => values.get(a) ?? null,
      set: async (a, v) => { values.set(a, v); },
      delete: async (a) => { values.delete(a); },
    },
  };
}

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
  vi.resetModules();
});

const SEAT = {
  origin: 'https://localhost:8787',
  trustIdentity: 'sha256:test-server',
  cubeId: '11111111-1111-4111-8111-111111111111',
  roleId: '44444444-4444-4444-8444-444444444444',
  operation: { projectRoot: '/work/repo', kind: 'seat' as const, operationKey: 'current-worktree' },
};
const STAMP = {
  droneId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2026-07-20T00:00:00.000Z',
};

async function setup(backend?: TokenBackend) {
  const fixture = mkdtempSync(join(tmpdir(), 'borg-reset-seat-'));
  fixtures.push(fixture);
  const project = join(fixture, 'project');
  mkdirSync(join(project, '.git'), { recursive: true });
  process.env.HOME = fixture;
  process.chdir(project);
  vi.resetModules();
  const config = await import('../src/config.js');
  const mem = memoryBackend();
  config.__setServerCredentialBackendForTest(backend ?? mem.backend);
  const cubes = await import('../src/cubes.js');
  return { fixture, project, config, cubes, values: mem.values };
}
const cubesJson = (fixture: string) => join(fixture, '.config', 'borgmcp', 'cubes.json');
const readOrEmpty = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

type Cfg = typeof import('../src/config.js');
type Cubes = typeof import('../src/cubes.js');

/** Seed a real PENDING record (and, unless keepPending, activate it) + the cubes binding. */
async function seedSeat(config: Cfg, cubes: Cubes, opts: { keepPending?: boolean } = {}): Promise<{ ref: string; digest: string }> {
  const ref = config.serverSessionCredentialRef(SEAT);
  const pending = await config.getOrCreatePendingServerSession(SEAT);
  const digest = createHash('sha256').update(pending.credential).digest('hex');
  if (!opts.keepPending) {
    const outcome = await config.compareAndActivatePendingServerSession({ ...SEAT, ...STAMP, expectedPendingDigest: digest });
    expect(outcome).toBe('activated');
  }
  await cubes.setActiveCube({
    cubeId: SEAT.cubeId, droneId: STAMP.droneId, name: 'local-cube', droneLabel: 'builder-1',
    apiUrl: SEAT.origin, serverTrustIdentity: SEAT.trustIdentity, localSessionCredentialRef: ref,
    localSessionExpiresAt: STAMP.expiresAt, roleName: 'Drone', sessionToken: 'x',
  });
  return { ref, digest };
}

describe('cubes.snapshotLocalSeat (real backend)', () => {
  it('reports state=active + a token-safe digest (never the raw bearer)', async () => {
    const { config, cubes } = await setup();
    const { ref, digest } = await seedSeat(config, cubes);
    const snap = await cubes.snapshotLocalSeat();
    expect(snap).not.toBeNull();
    expect(snap!.observation).toEqual({ state: 'active', digest, droneId: STAMP.droneId });
    expect(snap!.droneId).toBe(STAMP.droneId);
    expect(snap!.credentialRef).toBe(ref);
    // No raw bearer leaks through the snapshot.
    const raw = JSON.parse(readOrEmpty(join(process.env.HOME!, '.config', 'borgmcp', 'cubes.json'))) as any;
    expect(JSON.stringify(snap)).not.toContain(raw.credential ?? 'no-bearer-field');
  });

  it('CR #3: a binding+PENDING seat observes state=pending (NOT mislabeled absent)', async () => {
    const { config, cubes } = await setup();
    const { digest } = await seedSeat(config, cubes, { keepPending: true });
    const snap = await cubes.snapshotLocalSeat();
    expect(snap!.observation).toEqual({ state: 'pending', digest });
  });

  it('reports state=absent when no record exists at the ref (only the binding remains)', async () => {
    const { config, cubes } = await setup();
    await seedSeat(config, cubes);
    await config.clearServerSessionCredential(config.serverSessionCredentialRef(SEAT));
    const snap = await cubes.snapshotLocalSeat();
    expect(snap!.observation).toEqual({ state: 'absent' });
  });

  it('returns null when this worktree has no local seat', async () => {
    const { cubes } = await setup();
    expect(await cubes.snapshotLocalSeat()).toBeNull();
  });
});

describe('cubes.resetLocalSeatBinding (real backend + real fs)', () => {
  it('ACTIVE: credential-FIRST delete then binding removal — record + binding both gone', async () => {
    const { fixture, config, cubes, values } = await setup();
    const { ref } = await seedSeat(config, cubes);
    const snap = (await cubes.snapshotLocalSeat())!;
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'reset', credentialRef: ref });
    expect(values.has(ref)).toBe(false);
    expect(readOrEmpty(cubesJson(fixture))).not.toContain(ref);
  });

  it('CR #3: PENDING binding+record reset converges — the pending record is cleared credential-first', async () => {
    const { fixture, config, cubes, values } = await setup();
    const { ref } = await seedSeat(config, cubes, { keepPending: true });
    const snap = (await cubes.snapshotLocalSeat())!;
    expect(snap.observation.state).toBe('pending');
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'reset', credentialRef: ref });
    expect(values.has(ref)).toBe(false);
    expect(readOrEmpty(cubesJson(fixture))).not.toContain(ref);
  });

  it('CR #3: prompt-gap same-ref replacement (fresh bearer) is a no-op, binding intact', async () => {
    const { fixture, config, cubes, values } = await setup();
    const { ref } = await seedSeat(config, cubes);
    const snap = (await cubes.snapshotLocalSeat())!;
    // In the prompt gap the seat was reset+re-enrolled: a FRESH bearer now occupies the SAME ref.
    await config.clearPendingServerSession(SEAT);
    const fresh = await config.getOrCreatePendingServerSession(SEAT);
    await config.compareAndActivatePendingServerSession({
      ...SEAT, ...STAMP, expectedPendingDigest: createHash('sha256').update(fresh.credential).digest('hex'),
    });
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'changed' });
    expect(values.has(ref)).toBe(true);
    expect(readOrEmpty(cubesJson(fixture))).toContain(ref);
  });

  it('CR #3: a drone-id change under the same ref is a full-binding change → no-op', async () => {
    const { fixture, config, cubes } = await setup();
    const { ref } = await seedSeat(config, cubes);
    const snap = (await cubes.snapshotLocalSeat())!;
    // The binding's drone id changed (e.g. a remint wrote a new seat under the same ref).
    await cubes.setActiveCube({
      cubeId: SEAT.cubeId, droneId: '99999999-9999-4999-8999-999999999999', name: 'local-cube',
      droneLabel: 'builder-2', apiUrl: SEAT.origin, serverTrustIdentity: SEAT.trustIdentity,
      localSessionCredentialRef: ref, roleName: 'Drone', sessionToken: 'x',
    });
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'changed' });
    expect(readOrEmpty(cubesJson(fixture))).toContain('99999999-9999');
  });

  it('ABSENT: removes the dangling binding (safe forward state)', async () => {
    const { fixture, config, cubes } = await setup();
    const { ref } = await seedSeat(config, cubes);
    await config.clearServerSessionCredential(ref);
    const snap = (await cubes.snapshotLocalSeat())!;
    expect(snap.observation.state).toBe('absent');
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'reset', credentialRef: ref });
    expect(readOrEmpty(cubesJson(fixture))).not.toContain(ref);
  });

  it('no-binding when the worktree binding is gone by commit time', async () => {
    const { fixture, config, cubes } = await setup();
    await seedSeat(config, cubes);
    const snap = (await cubes.snapshotLocalSeat())!;
    // The binding vanished between snapshot and commit (another process removed it).
    rmSync(cubesJson(fixture), { force: true });
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'no-binding' });
  });

  it('CR #4: a REAL binding-write failure AFTER the credential delete → PARTIAL (credential gone, rerunnable)', async () => {
    const { fixture, config, cubes, values } = await setup();
    const { ref } = await seedSeat(config, cubes);
    // A sibling keeps the projects map non-empty so binding removal takes the
    // writeCubesFile (rewrite) path, not the unlink path.
    const sibling = join(fixture, 'sibling');
    mkdirSync(join(sibling, '.git'), { recursive: true });
    process.chdir(sibling);
    await cubes.setActiveCube({
      cubeId: SEAT.cubeId, droneId: STAMP.droneId, name: 'local-cube', droneLabel: 'sib',
      apiUrl: SEAT.origin, serverTrustIdentity: SEAT.trustIdentity,
      localSessionCredentialRef: `borg-server-session:${'e'.repeat(64)}`, roleName: 'Drone', sessionToken: 'x',
    });
    process.chdir(join(fixture, 'project'));
    const snap = (await cubes.snapshotLocalSeat())!;
    // Inject a REAL writeCubesFile failure that fires AFTER the (real) credential delete.
    cubes.__setCubesWriteFailureForTest(() => new Error('ENOSPC: no space left on device'));
    try {
      const res = await cubes.resetLocalSeatBinding(snap);
      // Credential-FIRST: the keychain record was deleted even though the binding
      // rewrite failed — the safe forward state (binding-present/credential-absent).
      expect(values.has(ref)).toBe(false);
      expect(res).toEqual({ outcome: 'partial', credentialRef: ref });
    } finally {
      cubes.__setCubesWriteFailureForTest(null);
    }
  });

  it('CR #4: a delete-throw whose readback still sees the record → repair-required (never false success)', async () => {
    // A backend whose delete throws but whose get keeps returning the record →
    // compareAndClearSessionRecord readback = still present = unknown.
    const values = new Map<string, string>();
    const throwingBackend: TokenBackend = {
      name: 'keychain',
      get: async (a) => values.get(a) ?? null,
      set: async (a, v) => { values.set(a, v); },
      delete: async () => { throw new Error('keychain delete failed'); },
    };
    const { config, cubes } = await setup(throwingBackend);
    const { ref } = await seedSeat(config, cubes);
    const snap = (await cubes.snapshotLocalSeat())!;
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'repair-required', credentialRef: ref });
    // The record is still present (delete threw) and the binding is untouched.
    expect(values.has(ref)).toBe(true);
  });
});
