/** Controls for the real-HOME guard (__tests__/global/real-home-guard.ts). */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIVE_WRITERS, TEST_MARKERS, realBorgConfig, scanForMarkers, snapshotTree, treeChanges } from './global/real-home-guard.js';
import { TEST_FORBIDDEN_HOME_ENV, TestIsolationError, borgConfigRoot, borgHomeRoot } from '../src/private-root.js';

describe('the run never resolves Borg state under the real home', () => {
  it('gives this worker a private HOME', () => {
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(borgConfigRoot()).not.toBe(realBorgConfig());
    expect(borgConfigRoot().startsWith(realBorgConfig() + sep)).toBe(false);
  });

  it('gives a child spawned with the inherited environment a private HOME too', () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const { borgConfigRoot } = await import(${JSON.stringify(join(process.cwd(), 'src', 'private-root.ts'))}); console.log(borgConfigRoot());`],
    { encoding: 'utf8', timeout: 30_000 });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).not.toBe(realBorgConfig());
    expect(child.stdout.trim().startsWith(realBorgConfig() + sep)).toBe(false);
  });
});

describe('prevention: no Borg resolver can compute a path in the real home during a test', () => {
  const realHome = realpathSync(userInfo().homedir);
  const src = (name: string) => JSON.stringify(join(process.cwd(), 'src', name));

  it('records the real home for every worker', () => {
    expect(process.env[TEST_FORBIDDEN_HOME_ENV]).toBe(realHome);
  });

  it('refuses the real home in every lazy resolver in this worker, before building any path', async () => {
    const saved = { home: process.env.HOME, root: process.env.BORG_STATE_ROOT };
    const { representativeStateRoot } = await import('../src/representative-db.js');
    const { legacyStorePath } = await import('../src/representative-legacy.js');
    const { createRepresentativeStore } = await import('../src/representative-store.js');
    try {
      for (const set of [() => { process.env.HOME = realHome; delete process.env.BORG_STATE_ROOT; },
        () => { process.env.BORG_STATE_ROOT = realHome; }]) {
        set();
        expect(() => borgHomeRoot()).toThrow(TestIsolationError);
        expect(() => borgConfigRoot()).toThrow(TestIsolationError);
        expect(() => representativeStateRoot()).toThrow(TestIsolationError);
        expect(() => legacyStorePath()).toThrow(TestIsolationError); // <real home>/.config/borgmcp/representative.json
        expect(() => createRepresentativeStore()).toThrow(TestIsolationError); // refused before any state access
      }
    } finally {
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
      if (saved.root === undefined) delete process.env.BORG_STATE_ROOT; else process.env.BORG_STATE_ROOT = saved.root;
    }
    expect(borgConfigRoot()).not.toBe(realBorgConfig());
  });

  // Each child only resolves: if prevention ever failed it stops instead of writing.
  it.each([
    ['local-server-cursors.json', 'local-server-cursor.ts', 'advanceLocalServerCursor'],
    ['stream-locks/<cube>/<drone>.lock/owner.json', 'stream-owner.ts', 'acquireStreamLease'],
    ['representative.json and the state database', 'representative-store.ts', 'createRepresentativeStore'],
  ])('refuses %s in a spawned child pointed at the real home, before any I/O', (_target, module, entry) => {
    const payload = `
      let mod;
      try { mod = await import(${src(module)}); if (${JSON.stringify(entry)} === 'createRepresentativeStore') mod.createRepresentativeStore(); }
      catch (error) { console.log('REFUSED', error.name); process.exit(3); }
      console.log('NOT REFUSED'); process.exit(4);`;
    for (const env of [
      { ...process.env, HOME: realHome }, // inherited environment, real HOME
      { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_'))), HOME: realHome }, // BORG_* stripped
      { ...process.env, BORG_STATE_ROOT: realHome }, // explicit state root
    ]) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', payload],
        { encoding: 'utf8', timeout: 30_000, env });
      expect(child.stdout.trim()).toBe('REFUSED TestIsolationError');
      expect(child.status).toBe(3);
    }
  });
});

function fakeConfig(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-protected-')));
  mkdirSync(join(root, 'stream-locks', 'cube'), { recursive: true });
  writeFileSync(join(root, 'existing.json'), '{"a":1}');
  writeFileSync(join(root, 'stream-locks', 'cube', 'owner.json'), '{"beat":1}');
  return root;
}

describe('the tree comparison', () => {
  it.each([
    ['a created marker-free file', (dir: string) => writeFileSync(join(dir, 'representative.json'), '{"version":1,"bindings":{}}'), 'created representative.json'],
    ['a created directory', (dir: string) => mkdirSync(join(dir, 'representative')), 'created representative'],
    ['a modified file (same size)', (dir: string) => writeFileSync(join(dir, 'existing.json'), '{"a":2}'), 'modified existing.json'],
    ['a truncated file', (dir: string) => writeFileSync(join(dir, 'existing.json'), ''), 'modified existing.json'],
    ['a deleted file', (dir: string) => rmSync(join(dir, 'existing.json')), 'deleted existing.json'],
    ['a file replaced by a symlink', (dir: string) => { rmSync(join(dir, 'existing.json')); symlinkSync('/dev/null', join(dir, 'existing.json')); }, 'modified existing.json'],
  ])('reports %s', async (_label, act, expected) => {
    const dir = fakeConfig();
    try {
      const before = snapshotTree(dir);
      await new Promise((resolve) => setTimeout(resolve, 20)); // an mtime tick
      act(dir);
      expect(treeChanges(before, snapshotTree(dir))).toContain(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores only the live-writer paths, and still counts a test marker written there', () => {
    const dir = fakeConfig();
    try {
      const before = snapshotTree(dir);
      const markers = scanForMarkers(dir);
      writeFileSync(join(dir, 'stream-locks', 'cube', 'owner.json'), '{"beat":2}');
      writeFileSync(join(dir, 'lifecycle-log-state.json.123.abcdef.tmp'), 'x');
      expect(treeChanges(before, snapshotTree(dir))).toEqual([]);
      writeFileSync(join(dir, 'stream-locks', 'cube', 'owner.json'), `{"cube":"${TEST_MARKERS[3]}"}`);
      expect(scanForMarkers(dir)[TEST_MARKERS[3]]).toBe(markers[TEST_MARKERS[3]] + 1);
      expect(LIVE_WRITERS.some((pattern) => pattern.test('representative.json'))).toBe(false);
      expect(LIVE_WRITERS.some((pattern) => pattern.test('representative/state/CURRENT'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on an unreadable tree', () => {
    const dir = fakeConfig();
    try {
      mkdirSync(join(dir, 'sealed'));
      chmodSync(join(dir, 'sealed'), 0o000);
      expect(() => snapshotTree(dir)).toThrow();
      chmodSync(join(dir, 'sealed'), 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts markers in file contents, file names and SQLite databases, and never follows a link', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-scan-')));
    try {
      const config = join(root, 'config');
      mkdirSync(join(config, 'nested'), { recursive: true });
      expect(Object.values(scanForMarkers(config)).every((count) => count === 0)).toBe(true);
      writeFileSync(join(config, 'representative.json'), JSON.stringify({ cubeName: 'mock-cube', cubeId: TEST_MARKERS[0] }));
      mkdirSync(join(config, 'nested', 'borg-test-run-home-x'));
      const db = new DatabaseSync(join(config, 'nested', 'state.sqlite'));
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t VALUES (?)').run(`binding for ${TEST_MARKERS[1]}`);
      db.close();
      const outside = join(root, 'outside');
      writeFileSync(outside, TEST_MARKERS.join(' '));
      symlinkSync(outside, join(config, 'link'));
      const counts = scanForMarkers(config);
      expect(counts['mock-cube']).toBe(1);
      expect(counts[TEST_MARKERS[0]]).toBe(1);
      expect(counts[TEST_MARKERS[1]]).toBeGreaterThanOrEqual(1);
      expect(counts['borg-test-run-home-']).toBe(1);
      expect(counts['sha256:mock-server']).toBe(0); // only inside the link target
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a real vitest run under the guard', () => {
  // The protected directory is a fake one: the operator's configuration is never touched.
  const runFixture = (action: string) => {
    const dir = fakeConfig();
    try {
      const result = spawnSync(process.execPath, [join('node_modules', 'vitest', 'vitest.mjs'), 'run',
        '--config', '__tests__/fixtures/guard-run/vitest.config.ts'], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, BORG_TEST_GUARD_PROTECTED_CONFIG: dir, GUARD_FIXTURE_TARGET: dir, GUARD_FIXTURE_ACTION: action },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('passes when nothing touches the protected directory', () => {
    const run = runFixture('none');
    expect(run.output).not.toContain('wrote the real Borg config');
    expect(run.status).toBe(0);
  }, 120_000);

  it.each([
    ['create', 'created representative.json'],
    ['modify', 'modified existing.json'],
    ['delete', 'deleted existing.json'],
    ['child', 'created from-child'],
  ])('fails the run when a test (%s) writes marker-free content there', (action, expected) => {
    const run = runFixture(action);
    expect(run.output).toContain('wrote the real Borg config');
    expect(run.output).toContain(expected);
    expect(run.status).not.toBe(0);
  }, 120_000);
});
