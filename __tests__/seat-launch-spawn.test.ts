import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultSeatCommandDeps } from '../src/seat-commands';
import { BORG_LAUNCH_EXPECTED_SEAT_ENV } from '../src/cubes';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

describe('targeted launch subprocess', () => {
  it.each([undefined, 'claude', 'codex', 'opencode'] as const)('carries CLI %s and the expected identity into the child', async (cli) => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0, null));
      return child as ReturnType<typeof spawn>;
    });
    const expectation = {
      credentialRef: 'borg-server-session:' + 'a'.repeat(64),
      cubeId: '11111111-1111-1111-1111-111111111111',
      droneId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      droneLabel: 'builder',
      worktree: '/work/builder',
    };
    expect(await buildDefaultSeatCommandDeps().launchBareBorg('/work/builder', expectation, cli)).toBe(0);
    const [executable, args, options] = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(executable).toBe(process.argv[1]);
    expect(args).toEqual(cli ? ['--cli', cli] : []);
    expect(options).toMatchObject({ cwd: '/work/builder', stdio: 'inherit', shell: false });
    const encoded = (options as { env: NodeJS.ProcessEnv }).env[BORG_LAUNCH_EXPECTED_SEAT_ENV]!;
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(expectation);
  });
});
