import type { AssimilateFlags } from './assimilate-cmd.js';
export interface ParseAssimilateResult {
    ok: true;
    role: string | undefined;
    flags: AssimilateFlags;
}
export type ParseResult = ParseAssimilateResult | {
    ok: false;
    error: string;
};
/**
 * Parse argv for `borg assimilate [role] [--worktree <n>] [--template <n>]
 * [--no-template] [--cube-name <n>] [--host <host>] [--enroll] [--here] [--yes]`. The `assimilate`
 * subcommand token must already be stripped by the caller.
 */
export declare function parseAssimilateArgs(rawArgs: string[]): ParseResult;
//# sourceMappingURL=parse-assimilate-args.d.ts.map