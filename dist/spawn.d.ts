/**
 * `borg spawn` — deprecation stub.
 *
 * Replaced by `borg assimilate [role] --worktree <name>` (see
 * `assimilate-cmd.ts`). The new command folds worktree creation,
 * OAuth bootstrap, cube creation, template application, and drone
 * assimilation into one shell call. This file remains so existing
 * scripts and tab-completion entries fail loudly with an actionable
 * migration message rather than silently mis-routing.
 *
 * `validateName` continues to be re-exported from here for callers
 * that still depend on the symbol (it lives in `name-validator.ts`
 * now — single source of truth).
 */
export { validateName } from './name-validator.js';
export declare function runSpawn(): Promise<number>;
//# sourceMappingURL=spawn.d.ts.map