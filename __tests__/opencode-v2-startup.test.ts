import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withOpenCodeV2Startup } from '../src/opencode-v2-startup';

let root: string;
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'borg-opencode-startup-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it('queues concurrent bootstraps until the previous complete startup releases', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered: string[] = [];
  const first = withOpenCodeV2Startup(async () => { entered.push('first'); await held; }, { root });
  await vi.waitFor(() => expect(entered).toEqual(['first']));
  const queued = vi.fn();
  const second = withOpenCodeV2Startup(async () => { entered.push('second'); }, { root, onQueued: queued });
  try {
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    expect(entered).toEqual(['first']);
  } finally { release(); await Promise.all([first, second]); }
  expect(entered).toEqual(['first', 'second']);
});

it('does not serialize unrelated private database roots', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const first = withOpenCodeV2Startup(async () => { entered = true; await held; }, { root });
  await vi.waitFor(() => expect(entered).toBe(true));
  try {
    await expect(withOpenCodeV2Startup(async () => 'independent', { root: join(root, 'other') })).resolves.toBe('independent');
  } finally { release(); await first; }
});

it('releases the mutex after a failed startup', async () => {
  await expect(withOpenCodeV2Startup(async () => { throw new Error('startup failure'); }, { root })).rejects.toThrow('startup failure');
  await expect(withOpenCodeV2Startup(async () => 'next launch', { root })).resolves.toBe('next launch');
});

it('bounds queue waiting without running a contender or blocking its owner', async () => {
  let release!: () => void;
  let entered = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = withOpenCodeV2Startup(async () => { entered = true; await held; }, { root });
  await vi.waitFor(() => expect(entered).toBe(true));
  const contender = vi.fn();
  try {
    await expect(withOpenCodeV2Startup(contender, { root, waitMs: 15 })).rejects.toThrow('No kickoff was submitted');
    expect(contender).not.toHaveBeenCalled();
  } finally { release(); await first; }
});

it('uses a cross-process mutex that releases after its holder is killed', async () => {
  const child = spawn(process.execPath, [resolve('test/fixtures/opencode-startup-lock-child.mjs'), root],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  const closed = once(child, 'exit');
  let waiting: Promise<string> | undefined;
  try {
    await vi.waitFor(() => expect(output, diagnostic).toContain('locked'), { timeout: 10_000 });
    const queued = vi.fn();
    waiting = withOpenCodeV2Startup(async () => 'recovered', { root, onQueued: queued });
    await Promise.race([
      vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1), { timeout: 10_000 }),
      waiting.then(() => { throw new Error('Contender entered while the holder was still running'); }),
    ]);
    child.kill('SIGKILL');
    await closed;
    await expect(waiting).resolves.toBe('recovered');
    expect(existsSync(join(root, 'opencode-v2-startup.sqlite'))).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await waiting?.catch(() => {});
  }
});

it.skipIf(process.platform === 'win32')('refuses a substituted mutex path', async () => {
  const target = join(root, 'operator-file');
  writeFileSync(target, 'preserve this', { mode: 0o600 });
  symlinkSync(target, join(root, 'opencode-v2-startup.sqlite'));
  const operation = vi.fn();
  await expect(withOpenCodeV2Startup(operation, { root })).rejects.toThrow('private regular file');
  expect(operation).not.toHaveBeenCalled();
});
