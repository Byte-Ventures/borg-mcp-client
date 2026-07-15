import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keychainMocks = vi.hoisted(() => ({
  getServerSessionCredential: vi.fn(async () => 'k'.repeat(43)),
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
  keychainMocks.getServerSessionCredential.mockClear();
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
    localSessionGeneration: 1,
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
    expect(keychainMocks.getServerSessionCredential).toHaveBeenCalledWith(
      localMetadata.localSessionCredentialRef,
      expect.objectContaining({ generation: 1 }),
    );
  });

  it('discards a delayed lower generation and retains the newer metadata', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube({ ...localMetadata, localSessionGeneration: 3 });

    await expect(cubes.setActiveCube({
      ...localMetadata,
      localSessionCredentialRef: `borg-server-session:${'b'.repeat(64)}`,
      localSessionGeneration: 2,
    })).rejects.toThrow(/stale.*generation/i);

    const persisted = JSON.parse(readFileSync(
      join(fixture, '.config', 'borgmcp', 'cubes.json'),
      'utf8',
    ));
    expect(persisted.projects[process.cwd()].localSessionGeneration).toBe(3);
    expect(persisted.projects[process.cwd()].localSessionCredentialRef)
      .toBe(localMetadata.localSessionCredentialRef);
    expect(keychainMocks.clearServerSessionCredential)
      .toHaveBeenCalledWith(`borg-server-session:${'b'.repeat(64)}`);
  });

  it('serializes reordered concurrent responses and keeps the greatest generation', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube(localMetadata);
    const generationThree = cubes.setActiveCube({
      ...localMetadata,
      localSessionCredentialRef: `borg-server-session:${'d'.repeat(64)}`,
      localSessionGeneration: 3,
    });
    const delayedGenerationTwo = cubes.setActiveCube({
      ...localMetadata,
      localSessionCredentialRef: `borg-server-session:${'e'.repeat(64)}`,
      localSessionGeneration: 2,
    });

    const outcomes = await Promise.allSettled([generationThree, delayedGenerationTwo]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    const persisted = JSON.parse(readFileSync(
      join(fixture, '.config', 'borgmcp', 'cubes.json'),
      'utf8',
    ));
    expect(persisted.projects[process.cwd()].localSessionGeneration).toBe(3);
    expect(persisted.projects[process.cwd()].localSessionCredentialRef)
      .toBe(`borg-server-session:${'d'.repeat(64)}`);
  });

  it('advances metadata before retiring the prior keychain generation', async () => {
    const { fixture, cubes } = await setup();
    await cubes.setActiveCube(localMetadata);
    const nextRef = `borg-server-session:${'c'.repeat(64)}`;
    await cubes.setActiveCube({
      ...localMetadata,
      localSessionCredentialRef: nextRef,
      localSessionGeneration: 2,
    });

    const persisted = readFileSync(
      join(fixture, '.config', 'borgmcp', 'cubes.json'),
      'utf8',
    );
    expect(persisted).toContain(nextRef);
    expect(keychainMocks.clearServerSessionCredential)
      .toHaveBeenCalledWith(localMetadata.localSessionCredentialRef);
  });
});
