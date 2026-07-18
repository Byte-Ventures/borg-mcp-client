import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keychainMocks = vi.hoisted(() => ({
  getActiveServerSessionCredential: vi.fn(async () => 'k'.repeat(43)),
  clearServerSessionCredential: vi.fn(async () => {}),
}));

vi.mock('../src/config.js', () => keychainMocks);

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const fixtures: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
  keychainMocks.getActiveServerSessionCredential.mockClear();
  keychainMocks.clearServerSessionCredential.mockClear();
  vi.resetModules();
});

describe('local ActiveCube session persistence', () => {
  async function setup() {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-local-session-'));
    fixtures.push(fixture);
    const project = join(fixture, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    process.env.HOME = fixture;
    process.chdir(project);
    vi.resetModules();
    return {
      fixture,
      cubes: await import('../src/cubes.js'),
    };
  }

  const localMetadata = {
    cubeId: '11111111-1111-4111-8111-111111111111',
    droneId: '22222222-2222-4222-8222-222222222222',
    name: 'local-cube',
    droneLabel: 'builder-1',
    apiUrl: 'https://localhost:8787',
    serverTrustIdentity: 'spki-sha256:test-server',
    localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
    localSessionExpiresAt: '2026-07-14T16:00:00.000Z',
  };

  it('never writes a local bearer to cubes.json and hydrates it from keychain', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube({
      ...localMetadata,
      sessionToken: 'plaintext-must-not-persist',
    });

    const persisted = readFileSync(
      join(fixture, '.config', 'borgmcp', 'cubes.json'),
      'utf8',
    );
    expect(persisted).not.toContain('plaintext-must-not-persist');
    expect(persisted).toContain(localMetadata.localSessionCredentialRef);
    vi.resetModules();
    const restartedCubes = await import('../src/cubes.js');
    await expect(restartedCubes.getActiveCube()).resolves.toMatchObject({
      ...localMetadata,
      sessionToken: 'k'.repeat(43),
    });
    // The idempotent bearer is resolved by the opaque per-seat reference alone —
    // no drone id or generation is required (role + operation live in the record).
    expect(keychainMocks.getActiveServerSessionCredential).toHaveBeenCalledWith(
      localMetadata.localSessionCredentialRef,
      {
        origin: localMetadata.apiUrl,
        trustIdentity: localMetadata.serverTrustIdentity,
        cubeId: localMetadata.cubeId,
      },
    );
  });

  it('retires a superseded prior keychain reference when the seat reference changes', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube(localMetadata);
    const nextRef = `borg-server-session:${'c'.repeat(64)}`;
    await cubes.setActiveCube({
      ...localMetadata,
      localSessionCredentialRef: nextRef,
    });

    const persisted = readFileSync(
      join(fixture, '.config', 'borgmcp', 'cubes.json'),
      'utf8',
    );
    expect(persisted).toContain(nextRef);
    expect(keychainMocks.clearServerSessionCredential)
      .toHaveBeenCalledWith(localMetadata.localSessionCredentialRef);
  });

  it('clearActiveCube removes ONLY the current worktree binding + its credential; a sibling worktree and its ref are retained', async () => {
    const { fixture, cubes } = await setup();
    const projectA = process.cwd();
    const refA = `borg-server-session:${'a'.repeat(64)}`;
    await cubes.setActiveCube({ ...localMetadata, localSessionCredentialRef: refA, sessionToken: 'x' });

    // A distinct sibling worktree under the SAME home (its own .git → own key).
    const projectB = join(fixture, 'project-b');
    mkdirSync(join(projectB, '.git'), { recursive: true });
    process.chdir(projectB);
    const refB = `borg-server-session:${'b'.repeat(64)}`;
    await cubes.setActiveCube({ ...localMetadata, localSessionCredentialRef: refB, sessionToken: 'y' });

    // Back in worktree A: clear ONLY A's saved seat.
    process.chdir(projectA);
    const result = await cubes.clearActiveCube();
    expect(result).toEqual({ removed: true, credentialRef: refA });

    // A's keychain credential cleared; the SIBLING's is untouched.
    expect(keychainMocks.clearServerSessionCredential).toHaveBeenCalledWith(refA);
    expect(keychainMocks.clearServerSessionCredential).not.toHaveBeenCalledWith(refB);

    // cubes.json retains the sibling binding, not A's.
    const persisted = readFileSync(join(fixture, '.config', 'borgmcp', 'cubes.json'), 'utf8');
    expect(persisted).toContain(refB);
    expect(persisted).not.toContain(refA);

    // The sibling seat still resolves after the scoped reset.
    process.chdir(projectB);
    await expect(cubes.getActiveCube()).resolves.toMatchObject({ localSessionCredentialRef: refB });
  });

  it('clearActiveCube reports an honest no-op (removed:false) when this worktree has no saved binding', async () => {
    const { cubes } = await setup();
    const result = await cubes.clearActiveCube();
    expect(result).toEqual({ removed: false, credentialRef: null });
    expect(keychainMocks.clearServerSessionCredential).not.toHaveBeenCalled();
  });

  it('clearActiveCube refuses to delete when the pinned credential ref no longer matches (TOCTOU guard)', async () => {
    const { fixture, cubes } = await setup();
    // The binding currently holds a FRESH ref (e.g. a concurrent re-attach after
    // the rejection was observed).
    const currentRef = `borg-server-session:${'c'.repeat(64)}`;
    await cubes.setActiveCube({ ...localMetadata, localSessionCredentialRef: currentRef, sessionToken: 'x' });

    // A caller pins the OLD ref it saw rejected. The compare-under-lock must
    // refuse the delete (the seat changed) and report an honest no-op.
    const staleRef = `borg-server-session:${'a'.repeat(64)}`;
    const result = await cubes.clearActiveCube({ credentialRef: staleRef });
    expect(result).toEqual({ removed: false, credentialRef: null });
    expect(keychainMocks.clearServerSessionCredential).not.toHaveBeenCalled();

    // The current binding is untouched.
    const persisted = readFileSync(join(fixture, '.config', 'borgmcp', 'cubes.json'), 'utf8');
    expect(persisted).toContain(currentRef);
  });

  it('clearActiveCube refuses to delete when the BEARER digest differs under the SAME ref (same-ref replacement race)', async () => {
    const { fixture, cubes } = await setup();
    const ref = `borg-server-session:${'a'.repeat(64)}`;
    await cubes.setActiveCube({ ...localMetadata, localSessionCredentialRef: ref, sessionToken: 'x' });
    // The keychain now holds a FRESH valid bearer under the SAME ref (a concurrent
    // reset+re-enroll of this same worktree while the stale prompt was open).
    keychainMocks.getActiveServerSessionCredential.mockResolvedValue('FRESH-BEARER-value');
    const { createHash } = await import('node:crypto');

    // A caller pins the digest of the OLD (rejected) bearer. The ref matches but
    // the digest does not → the fresh replacement must NOT be clobbered.
    const staleDigest = createHash('sha256').update('STALE-rejected-bearer').digest('hex');
    const refused = await cubes.clearActiveCube({ credentialRef: ref, sessionDigest: staleDigest });
    expect(refused).toEqual({ removed: false, credentialRef: null });
    expect(keychainMocks.clearServerSessionCredential).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture, '.config', 'borgmcp', 'cubes.json'), 'utf8')).toContain(ref);

    // With the CURRENT bearer's digest, the scoped delete proceeds.
    const freshDigest = createHash('sha256').update('FRESH-BEARER-value').digest('hex');
    const ok = await cubes.clearActiveCube({ credentialRef: ref, sessionDigest: freshDigest });
    expect(ok).toEqual({ removed: true, credentialRef: ref });
  });

  it('clearActiveCube surfaces a keychain-delete failure (throws) so callers cannot audit success', async () => {
    const { cubes } = await setup();
    const ref = `borg-server-session:${'a'.repeat(64)}`;
    await cubes.setActiveCube({ ...localMetadata, localSessionCredentialRef: ref, sessionToken: 'x' });
    keychainMocks.clearServerSessionCredential.mockRejectedValueOnce(new Error('keychain locked'));
    await expect(cubes.clearActiveCube()).rejects.toThrow(/keychain/i);
  });
});
