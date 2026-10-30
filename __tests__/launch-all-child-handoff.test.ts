import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDefaultLaunchAllDeps } from '../src/launch-all-deps';
import { runLaunchAll } from '../src/launch-all-cmd';
import { inboxPathForDrone } from '../src/cubes';
import { legacyPidfilePathFor } from '../src/inbox-monitor';
import { activateAndBindSeat, mintPendingSeat } from '../src/seats';

describe('batch launch through the real borg child entrypoints', () => {
  it('reaches Codex startup for both worker and human seats only with an explicit force override', async () => {
    const root = process.env.HOME!;
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    const capture = join(root, 'codex-calls.jsonl');
    const entrypoint = join(process.cwd(), 'dist', 'claude.js');
    mkdirSync(repo);
    mkdirSync(bin);
    // This executable records the real child boundary. It deliberately refuses
    // app-server startup; this test neither invokes an installed CLI nor starts
    // a model session. Reaching --listen proves the live-monitor guard passed.
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2),
  expectation: process.env.BORG_LAUNCH_EXPECTED_SEAT,
}) + '\\n');
process.exit(23);
`, { mode: 0o700 });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    const cubeId = '11111111-1111-4111-8111-111111111111';
    const paths: string[] = [];
    for (let n = 1; n <= 2; n++) {
      const worktree = join(root, `drone-${n}`);
      git('worktree', 'add', '-b', `drone-${n}`, worktree);
      paths.push(worktree);
      const base = {
        origin: 'http://127.0.0.1:1', trustIdentity: 'spki-sha256:fixture', cubeId,
        roleId: '22222222-2222-4222-8222-222222222222',
        operation: { projectRoot: repo, kind: 'seat' as const, operationKey: String(n) },
      };
      const credential = `launch-handoff-${n}`.padEnd(43, 'x');
      const droneId = `0000000${n}-0000-4000-8000-000000000000`;
      await mintPendingSeat({ ...base, credential });
      await activateAndBindSeat({
        ...base, expectedPendingDigest: createHash('sha256').update(credential).digest('hex'),
        droneId, sessionId: `1000000${n}-0000-4000-8000-000000000000`,
        worktree, name: 'handoff', droneLabel: `drone-${n}`, isHumanSeat: n === 2,
      });
      const pidfile = legacyPidfilePathFor(inboxPathForDrone(cubeId, droneId));
      mkdirSync(join(pidfile, '..'), { recursive: true });
      writeFileSync(pidfile, String(process.pid));
    }
    const calls = () => readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const children: Array<{ status: number | null; stderr: string }> = [];
    const deps = {
      ...buildDefaultLaunchAllDeps(),
      runSync: (cmd: string, args: string[]) => {
        if (cmd === 'git') return execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' });
        if (cmd === 'tmux' && (args[0] === 'new-session' || args[0] === 'new-window')) return '@7\n';
        const terminalCommand = cmd === 'osascript'
          ? args[1].match(/set launchedTab to do script ("(?:\\.|[^"])*")/)?.[1]
          : undefined;
        const command = terminalCommand ? JSON.parse(terminalCommand)
          : cmd === 'tmux' && args[0] === 'send-keys' ? args[3] : undefined;
        if (command) {
          const result = spawnSync('/bin/sh', ['-c', command], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            input: '\n', encoding: 'utf8', timeout: 15_000,
          });
          children.push({ status: result.status, stderr: result.stderr });
        }
        return '';
      },
      isCliInstalled: () => true,
      runSyncExitCode: () => 1,
      probeAuthority: async () => {},
      probeSeat: async () => 'live' as const,
      getRoster: async () => ({ drones: [] }),
      platform: () => 'darwin' as const,
      isTTY: () => true,
      pathExists: (path: string) => path !== '/Applications/iTerm.app',
      getEnv: () => undefined,
      stdout: () => {}, stderr: () => {},
    };
    // Execute the dispatched commands for both explicit tmux and the default
    // worker-tmux/human-Terminal split, without opening operator windows.
    for (const { force, mode } of [false, true].flatMap((force) =>
      ['tmux' as const, undefined].map((mode) => ({ force, mode })))) {
      children.length = 0;
      writeFileSync(capture, '');
      await runLaunchAll({ cubeName: 'handoff', flags: {
        cli: 'codex', mode, force, yes: true, noAttach: true, launchDelayMs: 0,
      } }, { ...deps, readFileOpt: () => null }, {
        borgPath: entrypoint, now: () => 0, sleep: async () => {},
      });
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child.status).not.toBeNull();
        expect(child.stderr.includes('already has a live session')).toBe(!force);
      }
      const appServerCalls = calls().filter((call) => call.args.includes('--listen'));
      expect(new Set(appServerCalls.map((call) => call.cwd))).toEqual(new Set(force ? paths : []));
      for (const call of appServerCalls) {
        expect(call.args[0]).toBe('app-server');
        expect(call.args).not.toContain('--force');
        expect(JSON.parse(Buffer.from(call.expectation, 'base64url').toString()).cubeId).toBe(cubeId);
      }
    }
  });
});
