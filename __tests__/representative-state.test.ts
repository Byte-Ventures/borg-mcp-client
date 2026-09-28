/**
 * Controls for the representative state database (6.0 S1): C1 path checks,
 * RESET-2a read-only status, C3 warning filter, RESET-2b re-targeting,
 * Security (a) data-free publish mutex and (b) non-recursive retention, crash
 * points in publication, concurrent resets and first creations, a real
 * multi-process stress run, version refusal and reset-state.
 * Cross-process controls run real separate Node processes over one private root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  RepresentativeStateError, createRepresentativeState, isSqliteCorruption, readCurrent, representativeStateRoot,
  resetRepresentativeState, withPublishMutex, cleanupGenerations,
} from '../src/representative-db.js';
import { bindingFingerprint, createRepresentativeStore, parseBinding } from '../src/representative-store.js';
import { seatKey } from '../src/representative-legacy.js';
import { runRepresentativeResetState } from '../src/representative-cmd.js';
import { deliverRepresentativeReplies, readRepresentativeReplies, sendRepresentativeMessage } from '../src/representative-core.js';
import { COORD_ID, MockCube, REP_ID, bindingFor } from './fixtures/representative-mock-backend.js';
import { corruptTable, notADatabase } from './fixtures/representative-state.js';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const CHILD = resolve('__tests__/fixtures/representative-state-child.ts');
let root: string;
let stateRoot: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-state-')));
  process.env.HOME = root;
  process.env.BORG_STATE_ROOT = root;
  stateRoot = representativeStateRoot();
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT; else process.env.BORG_STATE_ROOT = originalStateRoot;
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => lstatSync(path).mode & 0o777;
const generations = () => readdirSync(stateRoot).filter((name) => /^g\d{17}-[0-9a-f]{16}$/.test(name)).sort();
const databaseOf = (gen: string) => join(stateRoot, gen, 'state.sqlite');
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'NO_ERROR'; } catch (error) { return (error as { code?: string }).code ?? `UNTYPED ${String(error)}`; }
}
const bind = (worktree: string, boundAt = '2026-01-01T00:00:00.000Z') => bindingFor(worktree, { boundAt });

/** Save one prepared binding in this process and close the handle (last writer gone). */
async function prepareBinding(worktree = '/work/a', boundAt?: string): Promise<void> {
  const store = createRepresentativeStore();
  await store.saveBinding(bind(worktree, boundAt), { rebind: true });
  store.state.close();
}

function childEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
  return { ...env, HOME: root, BORG_STATE_ROOT: root };
}
function child(args: string[]): { done: Promise<{ code: number | null; signal: string | null; out: any; stderr: string }> } {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk; });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<{ code: number | null; signal: string | null; out: any; stderr: string }>((resolveDone) => {
    proc.on('exit', (code, signal) => {
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      let out: unknown = null;
      try { out = line ? JSON.parse(line) : null; } catch { out = line; }
      resolveDone({ code, signal, out, stderr });
    });
  });
  return { done };
}
const run = async (args: string[]) => child(args).done;
async function waitFile(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function rowsOf(gen: string, table: string): unknown[] {
  const db = new DatabaseSync(databaseOf(gen), { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(); } finally { db.close(); }
}
const resetOptions = {
  validateBinding: parseBinding,
  generationOf: bindingFingerprint as never,
  seatOf: seatKey as never,
};

describe('layout and first creation', () => {
  it('publishes one private generation behind CURRENT on first use, with a data-free publish mutex', async () => {
    await prepareBinding();
    const [gen] = generations();
    expect(readCurrent(stateRoot)).toBe(gen);
    expect(readFileSync(join(stateRoot, 'CURRENT'), 'utf8')).toBe(`${gen}\n`);
    for (const directory of [stateRoot, join(stateRoot, gen)]) expect(mode(directory)).toBe(0o700);
    for (const file of ['CURRENT', 'publish.sqlite']) expect(mode(join(stateRoot, file))).toBe(0o600);
    expect(readdirSync(stateRoot).sort()).toEqual(['CURRENT', gen, 'publish.sqlite'].sort());
    expect(readdirSync(join(stateRoot, gen))).toEqual(['state.sqlite']); // the last writer closed: no sidecars
    expect(mode(databaseOf(gen))).toBe(0o600);
  });

  it('lets SQLite create WAL sidecars only as 0600 files', async () => {
    const store = createRepresentativeStore();
    await store.saveBinding(bind('/work/a'), { rebind: false });
    const [gen] = generations();
    const names = readdirSync(join(stateRoot, gen)).sort();
    expect(names).toEqual(['state.sqlite', 'state.sqlite-shm', 'state.sqlite-wal']);
    for (const name of names) expect(mode(join(stateRoot, gen, name))).toBe(0o600);
    store.state.close();
  });

  it('names generations in strictly increasing order even within one millisecond or with a clock set back', async () => {
    const fixed = new Date('2026-09-28T12:00:00.000Z');
    await createRepresentativeState({ now: () => fixed }).transact(() => {});
    const first = readCurrent(stateRoot)!;
    const seen = [first];
    for (let i = 0; i < 3; i += 1) {
      corruptTable(readCurrent(stateRoot)!);
      const back = new Date(fixed.getTime() - 60_000 * (i + 1));
      await resetRepresentativeState({ ...resetOptions, now: () => back });
      seen.push(readCurrent(stateRoot)!);
    }
    expect([...seen].sort()).toEqual(seen);
    expect(new Set(seen.map((name) => name.slice(0, 18))).size).toBe(4);
  });

  it('creates exactly one generation when eight processes race the first use', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run(['bind', `/work/race-${i}`, `2026-01-0${i + 1}T00:00:00.000Z`])));
    for (const result of results) expect(result.code).toBe(0);
    const gens = generations();
    expect(gens).toHaveLength(1);
    expect(new Set(results.map((result) => result.out.current))).toEqual(new Set(gens));
    expect((rowsOf(gens[0], 'bindings') as Array<{ worktree: string }>).map((row) => row.worktree).sort())
      .toEqual(Array.from({ length: 8 }, (_, i) => `/work/race-${i}`).sort());
  }, 120_000);
});

describe('one worktree per binding generation', () => {
  it('refuses a second worktree claiming a generation another worktree holds, changing nothing', async () => {
    await prepareBinding('/work/a');
    const store = createRepresentativeStore();
    await expect(store.saveBinding(bind('/work/b'), { rebind: true })).rejects.toMatchObject({ code: 'BINDING_CONFLICT' });
    expect((await store.listBindings()).map((binding) => binding.worktree)).toEqual(['/work/a']);
    store.state.close();
  });
});

describe('C1: every open lstat-validates the directory and the three database files', () => {
  let gen: string;
  let outside: string;
  beforeEach(async () => {
    await prepareBinding();
    gen = readCurrent(stateRoot)!;
    outside = join(root, 'outside');
    writeFileSync(outside, 'OUTSIDE', { mode: 0o600 });
  });
  const refuse = async (reason: RegExp) => {
    const state = createRepresentativeState();
    const error = await state.transact(() => 'wrote').then(() => null, (e) => e);
    expect(error).toBeInstanceOf(RepresentativeStateError);
    expect(error.code).toBe('REPRESENTATIVE_STATE_INVALID');
    expect(error.details.reason).toMatch(reason);
    expect(await codeOf(createRepresentativeStore().getBinding('/work/a'))).toBe('REPRESENTATIVE_STATE_INVALID');
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE');
    expect(generations()).toEqual([gen]); // never repaired or recreated
  };

  it.each(['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm'])('refuses a symlink at %s', async (name) => {
    const path = join(stateRoot, gen, name);
    if (name === 'state.sqlite') {
      const kept = join(root, 'kept.sqlite');
      writeFileSync(kept, readFileSync(path), { mode: 0o600 });
      rmSync(path);
      symlinkSync(kept, path);
    } else {
      symlinkSync(outside, path);
    }
    await refuse(/not a regular file/);
  });

  it.each(['state.sqlite-wal', 'state.sqlite-shm'])('refuses a 0644 %s', async (name) => {
    writeFileSync(join(stateRoot, gen, name), '', { mode: 0o600 });
    chmodSync(join(stateRoot, gen, name), 0o644);
    await refuse(/mode 644/);
  });

  it('refuses a directory at the database path', async () => {
    rmSync(databaseOf(gen));
    mkdirSync(databaseOf(gen), { mode: 0o700 });
    await refuse(/not a regular file/);
  });

  it('refuses a generation directory that is not 0700', async () => {
    chmodSync(join(stateRoot, gen), 0o755);
    await refuse(/mode 755/);
  });

  it('refuses a symlinked generation directory', async () => {
    const moved = join(root, 'moved-generation');
    const { renameSync } = await import('node:fs');
    renameSync(join(stateRoot, gen), moved);
    symlinkSync(moved, join(stateRoot, gen));
    await refuse(/not a directory/);
  });

  it('refuses a symlinked or damaged CURRENT and never recreates it', async () => {
    writeFileSync(join(stateRoot, 'CURRENT'), 'garbage\n', { mode: 0o600 });
    await refuse(/unrecognised content/);
    rmSync(join(stateRoot, 'CURRENT'));
    symlinkSync(outside, join(stateRoot, 'CURRENT'));
    await refuse(/not a regular file/);
  });

  it('refuses a CURRENT naming a missing generation and publishes nothing in its place', async () => {
    rmSync(join(stateRoot, gen), { recursive: true });
    const error = await createRepresentativeState().transact(() => 'wrote').then(() => null, (e) => e);
    expect(error?.code).toBe('REPRESENTATIVE_STATE_INVALID');
    expect(generations()).toEqual([]);
    expect(readCurrent(stateRoot)).toBe(gen);
  });

  it('refuses a state root that is not private', async () => {
    chmodSync(stateRoot, 0o755);
    expect(await codeOf(createRepresentativeState().transact(() => 'wrote'))).not.toBe('NO_ERROR');
    expect(await codeOf(createRepresentativeStore().getBinding('/work/a'))).not.toBe('NO_ERROR');
  });
});

describe('RESET-2a: status is read-only', () => {
  it('reads an initialized database whose last writer closed without writing a row; any sidecar is 0600', async () => {
    await prepareBinding();
    const gen = readCurrent(stateRoot)!;
    expect(readdirSync(join(stateRoot, gen))).toEqual(['state.sqlite']);
    const before = { db: sha(databaseOf(gen)), current: sha(join(stateRoot, 'CURRENT')), tree: readdirSync(stateRoot).sort() };
    const store = createRepresentativeStore();
    expect((await store.getBinding('/work/a'))?.worktree).toBe('/work/a');
    expect(await store.readRequests('/work/a')).toEqual([]);
    expect((await store.listBindings()).map((binding) => binding.worktree)).toEqual(['/work/a']);
    store.state.close();
    expect(sha(databaseOf(gen))).toBe(before.db);
    expect(sha(join(stateRoot, 'CURRENT'))).toBe(before.current);
    expect(readdirSync(stateRoot).sort()).toEqual(before.tree);
    for (const name of readdirSync(join(stateRoot, gen))) {
      expect(['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']).toContain(name);
      expect(mode(join(stateRoot, gen, name))).toBe(0o600);
    }
    // The database is still an ordinary writable database (never marked immutable).
    await prepareBinding('/work/b', '2026-01-02T00:00:00.000Z');
    expect((rowsOf(gen, 'bindings') as Array<{ worktree: string }>).map((row) => row.worktree)).toEqual(['/work/a', '/work/b']);
  });

  it('creates no state directory, CURRENT, generation or database when nothing is initialized', async () => {
    const store = createRepresentativeStore();
    expect(await store.getBinding('/work/a')).toBeNull();
    expect(await store.readRequests('/work/a')).toEqual([]);
    expect(await store.listBindings()).toEqual([]);
    expect(existsSync(join(root, '.config', 'borgmcp', 'representative'))).toBe(false);
  });
});

describe('C3: the warning filter hides only SQLite\'s ExperimentalWarning', () => {
  const src = (name: string) => JSON.stringify(join(process.cwd(), 'src', name));
  const node = (payload: string, extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', payload],
      { env: { ...childEnv(), ...extraEnv }, encoding: 'utf8', timeout: 30_000 });

  it('forwards DeprecationWarning, the TLS-verification warning and an unrelated ExperimentalWarning, with stdout unchanged', () => {
    const result = node(`
      const { loadSqlite } = await import(${src('representative-db.ts')});
      const { DatabaseSync } = await loadSqlite();
      new DatabaseSync(':memory:').close();
      process.emitWarning('fixture api is deprecated', 'DeprecationWarning', 'DEP0999');
      process.emitWarning('Fixture streams are an experimental feature', 'ExperimentalWarning');
      const tls = await import('node:tls');
      tls.connect({ host: '127.0.0.1', port: 9 }).on('error', () => {});
      process.stdout.write('STDOUT-MARKER\\n');
      setTimeout(() => process.exit(0), 300);`, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('STDOUT-MARKER\n');
    expect(result.stderr).toContain('DEP0999');
    expect(result.stderr).toContain('Fixture streams are an experimental feature');
    expect(result.stderr).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(result.stderr).not.toMatch(/SQLite is an experimental feature/);
  });

  // Node 22 (the floor, and the CI matrix) warns on node:sqlite; later majors
  // stopped. Where Node warns, this proves the filter is what removes it.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  it.runIf(nodeMajor === 22)('is what hides it: node:sqlite loaded without the filter prints the warning on Node 22', () => {
    const result = node(`const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(':memory:').close();`);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/SQLite is an experimental feature/);
  });
});

describe('RESET-2b: a transaction whose generation moved re-targets once; real errors surface', () => {
  const pauseChild = (hook: string) => {
    const ready = join(root, `ready-${hook}`), go = join(root, `go-${hook}`);
    const proc = child(['pause', hook, ready, go, '/work/paused']);
    return { ready, go, done: proc.done };
  };

  it('(1) reset while a writer holds a handle, then its BEGIN on the old generation fails: the write lands in the new one', async () => {
    await prepareBinding('/work/a');
    const old = readCurrent(stateRoot)!;
    const writer = pauseChild('beforeBegin');
    await waitFile(writer.ready); // CURRENT read and handle open on the old generation
    notADatabase(old);
    const reset = await run(['reset']);
    expect(reset.out.code).toBe(0);
    const next = readCurrent(stateRoot)!;
    expect(next).not.toBe(old);
    writeFileSync(writer.go, 'go');
    const result = await writer.done;
    expect(result.out).toMatchObject({ ok: true, current: next });
    expect(result.out.counts.afterBegin).toBe(1); // the old BEGIN failed; only the new generation began
    expect((rowsOf(next, 'bindings') as Array<{ worktree: string }>).map((row) => row.worktree)).toContain('/work/paused');
  }, 60_000);

  it('(1b) reset between CURRENT read and BEGIN on a corrupt but openable generation: the in-transaction re-read re-targets', async () => {
    await prepareBinding('/work/a');
    const old = readCurrent(stateRoot)!;
    const writer = pauseChild('beforeBegin');
    await waitFile(writer.ready);
    corruptTable(old);
    const oldBytes = sha(databaseOf(old));
    expect((await run(['reset'])).out.code).toBe(0);
    const next = readCurrent(stateRoot)!;
    writeFileSync(writer.go, 'go');
    const result = await writer.done;
    expect(result.out).toMatchObject({ ok: true, current: next });
    expect(result.out.counts.afterBegin).toBe(2); // began on the old generation, saw CURRENT move, rolled back
    expect(sha(databaseOf(old))).toBe(oldBytes); // nothing committed to the old generation
    expect((rowsOf(next, 'bindings') as Array<{ worktree: string }>).map((row) => row.worktree)).toContain('/work/paused');
  }, 60_000);

  it('(2) a pause between the CURRENT read and the open, across resets and retention, re-targets to the new generation', async () => {
    await prepareBinding('/work/a');
    const first = readCurrent(stateRoot)!;
    const writer = pauseChild('beforeOpen');
    await waitFile(writer.ready); // read CURRENT = first; nothing opened yet
    for (let i = 0; i < 4; i += 1) {
      corruptTable(readCurrent(stateRoot)!);
      expect((await run(['reset'])).out.code).toBe(0);
    }
    expect(existsSync(join(stateRoot, first))).toBe(false); // retention removed the generation it read
    const latest = readCurrent(stateRoot)!;
    writeFileSync(writer.go, 'go');
    const result = await writer.done;
    expect(result.out).toMatchObject({ ok: true, current: latest });
    expect((rowsOf(latest, 'bindings') as Array<{ worktree: string }>).map((row) => row.worktree)).toContain('/work/paused');
  }, 120_000);

  it('(3) with CURRENT unchanged, real corruption keeps the original error and is never retried into success', async () => {
    await prepareBinding('/work/a');
    const gen = readCurrent(stateRoot)!;
    corruptTable(gen);
    const error = await createRepresentativeState().transact(() => 'wrote').then(() => null, (e) => e);
    expect(error?.code).toBe('REPRESENTATIVE_STATE_CORRUPT');
    expect(error.message).toContain('borg representative reset-state');
    notADatabase(gen);
    const notadb = await createRepresentativeState().transact(() => 'wrote').then(() => null, (e) => e);
    expect(notadb?.code).toBe('REPRESENTATIVE_STATE_CORRUPT');
    expect(generations()).toEqual([gen]);
    expect(readCurrent(stateRoot)).toBe(gen);
  });

  it('(3b) a busy database is not corruption: the SQLite BUSY error surfaces unchanged', async () => {
    await prepareBinding('/work/a');
    const gen = readCurrent(stateRoot)!;
    const blocker = new DatabaseSync(databaseOf(gen));
    blocker.exec('BEGIN EXCLUSIVE');
    try {
      const error = await createRepresentativeState({ busyTimeoutMs: 50 }).transact(() => 'wrote').then(() => null, (e) => e);
      expect(error).not.toBeInstanceOf(RepresentativeStateError);
      expect(isSqliteCorruption(error)).toBe(false);
      expect((error as { errcode?: number }).errcode! & 0xff).toBe(5);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });

  it('(4) two open handles in one process both move to the new generation and never write the old one', async () => {
    await prepareBinding('/work/a');
    const old = readCurrent(stateRoot)!;
    const one = createRepresentativeStore(), two = createRepresentativeStore();
    await one.saveBinding(bind('/work/one', '2026-01-02T00:00:00.000Z'), { rebind: true });
    await two.saveBinding(bind('/work/two', '2026-01-03T00:00:00.000Z'), { rebind: true });
    one.state.close(); two.state.close();
    const reopenedOne = createRepresentativeStore(), reopenedTwo = createRepresentativeStore();
    expect(await reopenedOne.state.transact(() => 'open')).toBe('open');
    expect(await reopenedTwo.state.transact(() => 'open')).toBe('open');
    corruptTable(old);
    const oldBytes = sha(databaseOf(old));
    expect((await run(['reset'])).out.code).toBe(0);
    const next = readCurrent(stateRoot)!;
    await reopenedOne.saveBinding(bind('/work/one', '2026-02-01T00:00:00.000Z'), { rebind: true });
    await reopenedTwo.saveBinding(bind('/work/two', '2026-02-02T00:00:00.000Z'), { rebind: true });
    reopenedOne.state.close(); reopenedTwo.state.close();
    expect(sha(databaseOf(old))).toBe(oldBytes);
    const rows = rowsOf(next, 'bindings') as Array<{ worktree: string; binding: string }>;
    expect(JSON.parse(rows.find((row) => row.worktree === '/work/one')!.binding).boundAt).toBe('2026-02-01T00:00:00.000Z');
    expect(JSON.parse(rows.find((row) => row.worktree === '/work/two')!.binding).boundAt).toBe('2026-02-02T00:00:00.000Z');
  }, 60_000);
});

describe('active-generation check inside every transaction', () => {
  const WORKTREE = '/work/hermes-representative';
  it('refuses to widen the read window when a rebind lands between the snapshot and the window write', async () => {
    const cube = new MockCube();
    await createRepresentativeStore().saveBinding(bindingFor(WORKTREE), { rebind: false });
    cube.post(COORD_ID, 'reply', [REP_ID]);
    const backend = cube.backend();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolveReached) => { entered = resolveReached; });
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const ctx = { binding: bindingFor(WORKTREE), store: createRepresentativeStore(), backend: { ...backend, readAfter: async (...args: Parameters<typeof backend.readAfter>) => {
      entered(); await gate; return backend.readAfter(...args);
    } } };
    const pending = readRepresentativeReplies(ctx, {}).then(() => 'NO_ERROR', (e) => e.code);
    await reached; // T1 done; the network scan is in flight
    await createRepresentativeStore().saveBinding(bindingFor(WORKTREE, { boundAt: '2026-06-01T00:00:00.000Z' }), { rebind: true });
    release();
    expect(await pending).toBe('BINDING_MISMATCH');
    const gen = readCurrent(stateRoot)!;
    expect(rowsOf(gen, 'returned')).toEqual([]);
    expect((rowsOf(gen, 'delivery') as Array<{ read_through_id: string | null }>).every((row) => row.read_through_id === null)).toBe(true);
  });

  it('never settles a send into the new generation\'s ledger when a rebind lands while the append is in flight', async () => {
    const cube = new MockCube();
    await createRepresentativeStore().saveBinding(bindingFor(WORKTREE), { rebind: false });
    let open!: () => void;
    cube.appendGate = new Promise<void>((resolveOpen) => { open = resolveOpen; });
    const ctx = { binding: bindingFor(WORKTREE), store: createRepresentativeStore(), backend: cube.backend() };
    const pending = sendRepresentativeMessage(ctx, { kind: 'question', authorization: 'model_advice', message: 'hi' })
      .then((value) => value, (e) => e);
    while (cube.appendCalls.length === 0) await new Promise((resolveTick) => setTimeout(resolveTick, 2));
    // A different selection (another Coordinator) starts with an empty ledger;
    // a same-selection rebind would carry the pending record by design.
    const rebound = bindingFor(WORKTREE, { coordinatorDroneId: '77777777-7777-4777-8777-777777777777', coordinatorLabel: 'coordinator-2',
      boundAt: '2026-06-01T00:00:00.000Z' });
    await createRepresentativeStore().saveBinding(rebound, { rebind: true });
    open();
    await pending;
    const gen = readCurrent(stateRoot)!;
    const ledger = (rowsOf(gen, 'requests') as Array<{ generation: string }>);
    expect(ledger.filter((row) => row.generation === bindingFingerprint(rebound))).toEqual([]);
  });
});

describe('Security (a): the publish mutex is data-free and never journals', () => {
  it('keeps publish.sqlite empty, with no sidecar, through creation and reset, and holds no WAL mode', async () => {
    const seen: string[][] = [];
    const look = () => { seen.push(readdirSync(stateRoot).filter((name) => name.startsWith('publish.sqlite'))); };
    await createRepresentativeState({ hooks: { 'publish:schema': look, 'publish:rename': look } }).transact(() => {});
    corruptTable(readCurrent(stateRoot)!);
    await resetRepresentativeState({ ...resetOptions, hooks: { 'publish:schema': look, 'publish:done': look } });
    expect(seen).toHaveLength(4);
    for (const names of seen) expect(names).toEqual(['publish.sqlite']); // no -journal, -wal or -shm while held
    expect(lstatSync(join(stateRoot, 'publish.sqlite')).size).toBe(0);
    const probe = new DatabaseSync(join(stateRoot, 'publish.sqlite'), { readOnly: true });
    expect((probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).not.toBe('wal');
    probe.close();
  });

  it('refuses a symlinked publish.sqlite without touching its target', async () => {
    await prepareBinding();
    const outside = join(root, 'outside');
    writeFileSync(outside, 'OUTSIDE', { mode: 0o600 });
    rmSync(join(stateRoot, 'publish.sqlite'));
    symlinkSync(outside, join(stateRoot, 'publish.sqlite'));
    corruptTable(readCurrent(stateRoot)!);
    expect(await codeOf(resetRepresentativeState(resetOptions))).toBe('REPRESENTATIVE_STATE_INVALID');
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE');
  });
});

describe('Security (b): retention is never recursive', () => {
  it('unlinks only the three database names, then rmdir; anything else is left and reported', async () => {
    await createRepresentativeState().transact(() => {});
    const names: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      mkdirSync(join(stateRoot, `g0000000000000000${i}-${'0'.repeat(15)}${i}`), { mode: 0o700 });
      names.push(`g0000000000000000${i}-${'0'.repeat(15)}${i}`);
    }
    const outside = join(root, 'outside');
    writeFileSync(outside, 'OUTSIDE', { mode: 0o600 });
    // The two oldest are beyond retention: one holds a stray file and a nested
    // directory; the other has a symlink at a database name.
    writeFileSync(join(stateRoot, names[0], 'state.sqlite'), 'x', { mode: 0o600 });
    writeFileSync(join(stateRoot, names[0], 'keep.txt'), 'KEEP', { mode: 0o600 });
    mkdirSync(join(stateRoot, names[0], 'nested'), { mode: 0o700 });
    writeFileSync(join(stateRoot, names[0], 'nested', 'deep'), 'DEEP', { mode: 0o600 });
    symlinkSync(outside, join(stateRoot, names[1], 'state.sqlite-wal'));
    const current = readCurrent(stateRoot)!;
    const kept = await withPublishMutex(stateRoot, () => cleanupGenerations(stateRoot, current), { create: false });
    expect(kept.sort()).toEqual([names[0], names[1]]);
    expect(readdirSync(join(stateRoot, names[0])).sort()).toEqual(['keep.txt', 'nested']);
    expect(readFileSync(join(stateRoot, names[0], 'nested', 'deep'), 'utf8')).toBe('DEEP');
    expect(lstatSync(join(stateRoot, names[1], 'state.sqlite-wal')).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE');
    expect(generations()).toEqual([names[0], names[1], names[2], names[3], names[4], current].sort());
    // The three newest non-current generations are retained untouched.
    for (const name of names.slice(2)) expect(existsSync(join(stateRoot, name))).toBe(true);
  });

  it('never follows a symlink named like a generation', async () => {
    await createRepresentativeState().transact(() => {});
    const target = join(root, 'target-dir');
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'state.sqlite'), 'TARGET', { mode: 0o600 });
    for (let i = 0; i < 4; i += 1) mkdirSync(join(stateRoot, `g0000000000000001${i}-${'0'.repeat(15)}${i}`), { mode: 0o700 });
    const link = `g00000000000000000-${'0'.repeat(16)}`;
    symlinkSync(target, join(stateRoot, link));
    const current = readCurrent(stateRoot)!;
    const kept = await withPublishMutex(stateRoot, () => cleanupGenerations(stateRoot, current), { create: false });
    expect(kept).toEqual([link]);
    expect(readFileSync(join(target, 'state.sqlite'), 'utf8')).toBe('TARGET');
  });
});

describe('publication is atomic at every crash point; durability follows the final directory fsync', () => {
  const HOOKS = ['publish:dir', 'publish:schema', 'publish:rows', 'publish:fsync', 'publish:tmp', 'publish:rename', 'publish:done'];

  it('orders the steps: files fsynced before CURRENT is written; CURRENT changes only at the rename', async () => {
    const order: string[] = [];
    const record = (name: string) => () => { order.push(`${name}:${readCurrent(stateRoot) ?? 'none'}`); };
    await createRepresentativeState({ hooks: Object.fromEntries(HOOKS.map((name) => [name, record(name)])) }).transact(() => {});
    const gen = readCurrent(stateRoot)!;
    expect(order).toEqual([...HOOKS.slice(0, -1).map((name) => `${name}:none`), `publish:done:${gen}`]);
  });

  it.each(HOOKS)('first creation killed at %s leaves no partial generation behind CURRENT', async (hook) => {
    const killed = await run(['kill-at', hook]);
    expect(killed.signal).toBe('SIGKILL');
    const current = readCurrent(stateRoot);
    if (hook === 'publish:done') expect(current).not.toBeNull();
    else expect(current).toBeNull();
    // The next use recovers without operator action and publishes a complete generation.
    await prepareBinding('/work/after');
    const now = readCurrent(stateRoot)!;
    const db = new DatabaseSync(databaseOf(now), { readOnly: true });
    expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    db.close();
    expect(readdirSync(stateRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 60_000);

  it.each(HOOKS)('reset killed at %s leaves CURRENT on the old or on a complete new generation', async (hook) => {
    await prepareBinding('/work/a');
    const old = readCurrent(stateRoot)!;
    corruptTable(old);
    const killed = await run(['reset-kill-at', hook]);
    expect(killed.signal).toBe('SIGKILL');
    const current = readCurrent(stateRoot)!;
    if (hook === 'publish:done') {
      expect(current).not.toBe(old);
      expect(rowsOf(current, 'bindings')).toHaveLength(1);
    } else {
      expect(current).toBe(old);
      // Still corrupt: the operator's reset runs again and completes.
      const again = await run(['reset']);
      expect(again.out.code).toBe(0);
      expect(readCurrent(stateRoot)).not.toBe(old);
    }
  }, 60_000);
});

describe('reset-state', () => {
  it('refuses a healthy database and changes nothing', async () => {
    await prepareBinding('/work/a');
    const gen = readCurrent(stateRoot)!;
    const bytes = sha(databaseOf(gen));
    let out = '', err = '';
    expect(await runRepresentativeResetState({ stdout: (t) => { out += t; }, stderr: (t) => { err += t; } })).toBe(1);
    expect(err).toContain('is healthy; nothing to reset');
    expect(out).toBe('');
    expect(generations()).toEqual([gen]);
    expect(sha(databaseOf(gen))).toBe(bytes);
  });

  it('reports nothing to reset before any state exists and creates none', async () => {
    let out = '';
    expect(await runRepresentativeResetState({ stdout: (t) => { out += t; }, stderr: () => {} })).toBe(0);
    expect(out).toContain('nothing to reset');
    expect(existsSync(stateRoot)).toBe(false);
  });

  it('refuses a database of another version: that is not corruption', async () => {
    await prepareBinding('/work/a');
    const gen = readCurrent(stateRoot)!;
    const db = new DatabaseSync(databaseOf(gen));
    db.exec('PRAGMA user_version = 2');
    db.close();
    expect(await codeOf(createRepresentativeState().transact(() => {}))).toBe('REPRESENTATIVE_STATE_VERSION');
    expect(await codeOf(resetRepresentativeState(resetOptions))).toBe('REPRESENTATIVE_STATE_VERSION');
    expect(generations()).toEqual([gen]);
  });

  it('salvages each valid binding (re-validated), drops invalid ones, keeps the damaged generation, and prints the loss', async () => {
    const store = createRepresentativeStore();
    await store.saveBinding(bind('/work/a'), { rebind: true });
    await store.saveBinding(bind('/work/b', '2026-02-01T00:00:00.000Z'), { rebind: true });
    await store.transactRequests(bind('/work/a'), (records) => {
      records.push({ requestId: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c', state: 'ambiguous', kind: 'request',
        fingerprint: 'f', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as never);
    });
    store.state.close();
    const old = readCurrent(stateRoot)!;
    const db = new DatabaseSync(databaseOf(old));
    db.prepare(`INSERT INTO bindings (worktree, generation, seat, origin, binding) VALUES ('/work/forged', 'x', 'y', 'prepared', ?)`)
      .run(JSON.stringify({ ...bind('/work/other') })); // worktree mismatch: fails validation
    db.close();
    corruptTable(old);
    let out = '';
    expect(await runRepresentativeResetState({ stdout: (t) => { out += t; }, stderr: (t) => { throw new Error(t); } })).toBe(0);
    const next = readCurrent(stateRoot)!;
    expect(next).not.toBe(old);
    expect(existsSync(databaseOf(old))).toBe(true); // kept aside, not deleted
    expect(out).toContain(`generation ${old} replaced by ${next}`);
    expect(out).toContain('Bindings kept: /work/a, /work/b');
    expect(out).toContain('Binding lost for /work/forged: binding failed validation');
    expect(out).toMatch(/Lost: every delivery checkpoint/);
    expect(out).toMatch(/pending and ambiguous sends are no longer guarded/);
    expect(rowsOf(next, 'requests')).toEqual([]);
    const delivery = rowsOf(next, 'delivery') as Array<{ generation: string; start_kind: string; start_at: string }>;
    expect(delivery.map((row) => [row.generation, row.start_kind, row.start_at]).sort()).toEqual([
      [bindingFingerprint(bind('/work/a')), 'binding', '2026-01-01T00:00:00.000Z'],
      [bindingFingerprint(bind('/work/b', '2026-02-01T00:00:00.000Z')), 'binding', '2026-02-01T00:00:00.000Z'],
    ].sort());
    // After the reset, a kept binding replays its replies from the binding start.
    const cube = new MockCube();
    const reply = cube.post(COORD_ID, 'replayed', [REP_ID]);
    const read = await readRepresentativeReplies({ binding: bind('/work/a'), backend: cube.backend(), store: createRepresentativeStore() }, {});
    expect(read.replies.map((r) => r.entry_id)).toEqual([reply.id]);
  });

  it('salvages from a database that is not a database at all: nothing to keep, every binding reported lost', async () => {
    await prepareBinding('/work/a');
    const old = readCurrent(stateRoot)!;
    notADatabase(old);
    let out = '';
    expect(await runRepresentativeResetState({ stdout: (t) => { out += t; }, stderr: (t) => { throw new Error(t); } })).toBe(0);
    expect(out).toContain('Bindings kept: none');
    expect(out).toMatch(/Binding lost: bindings unreadable/);
    expect(rowsOf(readCurrent(stateRoot)!, 'bindings')).toEqual([]);
  });

  it('lets exactly one of two concurrent resets replace the generation', async () => {
    await prepareBinding('/work/a');
    corruptTable(readCurrent(stateRoot)!);
    const results = await Promise.all([run(['reset']), run(['reset'])]);
    const outcomes = results.map((result) => result.out.code).sort();
    expect(outcomes).toEqual([0, 1]);
    expect(results.find((result) => result.out.code === 1)!.out.err).toContain('is healthy; nothing to reset');
    expect(generations()).toHaveLength(2);
  }, 60_000);
});

describe('multi-process stress', () => {
  it('keeps send, read and deliver consistent across eight processes interleaving real tool calls', async () => {
    const { createServer } = await import('node:http');
    const cube = new MockCube();
    const worktree = '/work/stress';
    await prepareBinding(worktree);
    const backend = cube.backend() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', async () => {
        const { method, args } = JSON.parse(raw) as { method: string; args: unknown[] };
        try {
          response.end(JSON.stringify({ result: await backend[method](...args) }));
        } catch (error) {
          const { message, status, code } = error as { message: string; status?: number; code?: string };
          response.end(JSON.stringify({ error: { message, status, code } }));
        }
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const go = join(root, 'go-workload');
    const ITERATIONS = 25;
    try {
      const workers = Array.from({ length: 8 }, () => child(['workload', url, worktree, String(ITERATIONS), go]));
      await new Promise((resolveStart) => setTimeout(resolveStart, 1500));
      writeFileSync(go, 'go');
      // The Coordinator keeps replying while the workers run.
      let running = true;
      const replies: string[] = [];
      const poster = (async () => {
        while (running) {
          replies.push(cube.post(COORD_ID, `reply ${replies.length}`, [REP_ID]).id);
          await new Promise((resolveTick) => setTimeout(resolveTick, 3));
        }
      })();
      const results = await Promise.all(workers.map((worker) => worker.done));
      running = false;
      await poster;
      for (const result of results) {
        expect(result.code).toBe(0);
        expect(result.out.errors).toEqual([]);
        expect(result.out.sent).toHaveLength(ITERATIONS);
        // Each process observes a checkpoint that never moves backwards.
        expect([...result.out.checkpoints].sort()).toEqual(result.out.checkpoints);
      }
      // Every send reached the log exactly once, under its own request id.
      const sentIds = results.flatMap((result) => result.out.sent as string[]);
      expect(new Set(sentIds).size).toBe(8 * ITERATIONS);
      expect(cube.entries.filter((entry) => entry.drone_id === REP_ID)).toHaveLength(8 * ITERATIONS);
      expect(new Set(cube.appendCalls.map((call) => call.postId)).size).toBe(8 * ITERATIONS);
      const gen = readCurrent(stateRoot)!;
      const ledger = rowsOf(gen, 'requests') as Array<{ record: string }>;
      expect(ledger.map((row) => JSON.parse(row.record).state).filter((state) => state !== 'sent')).toEqual([]);
      // No reply was skipped: what any process read, plus a final drain, is every reply, in order.
      const ctx = { binding: bind(worktree), backend: cube.backend(), store: createRepresentativeStore() };
      const drained: string[] = [];
      for (;;) {
        const page = await readRepresentativeReplies(ctx, { limit: 50 });
        if (page.replies.length === 0) break;
        drained.push(...page.replies.map((reply) => reply.entry_id));
        await deliverRepresentativeReplies(ctx, { through: page.replies.at(-1)!.entry_id });
      }
      ctx.store.state.close();
      // The workers really overlapped on replies: several of them read and delivered.
      expect(results.filter((result) => (result.out.checkpoints as string[]).length > 0).length).toBeGreaterThan(1);
      const union = new Set([...results.flatMap((result) => result.out.seen as string[]), ...drained]);
      expect(replies.filter((id) => !union.has(id))).toEqual([]);
      const [delivery] = rowsOf(gen, 'delivery') as Array<{ checkpoint_id: string; read_through_id: string }>;
      expect(delivery.checkpoint_id).toBe(replies.at(-1));
      expect(delivery.read_through_id).toBe(replies.at(-1));
    } finally {
      server.close();
    }
  }, 240_000);


  it('loses no update across eight processes each committing 250 read-modify-write transactions', async () => {
    await createRepresentativeState().transact(() => {});
    const go = join(root, 'go');
    const workers = Array.from({ length: 8 }, () => child(['stress', '250', go]));
    await new Promise((resolveStart) => setTimeout(resolveStart, 1500)); // every worker has its handle open
    writeFileSync(go, 'go');
    const results = await Promise.all(workers.map((worker) => worker.done));
    for (const result of results) expect(result).toMatchObject({ code: 0, out: { done: 250 } });
    expect(rowsOf(readCurrent(stateRoot)!, 'wake_state')).toEqual([{ generation: 'stress', state: '2000' }]);
  }, 180_000);
});
