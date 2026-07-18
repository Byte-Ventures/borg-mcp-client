/**
 * `borg reset-local-seat [--host <host>] [--yes]` — the dedicated LOCAL/OFFLINE
 * seat reset from the ratified client-seat-reset-state-model (Option W).
 *
 * Attach is PURE DIAGNOSIS on a pin-matched SESSION_REJECTED (it mutates
 * nothing and points here). This command is the ONLY writer that intentionally
 * clears a worktree's saved local seat. It performs ZERO network I/O: it never
 * contacts the server, so it makes NO server-revocation claim. It clears ONLY
 * this worktree's cubes.json binding + its keychain session credential
 * (keyed on findProjectRoot()) — server, trust anchor, cube, and every sibling
 * worktree are untouched.
 *
 * Flow (decision clause 2):
 *   S0  snapshot exact binding + token-safe credential observation
 *       (PRESENT(digest) | ABSENT); --host normalized-mismatch = no-op BEFORE
 *       any mutation; no local binding = honest no-op.
 *   S1  consent OUTSIDE any lock — TTY [y/N] defaulting to No; non-TTY requires
 *       the explicit --yes flag.
 *   S2/S3  re-acquire cube→keychain, re-verify the exact snapshot (any change /
 *       missing / same-ref replacement = honest no-op), then delete the
 *       CREDENTIAL FIRST and remove the binding.
 */
import { createInterface } from 'node:readline/promises';
import { snapshotLocalSeat as cubesSnapshotLocalSeat, resetLocalSeatBinding as cubesResetLocalSeatBinding, findProjectRoot as cubesFindProjectRoot, } from './cubes.js';
import { normalizeServerEndpoint } from './server-endpoint.js';
function reenrollCommand(apiUrl) {
    return `\`borg assimilate --host ${apiUrl} --enroll\``;
}
/**
 * Recovery guidance shared by the success + honest-no-op copy. Makes NO
 * server-revocation claim: it recommends the operator issue a LIVE scoped
 * invitation (the server can stay running) and re-enroll from this worktree.
 */
function recoveryGuidance(apiUrl) {
    return ('To rejoin: ask the server operator for a new enrollment invitation — the server can ' +
        'stay running (`borg-mcp-server client-invite`, or `owner-invite` for an owner) — then ' +
        `re-enroll from this worktree with ${reenrollCommand(apiUrl)}.\n`);
}
export async function runResetLocalSeat(flags, deps) {
    const worktree = deps.findProjectRoot(deps.cwd());
    // Normalize --host up front so an unparseable value fails before any read.
    let requestedHost;
    if (flags.host !== undefined) {
        try {
            requestedHost = deps.normalizeHost(flags.host);
        }
        catch (error) {
            deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
        }
    }
    // ----- S0: snapshot -----
    const snapshot = await deps.snapshotLocalSeat();
    if (!snapshot) {
        deps.stdout(`No saved local seat was found for this worktree (${worktree}); nothing to reset.\n`);
        return 0;
    }
    // --host normalized-mismatch = honest no-op BEFORE any mutation. This worktree
    // points at a different server than the one named, so it is not the seat the
    // operator asked to reset.
    if (requestedHost !== undefined && requestedHost !== snapshot.apiUrl) {
        deps.stdout(`This worktree's saved local seat is on ${snapshot.apiUrl}, not ${requestedHost}; ` +
            `nothing was changed. Re-run \`borg reset-local-seat --host ${snapshot.apiUrl}\` to ` +
            "reset this worktree's seat.\n");
        return 0;
    }
    const observed = snapshot.observation.state !== 'absent'
        ? `a saved local session credential is present (${snapshot.observation.state})`
        : 'the saved local session credential is already cleared (only the binding remains)';
    deps.stderr(`This will clear ONLY this worktree's saved local seat on ${snapshot.apiUrl} ` +
        `(worktree ${worktree}) — ${observed}. Server, trust anchor, cube, and sibling ` +
        'worktrees are left untouched. It makes no network call and revokes nothing server-side.\n');
    // ----- S1: consent OUTSIDE any lock -----
    if (deps.isTTY()) {
        const answer = await deps.prompt(`Reset this worktree's saved local seat now? [y/N]: `);
        const normalized = answer.trim().toLowerCase();
        if (normalized !== 'y' && normalized !== 'yes') {
            deps.stderr("audit: no changes made — this worktree's saved seat was left in place.\n");
            return 0;
        }
    }
    else if (flags.yes !== true) {
        deps.stderr('audit: no changes made — stdin is non-interactive and --yes was not passed. Re-run ' +
            '`borg reset-local-seat --yes` to clear this worktree\'s saved seat without a prompt.\n');
        return 1;
    }
    // ----- S2/S3: re-verify under lock, credential-FIRST delete, then binding -----
    let outcome;
    try {
        outcome = await deps.resetLocalSeatBinding(snapshot);
    }
    catch {
        deps.stderr(`audit: no changes made — the local seat reset for ${snapshot.apiUrl} (worktree ` +
            `${worktree}) could not complete (local credential store error). Retry — it is ` +
            'safe to re-run.\n');
        return 1;
    }
    if (outcome.outcome === 'reset') {
        deps.stderr(`audit: this worktree's saved local seat for ${snapshot.apiUrl} (worktree ${worktree}) ` +
            'was cleared; server, trust anchor, cube, and sibling worktrees unchanged.\n');
        deps.stdout(recoveryGuidance(snapshot.apiUrl));
        return 0;
    }
    if (outcome.outcome === 'no-binding') {
        deps.stdout(`No saved local seat remained for this worktree (${worktree}); nothing to reset.\n`);
        return 0;
    }
    // 'changed': the seat drifted between the snapshot and the commit re-check
    // (a concurrent re-enroll wrote a fresh bearer, or another process already
    // reset it). Never clobber a replacement — report the honest no-op.
    deps.stdout(`This worktree's saved local seat on ${snapshot.apiUrl} changed since it was read ` +
        "(a concurrent re-enroll or reset); nothing was changed. Re-run to observe the current " +
        'state.\n');
    return 0;
}
export function buildDefaultResetLocalSeatDeps() {
    return {
        snapshotLocalSeat: () => cubesSnapshotLocalSeat(),
        resetLocalSeatBinding: (expected) => cubesResetLocalSeatBinding(expected),
        findProjectRoot: (cwd) => cubesFindProjectRoot(cwd),
        normalizeHost: (host) => normalizeServerEndpoint(host),
        cwd: () => process.cwd(),
        isTTY: () => process.stdin.isTTY === true,
        prompt: async (message) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return await rl.question(message);
            }
            finally {
                rl.close();
            }
        },
        stdout: (line) => process.stdout.write(line),
        stderr: (line) => process.stderr.write(line),
    };
}
/** Parse args after `borg reset-local-seat`. Supports `--host <h>` / `--host=<h>` / `--yes` / `-y`. */
export function parseResetLocalSeatArgs(rawArgs) {
    const flags = {};
    for (let i = 0; i < rawArgs.length; i += 1) {
        const arg = rawArgs[i];
        if (arg === '--host') {
            const next = rawArgs[i + 1];
            if (typeof next !== 'string' || next.length === 0 || next.startsWith('-')) {
                return { ok: false, error: '--host requires a host or URL (e.g. `--host localhost:7091`)' };
            }
            flags.host = next;
            i += 1;
        }
        else if (arg.startsWith('--host=')) {
            const value = arg.slice('--host='.length);
            if (!value) {
                return { ok: false, error: '--host requires a host or URL (e.g. `--host localhost:7091`)' };
            }
            flags.host = value;
        }
        else if (arg === '--yes' || arg === '-y') {
            flags.yes = true;
        }
        else {
            return {
                ok: false,
                error: `unexpected argument: ${arg}. Usage: borg reset-local-seat [--host <host>] [--yes]`,
            };
        }
    }
    return { ok: true, flags };
}
//# sourceMappingURL=reset-local-seat-cmd.js.map