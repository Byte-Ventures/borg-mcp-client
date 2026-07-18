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
import { type LocalSeatSnapshot, type ResetLocalSeatOutcome } from './cubes.js';
export interface ResetLocalSeatFlags {
    host?: string;
    yes?: boolean;
}
export interface ResetLocalSeatDeps {
    snapshotLocalSeat: () => Promise<LocalSeatSnapshot | null>;
    resetLocalSeatBinding: (expected: LocalSeatSnapshot) => Promise<ResetLocalSeatOutcome>;
    findProjectRoot: (cwd: string) => string;
    normalizeHost: (host: string) => string;
    cwd: () => string;
    isTTY: () => boolean;
    prompt: (message: string) => Promise<string>;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
}
export declare function runResetLocalSeat(flags: ResetLocalSeatFlags, deps: ResetLocalSeatDeps): Promise<number>;
export declare function buildDefaultResetLocalSeatDeps(): ResetLocalSeatDeps;
export type ResetLocalSeatParseResult = {
    ok: true;
    flags: ResetLocalSeatFlags;
} | {
    ok: false;
    error: string;
};
/** Parse args after `borg reset-local-seat`. Supports `--host <h>` / `--host=<h>` / `--yes` / `-y`. */
export declare function parseResetLocalSeatArgs(rawArgs: string[]): ResetLocalSeatParseResult;
//# sourceMappingURL=reset-local-seat-cmd.d.ts.map