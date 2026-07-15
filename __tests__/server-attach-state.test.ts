import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const fixtures: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
  vi.resetModules();
});

describe('local attach retry persistence', () => {
  const binding = {
    origin: 'https://localhost:8787',
    trustIdentity: 'spki-sha256:test-server',
    cubeId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
  };

  it('persists the retry key before use and reuses it after a process restart', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-attach-state-'));
    fixtures.push(fixture);
    process.env.HOME = fixture;
    vi.resetModules();
    const firstModule = await import('../src/server-attach-state.js');
    const first = await firstModule.getOrCreateLocalAttachRetryKey(binding, '/project/a');

    const statePath = join(fixture, '.config', 'borgmcp', 'local-attach-retries.json');
    expect(readFileSync(statePath, 'utf8')).toContain(first);

    vi.resetModules();
    const restartedModule = await import('../src/server-attach-state.js');
    await expect(
      restartedModule.getOrCreateLocalAttachRetryKey(binding, '/project/a'),
    ).resolves.toBe(first);
  });

  it('uses distinct correlators for different request fingerprints', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-attach-state-'));
    fixtures.push(fixture);
    process.env.HOME = fixture;
    vi.resetModules();
    const { getOrCreateLocalAttachRetryKey } = await import('../src/server-attach-state.js');

    const first = await getOrCreateLocalAttachRetryKey(binding, '/project/a');
    const changedRole = await getOrCreateLocalAttachRetryKey({
      ...binding,
      roleId: '33333333-3333-4333-8333-333333333333',
    }, '/project/a');
    const changedProject = await getOrCreateLocalAttachRetryKey(binding, '/project/b');

    expect(new Set([first, changedRole, changedProject]).size).toBe(3);
  });

  it('serializes concurrent first attempts onto one persisted retry key', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-attach-state-'));
    fixtures.push(fixture);
    process.env.HOME = fixture;
    vi.resetModules();
    const { getOrCreateLocalAttachRetryKey } = await import('../src/server-attach-state.js');

    const keys = await Promise.all(Array.from({ length: 8 }, () =>
      getOrCreateLocalAttachRetryKey(binding, '/project/a')
    ));

    expect(new Set(keys).size).toBe(1);
  });

  it('fails closed instead of replacing corrupt retry state', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-attach-state-'));
    fixtures.push(fixture);
    process.env.HOME = fixture;
    const stateDir = join(fixture, '.config', 'borgmcp');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'local-attach-retries.json'), '{not-json');
    vi.resetModules();
    const { getOrCreateLocalAttachRetryKey } = await import('../src/server-attach-state.js');

    await expect(
      getOrCreateLocalAttachRetryKey(binding, '/project/a'),
    ).rejects.toThrow(/retry state is corrupt/i);
  });
});
