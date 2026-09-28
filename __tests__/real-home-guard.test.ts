/** Controls for the real-HOME guard (__tests__/global/real-home-guard.ts). */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TEST_MARKERS, realBorgConfig, scanForMarkers } from './global/real-home-guard.js';
import { borgConfigRoot } from '../src/private-root.js';

describe('the run never resolves Borg state under the real home', () => {
  const real = userInfo().homedir;
  it('gives this worker a private HOME', () => {
    expect(homedir()).not.toBe(real);
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

describe('the marker scan', () => {
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
