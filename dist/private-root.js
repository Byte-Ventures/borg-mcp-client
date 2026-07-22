import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
export const borgConfigRoot = () => join(homedir(), '.config', 'borgmcp');
export function isBorgConfigPath(candidate) {
    const root = borgConfigRoot();
    return candidate === root || candidate.startsWith(`${root}${sep}`);
}
function expectedUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
        (Number(left.mode) & 0o777) === (Number(right.mode) & 0o777);
}
async function inspectRoot(root) {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Borg config root ${root} must be a real directory`);
    }
    const uid = expectedUid();
    if (uid !== null && metadata.uid !== uid) {
        throw new Error(`Borg config root ${root} is not owned by the current user`);
    }
    if ((metadata.mode & 0o022) !== 0) {
        throw new Error(`Borg config root ${root} has insecure permissions`);
    }
    return metadata;
}
/**
 * Opens and validates the Borg-owned root for a single-user host. Static unsafe
 * filesystem objects and detected identity drift fail closed. Node has no
 * cross-platform openat/renameat API, so an actively malicious same-uid process
 * that swaps an ancestor after the final check is outside this boundary; it
 * already has authority to read and replace this user's 0600 state directly.
 */
export async function ensurePrivateBorgConfigRoot() {
    const root = borgConfigRoot();
    const parent = dirname(root);
    if (!resolve(root).startsWith(`${resolve(dirname(root))}/`)) {
        throw new Error('Borg config root is not canonical');
    }
    try {
        const parentMetadata = await lstat(parent);
        if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
            throw new Error(`Borg config parent ${parent} must be a real directory`);
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        await mkdir(parent, { mode: 0o700 });
    }
    const canonicalRoot = join(await realpath(parent), 'borgmcp');
    try {
        await lstat(root);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        await mkdir(root, { mode: 0o700 });
    }
    const before = await inspectRoot(root);
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!sameIdentity(before, opened))
            throw new Error(`Borg config root ${root} changed during verification`);
        if ((opened.mode & 0o777) !== 0o700)
            await handle.chmod(0o700);
        const after = await handle.stat();
        const resolved = await realpath(root);
        const current = await stat(root);
        if (resolved !== canonicalRoot || !sameIdentity(after, current) || (after.mode & 0o777) !== 0o700) {
            throw new Error(`Borg config root ${root} changed during verification`);
        }
        return {
            path: root,
            verify: async () => {
                const currentPath = await lstat(root);
                const currentHandle = await handle.stat();
                if (!sameIdentity(after, currentHandle) || !sameIdentity(currentHandle, currentPath) ||
                    (currentHandle.mode & 0o777) !== 0o700 || await realpath(root) !== canonicalRoot) {
                    throw new Error(`Borg config root ${root} changed during operation`);
                }
            },
            close: async () => handle.close(),
        };
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
//# sourceMappingURL=private-root.js.map