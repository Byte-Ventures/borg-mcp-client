import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
/**
 * Optional alternate home root for isolated client runs. The value is the
 * replacement home directory, not the `.config/borgmcp` directory itself, so
 * every client-owned path (credentials, seats, worktrees, and agent config)
 * stays under one root.
 */
export const BORG_STATE_ROOT_ENV = 'BORG_STATE_ROOT';
function configuredStateRoot() {
    const configured = process.env[BORG_STATE_ROOT_ENV];
    if (configured === undefined)
        return null;
    if (configured.length === 0 ||
        !isAbsolute(configured) ||
        resolve(configured) !== configured) {
        throw new Error(`${BORG_STATE_ROOT_ENV} must be an absolute canonical path`);
    }
    return configured;
}
/** Resolve the effective home root used by all Borg-owned local state. */
export function borgHomeRoot() {
    return configuredStateRoot() ?? realpathSync(homedir());
}
export const borgConfigRoot = () => join(borgHomeRoot(), '.config', 'borgmcp');
/**
 * Environment used when a native agent CLI registers Borg. The CLI must write
 * its own config under the same effective root that config-utils reads; the
 * eventual MCP child receives BORG_STATE_ROOT separately via its registration.
 */
export function borgAgentConfigEnv(env = process.env) {
    const root = borgHomeRoot();
    return {
        ...env,
        HOME: root,
        CODEX_HOME: join(root, '.codex'),
        XDG_CONFIG_HOME: join(root, '.config'),
    };
}
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