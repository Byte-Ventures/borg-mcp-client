/**
 * The only module in src that may import filesystem MUTATION functions.
 *
 * Every write, create, rename, remove, permission change, write-mode open and
 * SQLite open goes through `assertTestWritable` first. In production it is a
 * no-op (the variables below are unset). Under the test runner, which records
 * the operator's real home in BORGMCP_TEST_FORBIDDEN_HOME, it throws
 * TestIsolationError before any I/O when the target, canonicalized through
 * the realpath of its nearest existing ancestor (so symlinks are followed),
 * equals or lies under that home — descendants included — unless it lies
 * under one of the run's own roots (BORGMCP_TEST_ALLOWED_ROOTS: its private
 * HOME and TMPDIR). A lint test (__tests__/guarded-fs-lint.test.ts) fails if
 * src gains a mutation call that bypasses this module.
 */
import * as nodeFs from 'node:fs';
import nodeFsModule from 'node:fs';
import * as nodeFsp from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TEST_FORBIDDEN_HOME_ENV = 'BORGMCP_TEST_FORBIDDEN_HOME';
export const TEST_ALLOWED_ROOTS_ENV = 'BORGMCP_TEST_ALLOWED_ROOTS';
export class TestIsolationError extends Error {
    constructor(path) {
        super(`Test isolation: ${path} is in the operator's real home. Every test must use an explicit temporary root ` +
            '(HOME, BORG_STATE_ROOT or the explicit path option); nothing was read or written.');
        this.name = 'TestIsolationError';
    }
}
/** realpath of the nearest existing ancestor, plus the not-yet-existing tail. */
function canonical(path) {
    let current = resolve(path);
    const tail = [];
    for (;;) {
        try {
            return join(nodeFs.realpathSync(current), ...tail.reverse());
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR')
                throw error;
            const parent = dirname(current);
            if (parent === current)
                return join(current, ...tail.reverse());
            tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
            current = parent;
        }
    }
}
const within = (path, root) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
};
/** Whether a path is in the forbidden real home (outside the run's own roots). No-op unless the test runner set the guard. */
export function isTestForbiddenPath(path, env = process.env) {
    const forbidden = env[TEST_FORBIDDEN_HOME_ENV];
    if (!forbidden)
        return false;
    const target = canonical(path);
    if (!within(target, canonical(forbidden)))
        return false;
    const allowed = (env[TEST_ALLOWED_ROOTS_ENV] ?? '').split(delimiter).filter(Boolean).map(canonical);
    return !allowed.some((root) => within(target, root));
}
export function assertTestWritable(path) {
    if (!process.env[TEST_FORBIDDEN_HOME_ENV])
        return;
    if (typeof path === 'number' || (typeof path === 'object' && path !== null && 'fd' in path))
        return; // an already guarded open
    const text = path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : String(path);
    if (isTestForbiddenPath(text))
        throw new TestIsolationError(text);
}
const WRITE_FLAGS = nodeFs.constants.O_WRONLY | nodeFs.constants.O_RDWR | nodeFs.constants.O_CREAT |
    nodeFs.constants.O_TRUNC | nodeFs.constants.O_APPEND;
const writesFlags = (flags) => typeof flags === 'number' ? (flags & WRITE_FLAGS) !== 0 : typeof flags === 'string' && !/^(r|rs|sr)$/.test(flags);
// Calls resolve the target function on the fs module objects at CALL time, so
// anything that replaces a module function (a test spy, a polyfill) still applies.
const syncFs = nodeFsModule;
const promisesObject = nodeFsModule.promises;
const promisesModule = nodeFsp;
const PRISTINE_PROMISES = { ...promisesObject };
/** fs.promises[name] when it was replaced (a spy), else the node:fs/promises export (which a module mock replaces). */
const promiseFs = new Proxy(promisesObject, {
    get: (object, name) => object[name] !== PRISTINE_PROMISES[name] ? object[name] : promisesModule[name] ?? object[name],
});
const check = (args, positions) => {
    for (const position of positions.length ? positions : [0])
        assertTestWritable(args[position]);
};
/** Guard the path arguments at the given positions, then call through. */
const guardSync = (name, ...positions) => ((...args) => { check(args, positions); return syncFs[name](...args); });
/** The promise form: a refusal is a rejected promise, like any other I/O failure. */
const guardAsync = (name, ...positions) => (async (...args) => { check(args, positions); return promiseFs[name](...args); });
// Synchronous mutations.
export const writeFileSync = guardSync('writeFileSync');
export const appendFileSync = guardSync('appendFileSync');
export const mkdirSync = guardSync('mkdirSync');
export const mkdtempSync = guardSync('mkdtempSync');
export const renameSync = guardSync('renameSync', 0, 1);
export const unlinkSync = guardSync('unlinkSync');
export const rmSync = guardSync('rmSync');
export const rmdirSync = guardSync('rmdirSync');
export const openSync = ((...args) => {
    if (writesFlags(args[1]))
        assertTestWritable(args[0]);
    return syncFs.openSync(...args);
});
export const copyFileSync = guardSync('copyFileSync', 1);
export const cpSync = guardSync('cpSync', 1);
export const chmodSync = guardSync('chmodSync');
export const symlinkSync = guardSync('symlinkSync', 1);
export const linkSync = guardSync('linkSync', 0, 1);
export const truncateSync = guardSync('truncateSync');
export const utimesSync = guardSync('utimesSync');
// Promise mutations.
export const writeFile = guardAsync('writeFile');
export const appendFile = guardAsync('appendFile');
export const mkdir = guardAsync('mkdir');
export const mkdtemp = guardAsync('mkdtemp');
export const rename = guardAsync('rename', 0, 1);
export const unlink = guardAsync('unlink');
export const rm = guardAsync('rm');
export const rmdir = guardAsync('rmdir');
export const open = (async (...args) => {
    if (writesFlags(args[1]))
        assertTestWritable(args[0]);
    return promiseFs.open(...args);
});
export const copyFile = guardAsync('copyFile', 1);
export const cp = guardAsync('cp', 1);
export const chmod = guardAsync('chmod');
export const symlink = guardAsync('symlink', 1);
export const link = guardAsync('link', 0, 1);
export const truncate = guardAsync('truncate');
export const utimes = guardAsync('utimes');
/** Open a SQLite database (it may create the file and its sidecars). */
export function openSqlite(Database, path, options) {
    assertTestWritable(path);
    return options ? new Database(path, options) : new Database(path);
}
/** The fs namespace: guarded mutations; everything else resolves on node:fs at call time. */
const SYNC_GUARDED = {
    writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync, unlinkSync, rmSync, rmdirSync, openSync,
    copyFileSync, cpSync, chmodSync, symlinkSync, linkSync, truncateSync, utimesSync,
};
// Callback forms and streams have no guarded equivalent: using one fails loudly.
const SYNC_UNAVAILABLE = new Set(['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'open',
    'copyFile', 'cp', 'chmod', 'symlink', 'link', 'truncate', 'utimes', 'createWriteStream']);
const PROMISE_GUARDED = {
    writeFile, appendFile, mkdir, mkdtemp, rename, unlink, rm, rmdir, open, copyFile, cp, chmod, symlink, link, truncate, utimes,
};
/** fs/promises with every mutation above guarded. */
export const fsp = new Proxy(promiseFs, {
    get: (target, name) => PROMISE_GUARDED[name] ?? target[name],
});
export const fs = new Proxy(syncFs, {
    get: (target, name) => {
        if (name === 'promises')
            return fsp;
        if (SYNC_UNAVAILABLE.has(name)) {
            return () => { throw new Error(`fs.${name} is not available through guarded-fs; use the guarded promise or sync form`); };
        }
        return SYNC_GUARDED[name] ?? target[name];
    },
});
//# sourceMappingURL=guarded-fs.js.map