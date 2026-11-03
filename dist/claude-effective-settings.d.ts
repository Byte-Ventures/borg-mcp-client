import { spawn } from 'node:child_process';
/** Forward only settings-source switches. Passing a prompt, --resume, or a
 * print flag to this probe could start a generation. No initialize/user frame
 * is sent: get_settings reads native merged and per-source policy only. */
export declare function claudeSettingsArgs(args: readonly string[]): string[];
/** CLI tool selectors do not necessarily appear in get_settings. Inspect only
 * their flags, never a prompt or unrelated argument that mentions a tool. */
export declare function claudeToolPolicyArgs(args: readonly string[]): string[];
export declare function readClaudeEffectiveSettings(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, runtime?: {
    spawnProcess?: typeof spawn;
    timeoutMs?: number;
    maxResponseBytes?: number;
}): Promise<unknown>;
//# sourceMappingURL=claude-effective-settings.d.ts.map