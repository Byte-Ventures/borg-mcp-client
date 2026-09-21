import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];

async function invoke(args: (fixture: string) => string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'borg-representative-entry-')));
  fixtures.push(fixture);
  try {
    const result = await execFileAsync(process.execPath, [join(process.cwd(), 'dist/claude.js'), ...args(fixture)], {
      cwd: fixture,
      env: { ...process.env, HOME: fixture, BORG_STATE_ROOT: fixture },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe('borg representative through the built CLI entrypoint', () => {
  it('refuses to serve MCP for an unprepared worktree and keeps stdout free of non-protocol output', async () => {
    const result = await invoke((fixture) => ['representative', 'mcp', '--worktree', fixture]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('NOT_PREPARED');
  });

  it('never picks a Coordinator when none is named', async () => {
    const result = await invoke(() => ['representative', 'prepare']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--coordinator <drone-label> is required');
  });

  it('prints help that defines the representative role', async () => {
    const result = await invoke(() => ['representative', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('human representative');
    expect(result.stdout).toContain('no background wake');
  });
});
