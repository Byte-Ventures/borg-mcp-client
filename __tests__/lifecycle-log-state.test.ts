import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

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
    expect(existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('reclaims an abandoned stale lock before merging an announcement', async () => {
    const { recordLifecycleLog, shouldSuppressLifecycleLog } = await import('../src/lifecycle-log-guard.js');
    const statePath = join(fixture, '.config', 'borgmcp', 'lifecycle-log-state.json');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(`${statePath}.lock`, '');
    const stale = new Date(Date.now() - 31_000);
    utimesSync(`${statePath}.lock`, stale, stale);
    const identity = { kind: 'known' as const, id: 'claude:session', source: 'claude-session-start', observedAt: new Date(0).toISOString() };
    const subject = { cubeId: 'cube', droneId: 'drone' };
    await recordLifecycleLog(subject, 'ARRIVAL: online', identity);
    expect((await shouldSuppressLifecycleLog(subject, 'ARRIVAL: online', identity)).suppress).toBe(true);
    expect(existsSync(`${statePath}.lock`)).toBe(false);
  });

  it('retains all ten concurrent seats and earlier announcements', async () => {
    const { recordLifecycleLog, shouldSuppressLifecycleLog } = await import('../src/lifecycle-log-guard.js');
    const identity = { kind: 'known' as const, id: 'claude:session', source: 'claude-session-start', observedAt: new Date(0).toISOString() };
    const subjects = Array.from({ length: 10 }, (_, i) => ({ cubeId: 'cube', droneId: `drone-${i}` }));
    await recordLifecycleLog({ cubeId: 'cube', droneId: 'earlier' }, 'ARRIVAL: earlier', identity);
    await Promise.all(subjects.map((subject) => recordLifecycleLog(subject, 'ARRIVAL: online', identity)));
    for (const subject of [...subjects, { cubeId: 'cube', droneId: 'earlier' }]) {
      expect((await shouldSuppressLifecycleLog(subject, 'ARRIVAL: online', identity)).suppress, subject.droneId).toBe(true);
    }
  });

  it('serializes ten separate processes writing the same lifecycle file', async () => {
    const moduleUrl = new URL('../src/lifecycle-log-guard.ts', import.meta.url).href;
    const identity = { kind: 'known' as const, id: 'claude:session', source: 'claude-session-start', observedAt: new Date(0).toISOString() };
    const children = Array.from({ length: 10 }, (_, i) => {
      let ready!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      let child!: ReturnType<typeof execFile>;
      const finished = new Promise<void>((resolve, reject) => {
        child = execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
          import { recordLifecycleLog } from ${JSON.stringify(moduleUrl)};
          process.stdout.write('ready');
          for await (const chunk of process.stdin) {}
          await recordLifecycleLog({ cubeId: 'cube', droneId: 'child-${i}' }, 'ARRIVAL: online', ${JSON.stringify(identity)});
        `], { env: { ...process.env, BORG_STATE_ROOT: fixture }, timeout: 10_000 },
        (error) => { ready(); if (error) reject(error); else resolve(); });
        child.stdout!.once('data', ready);
      });
      return { child, started, finished };
    });
    try {
      await Promise.all(children.map(({ started }) => started));
      for (const { child } of children) child.stdin!.end();
      await Promise.all(children.map(({ finished }) => finished));
      const { shouldSuppressLifecycleLog } = await import('../src/lifecycle-log-guard.js');
      for (let i = 0; i < 10; i++) {
        expect((await shouldSuppressLifecycleLog({ cubeId: 'cube', droneId: `child-${i}` }, 'ARRIVAL: online', identity)).suppress, `child-${i}`).toBe(true);
      }
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(children.map(({ finished }) => finished));
    }
  });
});
