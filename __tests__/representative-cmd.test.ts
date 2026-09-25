/**
 * Operator command for the Hermes / human representative connection. The Borg
 * backend is the controlled mock fixture; seat preparation is a stub of the
 * launch-free assimilate seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  BUILDER_ID,
  COORD_ID,
  CUBE_ID,
  MockCube,
  REP_ID,
  bindingFor,
} from './fixtures/representative-mock-backend.js';
import type { ActiveCube } from '../src/cubes.js';
import { bindingFingerprint, createRepresentativeStore } from '../src/representative-store.js';
import {
  DEFAULT_REPRESENTATIVE_ROLE,
  parseRepresentativeArgs,
  resolveRepresentativeContext,
  runRepresentativeMcp,
  runRepresentativePrepare,
  runRepresentativeStatus,
  type RepresentativeCmdDeps,
} from '../src/representative-cmd.js';
import {
  deliverRepresentativeReplies, readRepresentativeReplies, representativeStatus, sendRepresentativeMessage,
} from '../src/representative-core.js';
import { DroneEvictedError } from '../src/drone-lifecycle.js';
import { spawnSync } from 'node:child_process';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const SECRET = 'session-bearer-DO-NOT-LEAK';
let root: string;
let worktree: string;
let cube: MockCube;
let out: string;
let seat: ActiveCube | null;
let prepareCalls: Array<{ role: string; worktreeName?: string; host?: string }>;
let deps: RepresentativeCmdDeps;

function seatFor(path: string): ActiveCube {
  return {
    cubeId: CUBE_ID,
    droneId: REP_ID,
    name: 'mock-cube',
    sessionToken: SECRET,
    droneLabel: 'hermes-1',
    apiUrl: 'https://127.0.0.1:65530',
    serverTrustIdentity: 'sha256:mock-server',
    localSessionCredentialRef: 'ref-1',
    worktree: path,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-cmd-')));
  process.env.HOME = root;
  process.env.BORG_STATE_ROOT = root;
  worktree = join(root, 'hermes-worktree');
  cube = new MockCube();
  out = '';
  seat = seatFor(worktree);
  prepareCalls = [];
  deps = {
    cwd: () => worktree,
    findProjectRoot: (dir) => dir,
    hydrateSeat: async (dir) => (seat && dir === seat.worktree ? seat : null),
    prepareSeat: async (input) => {
      prepareCalls.push(input);
      seat = seatFor(worktree);
      return { code: 0, worktree };
    },
    backendFor: () => cube.backend(),
    store: createRepresentativeStore(join(root, '.config', 'borgmcp', 'representative.json')),
    stdout: (text) => { out += text; },
    stderr: (text) => { out += text; },
  };
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  rmSync(root, { recursive: true, force: true });
});

const prepare = (overrides: Record<string, unknown> = {}) => runRepresentativePrepare({
  action: 'prepare', coordinator: 'coordinator-1', role: DEFAULT_REPRESENTATIVE_ROLE, rebind: false, ...overrides,
} as never, deps);

describe('argument parsing', () => {
  it('requires an explicit Coordinator and rejects unknown or credential-bearing flags', () => {
    expect(parseRepresentativeArgs(['prepare'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs(['prepare', '--coordinator', 'coordinator-1'])).toEqual({
      ok: true,
      command: { action: 'prepare', coordinator: 'coordinator-1', role: DEFAULT_REPRESENTATIVE_ROLE, rebind: false },
    });
    expect(parseRepresentativeArgs(['prepare', '--coordinator', 'c', '--token', 'x'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs(['mcp', '--worktree', '/abs/path'])).toEqual({
      ok: true, command: { action: 'mcp', worktree: '/abs/path' },
    });
    expect(parseRepresentativeArgs(['mcp', '--worktree', 'relative'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs(['dispatch'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs([])).toMatchObject({ ok: false });
  });
});

describe('prepare', () => {
  it('refuses a different explicit host before a subsequent send can reach the saved destination', async () => {
    expect(await prepare({ host: 'different-server:9999' })).toBe(1);
    await expect(resolveRepresentativeContext(worktree, deps).then((ctx) => sendRepresentativeMessage(ctx, {
      kind: 'request', authorization: 'user_authorized', message: 'Only for the requested server',
    }))).rejects.toMatchObject({ code: 'NOT_PREPARED' });
    expect(cube.appendCalls).toEqual([]);
    expect(prepareCalls).toEqual([]);
  });

  it('routes a locally saved evicted connection through preparation before live binding', async () => {
    let evicted = true;
    const backend = cube.backend();
    const whoami = backend.whoami;
    backend.whoami = async () => { if (evicted) throw new DroneEvictedError(); return whoami(); };
    deps.backendFor = () => backend;
    deps.prepareSeat = async (input) => { prepareCalls.push(input); evicted = false; return { code: 0, worktree }; };
    expect(await prepare()).toBe(0);
    expect(prepareCalls).toHaveLength(1);
  });
  it('binds the existing dedicated seat to exactly the named Coordinator without launching or leaking the bearer', async () => {
    expect(await prepare()).toBe(0);
    expect(prepareCalls).toEqual([{ role: DEFAULT_REPRESENTATIVE_ROLE, coordinator: 'coordinator-1', resume: true }]);
    const binding = await deps.store.getBinding(worktree);
    expect(binding).toMatchObject({
      cubeId: CUBE_ID, representativeDroneId: REP_ID, coordinatorDroneId: COORD_ID, coordinatorLabel: 'coordinator-1',
    });
    expect(out).toContain('borg representative mcp');
    expect(out).toContain(worktree);
    expect(out).not.toContain(SECRET);
    expect(JSON.stringify(binding)).not.toContain(SECRET);
  });

  it('prepares a launch-free seat under the representative role when the worktree has none', async () => {
    seat = null;
    expect(await prepare({ worktreeName: 'hermes', host: 'localhost:7999' })).toBe(0);
    expect(prepareCalls).toEqual([{ role: DEFAULT_REPRESENTATIVE_ROLE, coordinator: 'coordinator-1', worktreeName: 'hermes', host: 'localhost:7999' }]);
    expect((await deps.store.getBinding(worktree))?.coordinatorDroneId).toBe(COORD_ID);
  });

  it('binds under the canonical worktree when prepare runs through a symlinked path, so status and mcp find it', async () => {
    mkdirSync(worktree);
    const link = join(root, 'hermes-link');
    symlinkSync(worktree, link);
    deps.cwd = () => link;
    expect(await prepare()).toBe(0);
    expect(await deps.store.getBinding(link)).toBeNull();
    expect((await deps.store.getBinding(worktree))?.worktree).toBe(worktree);
    out = '';
    expect(await runRepresentativeStatus({ action: 'status', worktree: link }, deps)).toBe(0);

    // A freshly prepared seat reported through the symlink is canonicalized the same way.
    const freshRoot = join(root, 'fresh-worktree');
    mkdirSync(freshRoot);
    const freshLink = join(root, 'fresh-link');
    symlinkSync(freshRoot, freshLink);
    seat = null;
    deps.cwd = () => root;
    deps.prepareSeat = async () => { seat = seatFor(freshRoot); return { code: 0, worktree: freshLink }; };
    expect(await prepare({ worktreeName: 'fresh' })).toBe(0);
    expect((await deps.store.getBinding(freshRoot))?.worktree).toBe(freshRoot);
  });

  it('fails clearly for a missing Coordinator and saves nothing', async () => {
    expect(await prepare({ coordinator: 'coordinator-9' })).toBe(1);
    expect(out).toContain('COORDINATOR_NOT_FOUND');
    expect(await deps.store.getBinding(worktree)).toBeNull();
  });

  it('refuses to reuse the human seat itself as the representative', async () => {
    cube.drones[0].role_id = cube.roles[1].id;
    expect(await prepare()).toBe(1);
    expect(out).toContain('REPRESENTATIVE_ROLE_NOT_PERMITTED');
    expect(await deps.store.getBinding(worktree)).toBeNull();
  });

  it('refuses a seat whose role differs from the requested representative role', async () => {
    cube.drones[0].role_id = cube.roles[2].id;
    expect(await prepare()).toBe(1);
    expect(out).toContain('REPRESENTATIVE_ROLE_MISMATCH');
  });

  it('starts a new generation on an explicit same-selection rebind, visible in every fingerprint surface', async () => {
    const initial = bindingFor(worktree);
    await deps.store.saveBinding(initial, { rebind: false });
    expect(await prepare({ rebind: true })).toBe(0);
    const rebound = (await deps.store.getBinding(worktree))!;
    expect(rebound.boundAt).not.toBe(initial.boundAt);
    const fingerprint = bindingFingerprint(rebound);
    expect(fingerprint).not.toBe(bindingFingerprint(initial));
    const ctx = await resolveRepresentativeContext(worktree, deps);
    const entry = cube.post(COORD_ID, 'reply', [REP_ID]);
    expect((await representativeStatus(ctx)).binding_fingerprint).toBe(fingerprint);
    expect((await readRepresentativeReplies(ctx, {})).binding_fingerprint).toBe(fingerprint);
    expect((await deliverRepresentativeReplies(ctx, { through: entry.id })).binding_fingerprint).toBe(fingerprint);
    expect((await sendRepresentativeMessage(ctx, { kind: 'question', authorization: 'model_advice', message: 'hi' })).binding_fingerprint)
      .toBe(fingerprint);
    // An ordinary resume without --rebind keeps the generation.
    expect(await prepare()).toBe(0);
    expect((await deps.store.getBinding(worktree))!.boundAt).toBe(rebound.boundAt);
  });

  it('requires --rebind to change the Coordinator', async () => {
    expect(await prepare()).toBe(0);
    cube.drones.push({ id: BUILDER_ID.replace(/4/g, '7'), label: 'coordinator-2', role_id: cube.roles[1].id });
    expect(await prepare({ coordinator: 'coordinator-2' })).toBe(1);
    expect(out).toContain('BINDING_CONFLICT');
    expect((await deps.store.getBinding(worktree))?.coordinatorLabel).toBe('coordinator-1');
    expect(await prepare({ coordinator: 'coordinator-2', rebind: true })).toBe(0);
    expect((await deps.store.getBinding(worktree))?.coordinatorLabel).toBe('coordinator-2');
  });
});

describe('connection context', () => {
  it('executes the printed recovery command with the bound Coordinator and custom role', async () => {
    mkdirSync(worktree);
    const binding = bindingFor(worktree, { representativeRoleName: 'relay-custom' });
    cube.roles[0].name = 'relay-custom';
    await deps.store.saveBinding(binding, { rebind: false });
    seat = null;
    let message = '';
    try { await resolveRepresentativeContext(worktree, deps); } catch (error) { message = (error as Error).message; }
    const command = message.match(/`([^`]+)`/)?.[1];
    expect(command).toBeDefined();
    const shell = spawnSync('/bin/bash', ['-c', 'borg() { printf "%s\\0" "$PWD" "$@"; }; eval "$1"', 'recovery-control', command!], { encoding: 'utf8' });
    expect(shell.status).toBe(0);
    const [cwd, , ...args] = shell.stdout.split('\0').filter(Boolean);
    expect(cwd).toBe(worktree);
    const parsed = parseRepresentativeArgs(args);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.command.action !== 'prepare') throw new Error('invalid recovery command');
    expect(parsed.command.coordinator).toBe(binding.coordinatorLabel);
    expect(parsed.command.role).toBe(binding.representativeRoleName);
    expect(await runRepresentativePrepare(parsed.command, deps)).toBe(0);
  });
  it('fails closed when nothing is prepared', async () => {
    await expect(resolveRepresentativeContext(worktree, deps)).rejects.toMatchObject({ code: 'NOT_PREPARED' });
  });

  it('fails closed when the saved seat is gone or no longer the bound drone', async () => {
    await deps.store.saveBinding(bindingFor(worktree), { rebind: false });
    seat = null;
    await expect(resolveRepresentativeContext(worktree, deps)).rejects.toMatchObject({ code: 'SEAT_UNAVAILABLE' });
    seat = { ...seatFor(worktree), droneId: BUILDER_ID };
    await expect(resolveRepresentativeContext(worktree, deps)).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
    seat = { ...seatFor(worktree), serverTrustIdentity: 'sha256:other-server' };
    await expect(resolveRepresentativeContext(worktree, deps)).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
  });

  it('status reports the live binding without the bearer', async () => {
    await prepare();
    out = '';
    expect(await runRepresentativeStatus({ action: 'status' }, deps)).toBe(0);
    expect(out).toContain('coordinator-1');
    expect(out).not.toContain(SECRET);
  });
});

describe('served MCP process', () => {
  it.each([
    ['a changed Coordinator', { coordinator: 'coordinator-2', rebind: true }],
    ['the same selection', { rebind: true }],
  ] as const)('pins the prepared generation, and fails calls closed after a rebind to %s until restarted', async (_label, rebind) => {
    await prepare();
    const pinnedFingerprint = bindingFingerprint((await deps.store.getBinding(worktree))!);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const responses = new Map<number, (message: any) => void>();
    let buffered = '';
    stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let index: number;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line.trim()) {
          const message = JSON.parse(line);
          responses.get(message.id)?.(message);
        }
      }
    });
    const rpc = (id: number, method: string, params: unknown) => {
      const response = new Promise<any>((resolve) => responses.set(id, resolve));
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    };
    const pinnedSeats: string[] = [];
    const exit = runRepresentativeMcp({ action: 'mcp', worktree }, deps, {
      version: '0.0.0-test', stdin, stdout, pinSeat: (active) => { pinnedSeats.push(active.droneId); },
    });
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'host', version: '0' } });
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    expect(pinnedSeats).toEqual([REP_ID]);

    const send = { name: 'borg_representative-send', arguments: { kind: 'request', authorization: 'user_authorized', message: 'Do X.' } };
    const before = await rpc(2, 'tools/call', send);
    expect(before.result.isError).toBeUndefined();
    expect(cube.appendCalls.map((call) => call.to)).toEqual([[COORD_ID]]);

    const reply = cube.post(COORD_ID, 'reply', [REP_ID]);
    cube.drones.push({ id: '77777777-7777-4777-8777-777777777777', label: 'coordinator-2', role_id: cube.roles[1].id });
    try {
      expect(await prepare(rebind)).toBe(0);
      const currentFingerprint = bindingFingerprint((await deps.store.getBinding(worktree))!);
      expect(currentFingerprint).not.toBe(pinnedFingerprint);
      const calls = cube.calls.length;
      const refused = [
        { ...send, arguments: { ...send.arguments, message: 'Do Y.' } },
        { name: 'borg_representative-read', arguments: {} },
        { name: 'borg_representative-deliver', arguments: { through: reply.id } },
        { name: 'borg_representative-ack', arguments: { entry_id: reply.id } },
      ];
      for (const [index, call] of refused.entries()) {
        const after = await rpc(3 + index, 'tools/call', call);
        expect(after.result.isError).toBe(true);
        expect(JSON.parse(after.result.content[0].text).error.code).toBe('BINDING_MISMATCH');
      }
      expect(cube.appendCalls).toHaveLength(1);
      expect(cube.acks).toEqual([]);
      expect(cube.calls).toHaveLength(calls); // no network call at all after the rebind
      // Status stays available and names both generations.
      const status = await rpc(10, 'tools/call', { name: 'borg_representative-status', arguments: {} });
      expect(status.result.isError).toBeUndefined();
      expect(JSON.parse(status.result.content[0].text)).toMatchObject({
        binding_fingerprint: currentFingerprint, pinned_binding_fingerprint: pinnedFingerprint,
      });
    } finally {
      stdin.end();
      expect(await exit).toBe(0);
    }
  });
});
