import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

describe('lifecycle-log state persistence', () => {
  const originalStateRoot = process.env.BORG_STATE_ROOT;
  let fixture: string;

  beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'borg-lifecycle-state-')));
    process.env.BORG_STATE_ROOT = fixture;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
    else process.env.BORG_STATE_ROOT = originalStateRoot;
    rmSync(fixture, { recursive: true, force: true });
    vi.resetModules();
  });

  it.each([
    ['malformed JSON', '{"entries": ]\n'],
    ['valid JSON with the wrong shape', '{"entries": []}\n'],
  ])('refuses to overwrite %s', async (_label, raw) => {
    const { recordLifecycleLog } = await import('../src/lifecycle-log-guard.js');
    const statePath = join(fixture, '.config', 'borgmcp', 'lifecycle-log-state.json');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, raw);

    await expect(recordLifecycleLog(
      { cubeId: 'cube', droneId: 'drone' },
      'ARRIVAL: drone online',
    )).rejects.toThrow(
      `Lifecycle log state is unreadable; refusing to overwrite it: ${statePath}`,
    );
    expect(readFileSync(statePath, 'utf8')).toBe(raw);
  });
});
