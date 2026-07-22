import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, open, lstat, rename, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
export const borgConfigRoot = () => join(homedir(), '.config', 'borgmcp');
export function isBorgConfigPath(candidate) {
    const root = borgConfigRoot();
    return candidate === root || candidate.startsWith(`${root}${sep}`);
}
function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}
function identity(stat) {
    return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}
function sameObject(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}
function ownerAllowed(uid, requiredUid) {
    return requiredUid === null || uid === requiredUid || uid === 0;
}
function assertCanonical(path) {
    const resolved = resolve(path);
    if (resolved !== path)
        throw new Error('Borg private state path is not canonical');
    return resolved;
}
function assertChildPath(root, candidate) {
    const filePath = assertCanonical(candidate);
    const rel = relative(root, filePath);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep) ||
        rel.split(sep).some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error('Borg private state path is outside its private root');
    }
    return filePath;
}
async function inspectDirectory(directory, requiredUid, mode) {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Borg private state directory must be a real directory');
    }
    const result = identity(metadata);
    if (!ownerAllowed(result.uid, requiredUid)) {
        throw new Error('Borg private state directory has an unexpected owner');
    }
    if ((result.mode & 0o022) !== 0) {
        throw new Error('Borg private state directory has insecure permissions');
    }
    if (mode !== null && result.mode !== mode) {
        throw new Error('Borg private state directory has an unexpected mode');
    }
    return result;
}
async function inspectPrivateFile(filePath, requiredUid, mode) {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Borg private state file is not a regular file');
    }
    const result = identity(metadata);
    if ((requiredUid !== null && result.uid !== requiredUid) || result.mode !== mode) {
        throw new Error('Borg private state file is not private');
    }
    return result;
}
function pathSegments(path) {
    const root = resolve(path).split(sep)[0] === '' ? sep : resolve(path).slice(0, resolve(path).indexOf(sep) + 1);
    return resolve(path).slice(root.length).split(sep).filter(Boolean);
}
function ancestorPaths(path) {
    const paths = [];
    let current = resolve(path);
    while (true) {
        paths.unshift(current);
        const parent = dirname(current);
        if (parent === current)
            return paths;
        current = parent;
    }
}
/**
 * Validate the user home boundary, `.config`, and Borg root without collapsing
 * symlinks. Static unsafe objects fail closed. The same-user final pathname race
 * remains outside the single-user threat boundary because Node lacks portable
 * openat/renameat operations; this wrapper does not claim descriptor-relative
 * or race-free containment.
 */
export async function ensurePrivateBorgConfigRoot() {
    const home = assertCanonical(homedir());
    const config = join(home, '.config');
    const root = join(config, 'borgmcp');
    const uid = currentUid();
    const ancestorPathsForHome = ancestorPaths(home);
    const ancestorIdentities = await Promise.all(ancestorPathsForHome.map(async (directory) => ({
        directory,
        identity: await inspectDirectory(directory, uid, null),
    })));
    const verifyAncestors = async () => {
        for (const ancestor of ancestorIdentities) {
            const current = await inspectDirectory(ancestor.directory, uid, null);
            if (!sameIdentity(ancestor.identity, current)) {
                throw new Error('Borg private state ancestor identity changed');
            }
        }
    };
    await verifyAncestors();
    try {
        await lstat(config);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        await verifyAncestors();
        await mkdir(config, { mode: 0o700 });
        await verifyAncestors();
    }
    await inspectDirectory(config, uid, null);
    try {
        await lstat(root);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        await verifyAncestors();
        await mkdir(root, { mode: 0o700 });
        await verifyAncestors();
    }
    const rootBefore = await inspectDirectory(root, uid, null);
    if (uid !== null && rootBefore.uid !== uid) {
        throw new Error('Borg private state directory has an unexpected owner');
    }
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let closed = false;
    const close = async () => {
        if (closed)
            return;
        closed = true;
        await handle.close();
    };
    const verify = async () => {
        await verifyAncestors();
        await inspectDirectory(config, uid, null);
        const rootNow = await inspectDirectory(root, uid, 0o700);
        if (uid !== null && rootNow.uid !== uid) {
            throw new Error('Borg private state directory has an unexpected owner');
        }
        const fdNow = identity(await handle.stat());
        if (!sameObject(rootBefore, fdNow) || !sameIdentity(rootNow, fdNow)) {
            throw new Error('Borg private state identity changed');
        }
    };
    try {
        const opened = identity(await handle.stat());
        if (!sameObject(rootBefore, opened))
            throw new Error('Borg private state identity changed');
        if (opened.mode !== 0o700) {
            if ((opened.mode & 0o022) !== 0)
                throw new Error('Borg private state directory is writable by other users');
            await handle.chmod(0o700);
        }
        await verify();
        const ensureDirectory = async (directory) => {
            if (assertCanonical(directory) === root) {
                await verify();
                return;
            }
            const target = assertChildPath(root, directory);
            const parts = pathSegments(target).slice(pathSegments(root).length);
            let current = root;
            for (const part of parts) {
                current = join(current, part);
                try {
                    await lstat(current);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                    await mkdir(current, { mode: 0o700 });
                }
                const metadata = await inspectDirectory(current, uid, null);
                if (uid !== null && metadata.uid !== uid) {
                    throw new Error('Borg private state directory has an unexpected owner');
                }
                if (metadata.mode !== 0o700) {
                    if ((metadata.mode & 0o022) !== 0)
                        throw new Error('Borg private state directory has insecure permissions');
                    const child = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                    try {
                        const openedChild = identity(await child.stat());
                        if (!sameIdentity(metadata, openedChild))
                            throw new Error('Borg private state identity changed');
                        await child.chmod(0o700);
                    }
                    finally {
                        await child.close();
                    }
                }
            }
            await verify();
        };
        const readFile = async (filePath) => {
            const target = assertChildPath(root, filePath);
            const metadata = await inspectPrivateFile(target, uid, 0o600);
            const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const opened = identity(await file.stat());
                if (!sameIdentity(metadata, opened))
                    throw new Error('Borg private state file changed');
                return await file.readFile('utf8');
            }
            finally {
                await file.close();
            }
        };
        const appendFile = async (filePath, data) => {
            const target = assertChildPath(root, filePath);
            await ensureDirectory(dirname(target));
            const file = await open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
            try {
                const opened = identity(await file.stat());
                if (!opened || opened.uid !== uid && uid !== null || opened.mode !== 0o600) {
                    throw new Error('Borg private state file is not private');
                }
                await verify();
                await file.writeFile(data, 'utf8');
                await file.sync();
                await verify();
            }
            finally {
                await file.close();
            }
        };
        const atomicWrite = async (filePath, data, mode = 0o600) => {
            const target = assertChildPath(root, filePath);
            await ensureDirectory(dirname(target));
            let destination = null;
            try {
                destination = await inspectPrivateFile(target, uid, mode);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            const temp = `${target}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
            let owned = null;
            try {
                const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
                try {
                    owned = identity(await file.stat());
                    if (owned.uid !== uid && uid !== null || owned.mode !== mode)
                        throw new Error('Borg private state temporary file is not private');
                    await file.writeFile(data, 'utf8');
                    await file.sync();
                }
                finally {
                    await file.close();
                }
                await verify();
                const tempNow = await inspectPrivateFile(temp, uid, mode);
                if (!owned || !sameIdentity(owned, tempNow))
                    throw new Error('Borg private state temporary file changed');
                if (destination) {
                    const destinationNow = await inspectPrivateFile(target, uid, mode);
                    if (!sameIdentity(destination, destinationNow))
                        throw new Error('Borg private state destination changed');
                }
                await rename(temp, target);
                await verify();
                const committed = await inspectPrivateFile(target, uid, mode);
                if (!sameIdentity(owned, committed))
                    throw new Error('Borg private state destination changed');
                const directory = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
            }
            catch (error) {
                if (owned) {
                    try {
                        await verify();
                        const current = await inspectPrivateFile(temp, uid, mode);
                        if (sameIdentity(owned, current))
                            await unlink(temp);
                    }
                    catch {
                        // Never clean up through a path after root/child identity drift.
                    }
                }
                throw error;
            }
        };
        const unlinkIfUnchanged = async (filePath, expected) => {
            const target = assertChildPath(root, filePath);
            await verify();
            let current;
            try {
                current = await inspectPrivateFile(target, uid, 0o600);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return false;
                throw error;
            }
            if (expected && !sameIdentity(expected, current))
                throw new Error('Borg private state file changed');
            await unlink(target);
            await verify();
            return true;
        };
        const removeDirectory = async (directory) => {
            const target = assertChildPath(root, directory);
            await verify();
            const before = await inspectDirectory(target, uid, null);
            if (uid !== null && before.uid !== uid)
                throw new Error('Borg private state directory has an unexpected owner');
            await rm(target, { recursive: true, force: false });
            await verify();
        };
        return { path: root, verify, ensureDirectory, readFile, appendFile, atomicWrite, unlinkIfUnchanged, removeDirectory, close };
    }
    catch (error) {
        await close();
        throw error;
    }
}
//# sourceMappingURL=private-root.js.map