/**
 * The only module in src that may import filesystem MUTATION functions.
 *
 * Every write, create, rename, remove, permission, owner or time change,
 * write-mode open and SQLite open goes through `assertTestWritable` first. In
 * production it is a no-op (the variables below are unset). Under the test
 * runner, which records the operator's real home in
 * BORGMCP_TEST_FORBIDDEN_HOME, it throws TestIsolationError before any I/O
 * when the target, or any symlink hop on the way to it (dangling links
 * included), equals or lies under that home — descendants included — unless it
 * lies under one of the run's own roots (BORGMCP_TEST_ALLOWED_ROOTS: its
 * TMPDIR and private HOME, and their descendants only). The fs and fsp
 * namespaces exported here are closed: a name that is neither a guarded
 * mutation nor a listed read throws. A syntax-aware lint test
 * (__tests__/guarded-fs-lint.test.ts) fails if src bypasses this module.
 */
import * as nodeFs from 'node:fs';
import nodeFsModule from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_FORBIDDEN_HOME_ENV = 'BORGMCP_TEST_FORBIDDEN_HOME';
export const TEST_ALLOWED_ROOTS_ENV = 'BORGMCP_TEST_ALLOWED_ROOTS';

export class TestIsolationError extends Error {
  constructor(path: string) {
    super(`Test isolation: ${path} is in the operator's real home. Every test must use an explicit temporary root ` +
      '(HOME, BORG_STATE_ROOT or the explicit path option); nothing was read or written.');
    this.name = 'TestIsolationError';
  }
}

const MAX_LINKS = 40;

/**
 * Where a path leads, component by component: an existing component is
 * lstat'ed, and a symlink (dangling or not) is replaced by its target,
 * recursively; components that do not exist are kept literally. `hops`
 * collects every location a symlink pointed to on the way. A loop throws.
 */
function canonical(path: string, hops: string[] = [], budget = { links: MAX_LINKS }): string {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current = absolute.startsWith(sep) ? sep : `${parts.shift()!}${sep}`;
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index]);
    let metadata: nodeFs.Stats;
    try {
      metadata = nodeFs.lstatSync(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      return join(next, ...parts.slice(index + 1)); // the rest does not exist yet
    }
    if (!metadata.isSymbolicLink()) { current = next; continue; }
    if (--budget.links < 0) throw new TestIsolationError(`${absolute} (too many symbolic links)`);
    const target = nodeFs.readlinkSync(next);
    const hop = isAbsolute(target) ? target : join(current, target);
    hops.push(resolve(hop));
    current = canonical(hop, hops, budget);
  }
  return current;
}

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/**
 * Whether a path, or any symlink hop on the way to it, is in the forbidden real
 * home outside the run's own roots. No-op unless the test runner set the guard.
 */
export function isTestForbiddenPath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const forbidden = env[TEST_FORBIDDEN_HOME_ENV];
  if (!forbidden) return false;
  const home = canonical(forbidden);
  const allowed = (env[TEST_ALLOWED_ROOTS_ENV] ?? '').split(delimiter).filter(Boolean).map((root) => canonical(root));
  const hops: string[] = [];
  const target = canonical(path, hops);
  // A hop is the place a link points at: its directory resolved, its own name
  // kept (following it again would skip the hop itself).
  const places = [target, ...hops.map((hop) => join(canonical(dirname(hop)), basename(hop)))];
  return places.some((place) => within(place, home) && !allowed.some((root) => within(place, root)));
}

export function assertTestWritable(path: nodeFs.PathLike | number | nodeFsp.FileHandle): void {
  if (!process.env[TEST_FORBIDDEN_HOME_ENV]) return;
  if (typeof path === 'number' || (typeof path === 'object' && path !== null && 'fd' in path)) return; // an already guarded open
  const text = path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : String(path);
  if (isTestForbiddenPath(text)) throw new TestIsolationError(text);
}

const WRITE_FLAGS = nodeFs.constants.O_WRONLY | nodeFs.constants.O_RDWR | nodeFs.constants.O_CREAT |
  nodeFs.constants.O_TRUNC | nodeFs.constants.O_APPEND;
const writesFlags = (flags: unknown) =>
  typeof flags === 'number' ? (flags & WRITE_FLAGS) !== 0 : typeof flags === 'string' && !/^(r|rs|sr)$/.test(flags);

type AnyFn = (...args: any[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
// Calls resolve the target function on the fs module objects at CALL time, so
// anything that replaces a module function (a test spy, a polyfill) still applies.
const syncFs = nodeFsModule as unknown as Record<string, AnyFn>;
const promisesObject = nodeFsModule.promises as unknown as Record<string, AnyFn>;
const promisesModule = nodeFsp as unknown as Record<string, AnyFn>;
const PRISTINE_PROMISES = { ...promisesObject };
/** fs.promises[name] when it was replaced (a spy), else the node:fs/promises export (which a module mock replaces). */
const promiseFs = new Proxy(promisesObject, {
  get: (object, name: string) => object[name] !== PRISTINE_PROMISES[name] ? object[name] : promisesModule[name] ?? object[name],
});
const check = (args: unknown[], positions: number[]) => {
  for (const position of positions.length ? positions : [0]) assertTestWritable(args[position] as nodeFs.PathLike);
};
/** Guard the path arguments at the given positions, then call through. */
const guardSync = <K extends keyof typeof nodeFs>(name: K, ...positions: number[]): (typeof nodeFs)[K] =>
  ((...args: unknown[]) => { check(args, positions); return syncFs[name](...args); }) as (typeof nodeFs)[K];
/** The promise form: a refusal is a rejected promise, like any other I/O failure. */
const guardAsync = <K extends keyof typeof nodeFsp>(name: K, ...positions: number[]): (typeof nodeFsp)[K] =>
  (async (...args: unknown[]) => { check(args, positions); return promiseFs[name](...args); }) as (typeof nodeFsp)[K];

// Synchronous mutations.
export const writeFileSync = guardSync('writeFileSync');
export const appendFileSync = guardSync('appendFileSync');
export const mkdirSync = guardSync('mkdirSync');
export const mkdtempSync = guardSync('mkdtempSync');
export const renameSync = guardSync('renameSync', 0, 1);
export const unlinkSync = guardSync('unlinkSync');
export const rmSync = guardSync('rmSync');
export const rmdirSync = guardSync('rmdirSync');
export const openSync = ((...args: unknown[]) => {
  if (writesFlags(args[1])) assertTestWritable(args[0] as nodeFs.PathLike);
  return syncFs.openSync(...args);
}) as typeof nodeFs.openSync;
export const copyFileSync = guardSync('copyFileSync', 1);
export const cpSync = guardSync('cpSync', 1);
export const chmodSync = guardSync('chmodSync');
export const lchmodSync = guardSync('lchmodSync');
export const chownSync = guardSync('chownSync');
export const lchownSync = guardSync('lchownSync');
export const symlinkSync = guardSync('symlinkSync', 1);
export const linkSync = guardSync('linkSync', 0, 1);
export const truncateSync = guardSync('truncateSync');
export const utimesSync = guardSync('utimesSync');
export const lutimesSync = guardSync('lutimesSync');

// Promise mutations.
export const writeFile = guardAsync('writeFile');
export const appendFile = guardAsync('appendFile');
export const mkdir = guardAsync('mkdir');
export const mkdtemp = guardAsync('mkdtemp');
export const rename = guardAsync('rename', 0, 1);
export const unlink = guardAsync('unlink');
export const rm = guardAsync('rm');
export const rmdir = guardAsync('rmdir');
export const open = (async (...args: unknown[]) => {
  if (writesFlags(args[1])) assertTestWritable(args[0] as nodeFs.PathLike);
  return promiseFs.open(...args);
}) as typeof nodeFsp.open;
export const copyFile = guardAsync('copyFile', 1);
export const cp = guardAsync('cp', 1);
export const chmod = guardAsync('chmod');
export const lchmod = guardAsync('lchmod');
export const chown = guardAsync('chown');
export const lchown = guardAsync('lchown');
export const symlink = guardAsync('symlink', 1);
export const link = guardAsync('link', 0, 1);
export const truncate = guardAsync('truncate');
export const utimes = guardAsync('utimes');
export const lutimes = guardAsync('lutimes');

/** Open a SQLite database (it may create the file and its sidecars). */
export function openSqlite<T>(Database: new (path: string, options?: { readOnly?: boolean }) => T, path: string,
  options?: { readOnly?: boolean }): T {
  assertTestWritable(path);
  return options ? new Database(path, options) : new Database(path);
}

/**
 * The closed namespaces: guarded mutations, plus the listed reads and
 * descriptor-level calls on descriptors from a guarded open. Any other name
 * throws, so a mutation added to Node (or missed here) cannot pass through raw.
 */
const SYNC_PASSTHROUGH = new Set(['existsSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'fstatSync',
  'realpathSync', 'readlinkSync', 'accessSync', 'readSync', 'closeSync', 'fsyncSync', 'writeSync', 'fchmodSync',
  'ftruncateSync', 'constants', 'Stats', 'Dirent']);
const PROMISE_PASSTHROUGH = new Set(['readFile', 'readdir', 'stat', 'lstat', 'realpath', 'readlink', 'access', 'constants']);
const SYNC_GUARDED: Record<string, unknown> = {
  writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, rmSync, rmdirSync, openSync, copyFileSync,
  cpSync, chmodSync, lchmodSync, chownSync, lchownSync, symlinkSync, linkSync, truncateSync, utimesSync, lutimesSync,
};
const PROMISE_GUARDED: Record<string, unknown> = {
  writeFile, appendFile, mkdir, mkdtemp, rename, unlink, rm, rmdir, open, copyFile, cp, chmod, lchmod, chown, lchown,
  symlink, link, truncate, utimes, lutimes,
};
const closedName = (surface: string, name: string): never => {
  throw new Error(`${surface}.${name} is not available through guarded-fs: add a guarded form for a mutation, or list a read`);
};

/** fs/promises, closed. */
export const fsp = new Proxy(promiseFs, {
  get: (target, name) => {
    if (typeof name !== 'string') return undefined;
    if (name in PROMISE_GUARDED) return PROMISE_GUARDED[name];
    return PROMISE_PASSTHROUGH.has(name) ? target[name] : closedName('fsp', name);
  },
}) as unknown as typeof nodeFsp;

/** The fs namespace, closed. */
export const fs = new Proxy(syncFs, {
  get: (target, name) => {
    if (typeof name !== 'string') return undefined;
    if (name === 'promises') return fsp;
    if (name in SYNC_GUARDED) return SYNC_GUARDED[name];
    return SYNC_PASSTHROUGH.has(name) ? target[name] : closedName('fs', name);
  },
}) as unknown as typeof nodeFs;
