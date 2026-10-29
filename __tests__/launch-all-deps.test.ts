import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDefaultLaunchAllDeps } from '../src/launch-all-deps.js';
import { runTerminalsBackend } from '../src/backends/launch-all-terminals.js';
import type { DroneCandidate } from '../src/launch-all-discovery.js';
import type { ActiveCube } from '../src/cubes.js';
import { defaultProbeSeat } from '../src/seat-probe.js';
import { detectCliAvailability } from '../src/cli-platform.js';

vi.mock('../src/seat-probe.js', () => ({ defaultProbeSeat: vi.fn() }));
vi.mock('../src/cli-platform.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/cli-platform.js')>(),
  detectCliAvailability: vi.fn(),
}));

describe('batch launch production dependencies', () => {
  it('uses installed executable discovery for the explicit CLI preflight', () => {
    vi.mocked(detectCliAvailability).mockReturnValue({ claude: '/bin/claude', codex: null, opencode: '/bin/opencode' });
    const deps = buildDefaultLaunchAllDeps();
    expect(deps.isCliInstalled('claude')).toBe(true);
    expect(deps.isCliInstalled('codex')).toBe(false);
    expect(deps.isCliInstalled('opencode')).toBe(true);
  });
  it.each(['indeterminate', 'unreachable', 'server-failure'] as const)(
    'clears a cached worker classification when the identity probe returns %s', async (status) => {
      vi.mocked(defaultProbeSeat).mockResolvedValueOnce(status);
      const seat = { isHumanSeat: false } as ActiveCube;
      expect(await buildDefaultLaunchAllDeps().probeSeat(seat)).toBe(status);
      expect(seat.isHumanSeat).toBeUndefined();
    },
  );

  it('replaces cached metadata with the authenticated human-seat identity', async () => {
    vi.mocked(defaultProbeSeat).mockImplementationOnce(async (_seat, onIdentity) => {
      onIdentity?.({ is_human_seat: true });
      return 'live';
    });
    const seat = { isHumanSeat: false } as ActiveCube;
    expect(await buildDefaultLaunchAllDeps().probeSeat(seat)).toBe('live');
    expect(seat.isHumanSeat).toBe(true);
  });

  it('does not retain cached metadata when the server omits the classification', async () => {
    vi.mocked(defaultProbeSeat).mockImplementationOnce(async (_seat, onIdentity) => {
      onIdentity?.({});
      return 'live';
    });
    const seat = { isHumanSeat: false } as ActiveCube;
    await buildDefaultLaunchAllDeps().probeSeat(seat);
    expect(seat.isHumanSeat).toBeUndefined();
  });

  it('reports terminal spawn errors', async () => {
    await expect(buildDefaultLaunchAllDeps().spawnDetached('/nonexistent-borg-terminal', []))
      .rejects.toThrow(/ENOENT/);
  });

  it('starts the second terminal while the first terminal process remains open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'borg-terminal-concurrency-'));
    const release = join(directory, 'release');
    const fixture = join(directory, 'terminal.cjs');
    writeFileSync(fixture, `
      const fs = require('node:fs');
      const [directory, id] = process.argv.slice(2);
      fs.writeFileSync(directory + '/' + id + '.started', '');
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        if (fs.existsSync(directory + '/release') || Date.now() >= deadline) {
          clearInterval(timer);
          fs.writeFileSync(directory + '/' + id + '.finished', '');
        }
      }, 10);
    `);
    const production = buildDefaultLaunchAllDeps();
    let dispatched = 0;
    const started = [0, 1].map((id) => join(directory, `${id}.started`));
    const finished = [0, 1].map((id) => join(directory, `${id}.finished`));
    const waitFor = async (files: string[]) => {
      const deadline = Date.now() + 3000;
      while (!files.every((file) => existsSync(file)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(files.every((file) => existsSync(file))).toBe(true);
    };
    try {
      await runTerminalsBackend([0, 1].map((id) => ({
        worktreeDir: directory, droneId: `drone-${id}`, droneLabel: `drone-${id}`, cubeId: 'cube',
      } as DroneCandidate)), {
        borgPath: '/unused', platform: 'linux', cubeName: 'test', launchedAtISO: '',
        launchDelayMs: 0, sleep: async () => {},
      }, {
        ...production,
        getEnv: (name) => name === 'BORG_TERMINAL' ? 'test-terminal' : undefined,
        runSync: () => { throw new Error('terminal dispatch must not wait for process exit'); },
        spawnDetached: async () => {
          await production.spawnDetached(process.execPath, [fixture, directory, String(dispatched++)]);
        },
        mkdirp: () => {}, writeFile: () => {},
      });
      await waitFor(started);
      expect(finished.some((file) => existsSync(file))).toBe(false);
    } finally {
      writeFileSync(release, '');
      if (dispatched === 2) await waitFor(finished);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
