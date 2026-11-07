import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withOpenCodeV2StartupHost } from '../src/opencode-v2-startup-host.js';
import type { OpenCodeV2Server } from '../src/opencode-v2-server.js';

let root: string;
const worker = pathToFileURL(resolve('test/fixtures/opencode-startup-host-worker.mjs'));
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), 'borg-startup-host-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it('does not retain the queue when Borg dies before the supervisor loads', async () => {
  const owner = spawn(process.execPath, [resolve('test/fixtures/opencode-startup-host-owner.mjs'), root, 'early-exit'], { stdio: 'ignore' });
  await once(owner, 'exit');
  await vi.waitFor(() => expect(existsSync(join(root, 'supervisor-pid'))).toBe(true), { timeout: 15_000 });
  expect(existsSync(join(root, 'native-starting'))).toBe(false);
  await withOpenCodeV2StartupHost(async () => {}, { root, worker, waitMs: 1000 });
});

it.each(process.platform === 'win32' ? ['launcher'] : ['launcher', 'supervisor'])('keeps exclusion after %s termination until its starting native child stops', async target => {
  const owner = spawn(process.execPath, [resolve('test/fixtures/opencode-startup-host-owner.mjs'), root], { stdio: 'ignore' });
  const closed = once(owner, 'exit');
  try {
    await vi.waitFor(() => expect(existsSync(join(root, 'native-starting'))).toBe(true), { timeout: 15_000 });
    expect(existsSync(join(root, 'native-stopped'))).toBe(false);
    const supervisorPid = Number(readFileSync(join(root, 'supervisor-pid'), 'utf8'));
    const queued = vi.fn();
    const contender = withOpenCodeV2StartupHost(async () => {
      expect(existsSync(join(root, 'native-stopped'))).toBe(true);
    }, { root, worker, onQueued: queued });
    const assertion = expect(contender).resolves.toBeUndefined();
    await vi.waitFor(() => expect(queued).toHaveBeenCalled(), { timeout: 15_000 });
    if (target === 'launcher') owner.kill('SIGKILL');
    else process.kill(supervisorPid, 'SIGTERM');
    await closed;
    await assertion;
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    await closed;
    // Also wait for the supervisor to finish cleanup if an assertion failed.
    await withOpenCodeV2StartupHost(async () => {}, { root, worker });
  }
});

it('reports a bounded queue refusal without starting a second operation', async () => {
  let release!: () => void;
  let entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const held = withOpenCodeV2StartupHost(async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; });
  }, { root, worker });
  await acquired;
  const operation = vi.fn();
  try {
    await expect(withOpenCodeV2StartupHost(operation, { root, worker, waitMs: 10 })).rejects.toThrow('Timed out waiting for another Borg OpenCode 2');
    expect(operation).not.toHaveBeenCalled();
  } finally { release(); await held; }
});

it('releases startup exclusion while preserving the running server lease', async () => {
  let native: OpenCodeV2Server | undefined;
  try {
    native = await withOpenCodeV2StartupHost(host => host.startServer({
      installation: { executable: process.execPath, version: '2.2.5', major: 2, minor: 2, patch: 5, prerelease: null },
      directory: root, env: { ...process.env, BORG_STATE_ROOT: root, FIXTURE_BOOT_MS: '0' },
    }), { root, worker });
    await withOpenCodeV2StartupHost(async () => {
      expect((await fetch(`${native!.url}/api/info`)).ok).toBe(true);
      expect(existsSync(join(root, 'native-stopped'))).toBe(false);
    }, { root, worker });
    await native.close(); await native.closed;
    expect(existsSync(join(root, 'native-stopped'))).toBe(true);
    await native.close();
  } finally { await native?.close(); }
});

it('cleans up its owned native host when bootstrap rejects', async () => {
  await expect(withOpenCodeV2StartupHost(async host => {
    await host.startServer({
      installation: { executable: process.execPath, version: '2.2.5', major: 2, minor: 2, patch: 5, prerelease: null },
      directory: root, env: { ...process.env, BORG_STATE_ROOT: root, FIXTURE_BOOT_MS: '0' },
    });
    throw new Error('fixture bootstrap refusal');
  }, { root, worker })).rejects.toThrow('fixture bootstrap refusal');
  expect(existsSync(join(root, 'native-stopped'))).toBe(true);
  await withOpenCodeV2StartupHost(async () => {}, { root, worker });
});

it('preserves the executable-change signal across private IPC and reaps a refused host', async () => {
  await expect(withOpenCodeV2StartupHost(host => host.startServer({
    installation: { executable: process.execPath, version: '2.2.5', major: 2, minor: 2, patch: 5, prerelease: null },
    directory: root, env: { ...process.env, BORG_STATE_ROOT: root, FIXTURE_BOOT_MS: '0', FIXTURE_VERSION: '2.1.2' },
  }), { root, worker })).rejects.toMatchObject({ code: 'OPENCODE_EXECUTABLE_CHANGED' });
  expect(existsSync(join(root, 'native-stopped'))).toBe(true);
});
