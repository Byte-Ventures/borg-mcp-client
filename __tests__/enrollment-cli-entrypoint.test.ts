import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];

async function invoke(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const fixture = await mkdtemp(join(tmpdir(), 'borg-enrollment-entry-'));
  fixtures.push(fixture);
  try {
    const result = await execFileAsync(process.execPath, ['dist/claude.js', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: fixture },
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

describe('shipped enrollment capabilities through the built CLI entrypoint', () => {
  it.each([
    ['assimilate', ['assimilate', '--enroll'], 'borg assimilate --enroll'],
    ['server cube init', ['server', 'cube', 'init', '--enroll'], 'borg server cube init --enroll'],
  ] as const)('routes %s hostless enrollment and fails closed without a TTY', async (_name, args, command) => {
    const result = await invoke([...args]);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Local enrollment requires an interactive operator terminal.',
    );
    expect(`${result.stdout}${result.stderr}`).toContain(command);
  });

  it('routes recover-enrollment to the journal-aware command', async () => {
    const result = await invoke(['recover-enrollment', '--yes']);
    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'No recoverable Borg enrollment transaction was found. No state was changed.',
    );
  });
});
