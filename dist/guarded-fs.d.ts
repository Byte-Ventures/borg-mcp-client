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
import * as nodeFsp from 'node:fs/promises';
export declare const TEST_FORBIDDEN_HOME_ENV = "BORGMCP_TEST_FORBIDDEN_HOME";
export declare const TEST_ALLOWED_ROOTS_ENV = "BORGMCP_TEST_ALLOWED_ROOTS";
export declare class TestIsolationError extends Error {
    constructor(path: string);
}
/**
 * Whether a path, or any symlink hop on the way to it, is in the forbidden real
 * home outside the run's own roots. No-op unless the test runner set the guard.
 */
export declare function isTestForbiddenPath(path: string, env?: NodeJS.ProcessEnv): boolean;
export declare function assertTestWritable(path: nodeFs.PathLike | number | nodeFsp.FileHandle): void;
export declare const writeFileSync: typeof nodeFs.writeFileSync;
export declare const appendFileSync: typeof nodeFs.appendFileSync;
export declare const mkdirSync: typeof nodeFs.mkdirSync;
export declare const mkdtempSync: typeof nodeFs.mkdtempSync;
export declare const renameSync: typeof nodeFs.renameSync;
export declare const unlinkSync: typeof nodeFs.unlinkSync;
export declare const rmSync: typeof nodeFs.rmSync;
export declare const rmdirSync: typeof nodeFs.rmdirSync;
export declare const openSync: typeof nodeFs.openSync;
export declare const copyFileSync: typeof nodeFs.copyFileSync;
export declare const cpSync: typeof nodeFs.cpSync;
export declare const chmodSync: typeof nodeFs.chmodSync;
export declare const lchmodSync: typeof nodeFs.lchmodSync;
export declare const chownSync: typeof nodeFs.chownSync;
export declare const lchownSync: typeof nodeFs.lchownSync;
export declare const symlinkSync: typeof nodeFs.symlinkSync;
export declare const linkSync: typeof nodeFs.linkSync;
export declare const truncateSync: typeof nodeFs.truncateSync;
export declare const utimesSync: typeof nodeFs.utimesSync;
export declare const lutimesSync: typeof nodeFs.lutimesSync;
export declare const writeFile: typeof nodeFs.promises.writeFile;
export declare const appendFile: typeof nodeFs.promises.appendFile;
export declare const mkdir: typeof nodeFs.promises.mkdir;
export declare const mkdtemp: typeof nodeFs.promises.mkdtemp;
export declare const rename: typeof nodeFs.promises.rename;
export declare const unlink: typeof nodeFs.promises.unlink;
export declare const rm: typeof nodeFs.promises.rm;
export declare const rmdir: typeof nodeFs.promises.rmdir;
export declare const open: typeof nodeFsp.open;
export declare const copyFile: typeof nodeFs.promises.copyFile;
export declare const cp: typeof nodeFs.promises.cp;
export declare const chmod: typeof nodeFs.promises.chmod;
export declare const lchmod: typeof nodeFs.promises.lchmod;
export declare const chown: typeof nodeFs.promises.chown;
export declare const lchown: typeof nodeFs.promises.lchown;
export declare const symlink: typeof nodeFs.promises.symlink;
export declare const link: typeof nodeFs.promises.link;
export declare const truncate: typeof nodeFs.promises.truncate;
export declare const utimes: typeof nodeFs.promises.utimes;
export declare const lutimes: typeof nodeFs.promises.lutimes;
/** Open a SQLite database (it may create the file and its sidecars). */
export declare function openSqlite<T>(Database: new (path: string, options?: {
    readOnly?: boolean;
}) => T, path: string, options?: {
    readOnly?: boolean;
}): T;
/** fs/promises, closed. */
export declare const fsp: typeof nodeFsp;
/** The fs namespace, closed. */
export declare const fs: typeof nodeFs;
//# sourceMappingURL=guarded-fs.d.ts.map