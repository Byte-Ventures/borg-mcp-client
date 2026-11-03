import { spawn } from 'node:child_process';
/** Forward only settings-source switches. Passing a prompt, --resume, or a
 * print flag to this probe could start a generation. Bare mode suppresses
 * startup hooks and plugin execution while retaining the
 * native settings snapshot. No initialize/user frame is sent. */
export declare function claudeSettingsArgs(args: readonly string[]): string[];
/** Split selector lists while preserving tool input specifiers. */
export declare function splitClaudeToolSelectors(value: string): string[];
/** Keep each CLI flag's effect and occurrence separate. A deny selector can
 * never supply the missing counterpart for an allow or availability selector. */
export declare function claudeToolPolicyArgs(args: readonly string[]): Array<Partial<Record<'allow' | 'deny' | 'tools', string[]>>>;
export declare function readClaudeEffectiveSettings(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, runtime?: {
    spawnProcess?: typeof spawn;
    timeoutMs?: number;
    maxResponseBytes?: number;
}): Promise<unknown>;
//# sourceMappingURL=claude-effective-settings.d.ts.map