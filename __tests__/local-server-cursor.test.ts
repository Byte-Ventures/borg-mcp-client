import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const fixtures: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  vi.resetModules();
});

describe('local server cursor persistence', () => {
  const binding = {
    origin: 'https://localhost:8787',
    trustIdentity: 'spki-sha256:test-server',
    cubeId: '11111111-1111-4111-8111-111111111111',
    droneId: '22222222-2222-4222-8222-222222222222',
  };

  it('persists the tuple across restart and never regresses it', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-local-cursor-'));
    fixtures.push(fixture);
    process.env.HOME = fixture;
    vi.resetModules();
    const firstModule = await import('../src/local-server-cursor.js');
    const newer = {
      id: '44444444-4444-4444-8444-444444444444',
      created_at: '2026-07-14T14:00:02.000Z',
    };
    await firstModule.advanceLocalServerCursor(binding, newer);
    await firstModule.advanceLocalServerCursor(binding, {
      id: '33333333-3333-4333-8333-333333333333',
      created_at: '2026-07-14T14:00:01.000Z',
    });

    vi.resetModules();
    const restarted = await import('../src/local-server-cursor.js');
    await expect(restarted.getLocalServerCursor(binding)).resolves.toEqual(newer);
    expect(restarted.encodeLocalServerCursor(newer)).toBe(
      Buffer.from(JSON.stringify(newer), 'utf8').toString('base64url'),
    );
  });
});
