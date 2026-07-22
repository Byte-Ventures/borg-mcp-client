import { chmod, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
export const borgConfigRoot = () => join(homedir(), '.config', 'borgmcp');
/** Ensure Borg's local state root exists with owner-only directory permissions. */
export async function ensurePrivateBorgConfigRoot(root = borgConfigRoot()) {
    if (!isAbsolute(root) || resolve(root) !== root) {
        throw new Error('Borg private-state directory path is not canonical');
    }
    let metadata;
    try {
        metadata = await lstat(root);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        await mkdir(root, { recursive: true, mode: 0o700 });
        metadata = await lstat(root);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Borg private-state directory must be a real directory');
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && metadata.uid !== uid) {
        throw new Error('Borg private-state directory is not owned by the current user');
    }
    const mode = metadata.mode & 0o777;
    if ((mode & 0o022) !== 0) {
        throw new Error('Borg private-state directory is writable by other users');
    }
    if (mode !== 0o700) {
        await chmod(root, 0o700);
    }
    const final = await lstat(root);
    if (!final.isDirectory() || (final.mode & 0o777) !== 0o700) {
        throw new Error('Borg private-state directory is not private');
    }
}
//# sourceMappingURL=private-root.js.map