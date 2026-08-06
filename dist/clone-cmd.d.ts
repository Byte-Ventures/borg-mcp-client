/**
 * `borg clone <repo-url>` — clone a repository, create a safe sibling
 * worktree, and optionally launch Borg there.
 *
 * This command deliberately stops at a ready worktree. It does not
 * assimilate, create a seat, contact a cube, or persist Borg metadata. Git's
 * own repository metadata is the only durable state it creates.
 */
import type { CloneArgs } from './parse-clone-args.js';
export interface GitRunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export interface CloneDeps {
    runSync?: (cmd: string, args: string[], cwd?: string) => GitRunResult;
    cwd?: () => string;
    pathExists?: (path: string) => boolean;
    isDirectory?: (path: string) => boolean;
    readDirectory?: (path: string) => string[];
    removeTree?: (path: string) => void;
    mkdirp?: (path: string) => void;
    launch?: (cwd: string) => Promise<number>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
}
/** Redact URL userinfo and common credential-bearing URL forms. */
export declare function redactCloneSecrets(value: string): string;
/** Validate a clone source before it reaches Git's argv or any output. */
export declare function validateCloneRepositoryUrl(value: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** Run the clone flow. No Borg authority or seat is consulted. */
export declare function runClone(args: CloneArgs, providedDeps?: CloneDeps): Promise<number>;
//# sourceMappingURL=clone-cmd.d.ts.map