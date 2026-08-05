import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { validateName } from './name-validator.js';
/** Environment names consumed by the optional foreign-path reminder hooks. */
export const BORG_LAUNCH_WORKTREE_ENV = 'BORG_LAUNCH_WORKTREE';
export const BORG_LAUNCH_SCRATCH_ENV = 'BORG_LAUNCH_SCRATCH';
export const BORG_LAUNCH_CLI_ENV = 'BORG_LAUNCH_CLI';
/**
 * Resolve the canonical per-seat scratch root.
 *
 * Drone labels are server-derived path components in the normal flow. Keep a
 * defensive fallback for malformed labels anyway: a server value must never
 * be allowed to escape the scratch parent, and the drone id gives a stable
 * collision-resistant directory name when the label is unusable.
 */
export function scratchRootForSeat(homeDir, droneLabel, droneId) {
    const label = validateName(droneLabel).ok
        ? droneLabel
        : `seat-${createHash('sha256').update(`${droneLabel}\0${droneId}`).digest('hex').slice(0, 24)}`;
    return join(resolve(homeDir), '.borg', 'scratch', label);
}
/** Build Codex's native launch-time additional-directory flags. */
export function codexLaunchDirectoryArgs(paths) {
    const directories = [...new Set([paths.worktree, paths.scratch].map((path) => resolve(path)))];
    return directories.flatMap((directory) => ['--add-dir', directory]);
}
//# sourceMappingURL=launch-access.js.map