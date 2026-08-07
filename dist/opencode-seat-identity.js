import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export class OpenCodeSeatIdentityError extends Error {
    code;
    sessionDirectory;
    seat;
    constructor(code, message, sessionDirectory, seat) {
        super(message);
        this.code = code;
        this.sessionDirectory = sessionDirectory;
        this.seat = seat;
        this.name = 'OpenCodeSeatIdentityError';
    }
}
export async function resolveOpenCodeSeatIdentity(deps) {
    let roots;
    try {
        roots = await deps.listRoots();
    }
    catch {
        throw new OpenCodeSeatIdentityError('ROOTS_UNAVAILABLE', 'OpenCode did not provide its session directory.');
    }
    if (!Array.isArray(roots.roots) || roots.roots.length !== 1) {
        throw new OpenCodeSeatIdentityError('ROOTS_INVALID', 'OpenCode must provide exactly one local session directory.');
    }
    const uri = roots.roots[0]?.uri;
    let sessionDirectory;
    try {
        const parsed = new URL(typeof uri === 'string' ? uri : '');
        if (parsed.protocol !== 'file:' || parsed.hostname || parsed.search || parsed.hash)
            throw new Error();
        sessionDirectory = resolve(fileURLToPath(parsed));
    }
    catch {
        throw new OpenCodeSeatIdentityError('ROOTS_INVALID', 'OpenCode provided an invalid or non-local session directory.');
    }
    const sessionWorktree = deps.findProjectRoot(sessionDirectory);
    const cwdWorktree = deps.findProjectRoot(deps.childCwd);
    // Direct `borg` launch keeps cwd as its seat source. When a shared OpenCode
    // server spawns the MCP child elsewhere, the session-scoped root is the
    // launcher-conferred pin and replaces that ambient cwd inference.
    const identityWorktree = cwdWorktree === sessionWorktree
        ? cwdWorktree
        : sessionWorktree;
    const active = await deps.getActiveCubeForWorktree(identityWorktree);
    if (!active) {
        throw new OpenCodeSeatIdentityError('SEAT_NOT_FOUND', 'No Borg drone is bound to the OpenCode session directory.', sessionWorktree);
    }
    if (typeof active.worktree !== 'string' || resolve(active.worktree) !== resolve(sessionWorktree)) {
        throw new OpenCodeSeatIdentityError('SEAT_WORKTREE_MISMATCH', 'The resolved Borg drone belongs to a different worktree than the OpenCode session.', sessionWorktree, active);
    }
    deps.pinSeatIdentity(active);
    return active;
}
export function formatOpenCodeSeatIdentityError(error, childCwd) {
    const lines = [
        `Borg OpenCode identity error [${error.code}]`,
        '',
        error.message,
        `- OpenCode session directory: ${error.sessionDirectory ?? 'unavailable'}`,
        `- Borg MCP child cwd: ${childCwd}`,
    ];
    if (error.seat) {
        lines.push(`- Resolved drone: ${error.seat.droneLabel} (${error.seat.worktree})`);
    }
    lines.push('', 'The Borg stream and OpenCode wake injection were not started.', 'Exit this session and run `borg --cli opencode` from the intended worktree. If that worktree\'s saved connection is stale, run `borg reset-local-connection` from that exact worktree before assimilating again.');
    return lines.join('\n');
}
//# sourceMappingURL=opencode-seat-identity.js.map