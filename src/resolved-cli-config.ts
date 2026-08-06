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
export function configureResolvedCli(
  cli: BorgCli,
  deps: ResolvedCliConfigDeps,
): void {
  if (cli === 'claude') {
    deps.ensureMcp('claude');
    // The project-local SessionStart hook is the launch-time self-heal for
    // the CLI actually being launched. Remove only the obsolete global hook
    // after the local hook is in place, then keep the Claude prompt hook in
    // its existing global location.
    deps.addClaudeProjectSessionStartHook();
    deps.removeClaudeGlobalSessionStartHook();
    deps.addClaudeUserPromptSubmitHook();
    return;
  }

  if (cli === 'codex') {
    deps.ensureMcp('codex');
    deps.addCodexSessionStartHook();
    deps.addCodexUserPromptSubmitHook();
    return;
  }

  deps.ensureMcp('opencode');
}
