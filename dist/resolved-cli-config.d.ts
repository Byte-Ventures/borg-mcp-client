import type { BorgCli } from './cubes.js';
export interface ResolvedCliConfigDeps {
    ensureMcp(cli: BorgCli): void;
    addClaudeProjectSessionStartHook(): void;
    removeClaudeGlobalSessionStartHook(): void;
    addClaudeUserPromptSubmitHook(): void;
    addCodexSessionStartHook(): void;
    addCodexUserPromptSubmitHook(): void;
}
/**
 * Apply only the integration writes for the CLI the launcher resolved.
 * In particular, a Claude installation must not cause Codex or OpenCode
 * configuration to be repaired as a side effect of a bare `borg` launch.
 */
export declare function configureResolvedCli(cli: BorgCli, deps: ResolvedCliConfigDeps): void;
//# sourceMappingURL=resolved-cli-config.d.ts.map