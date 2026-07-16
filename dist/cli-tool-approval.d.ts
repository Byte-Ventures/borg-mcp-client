import { spawn } from 'node:child_process';
import type { BorgCli } from './cubes.js';
/**
 * Client #20: the narrow coordination surface a borg-launched agent needs
 * without an approval round-trip. Keep the direct-tool list deliberately
 * smaller than the complete Borg MCP surface. borg_tool's transitive scope is
 * disclosed separately before consent.
 */
export declare const BORG_COORDINATION_TOOLS: readonly ["regen", "log", "read-log", "roster", "ack", "stream-status", "whoami", "cube", "role", "playbook", "tool", "describe-tool"];
export declare const CODEX_BORG_COORDINATION_TOOLS: string[];
export declare const OPENCODE_BORG_COORDINATION_TOOLS: string[];
export declare const BORG_DISPATCHER_APPROVAL_DISCLOSURE = "This set includes borg_tool: approving the dispatcher also approves any Borg operation invoked through it.";
type OpenCodePermissionAction = 'allow' | 'ask' | 'deny';
export interface ApprovalInspection {
    restrictiveTools: string[];
    repairSnippet: string;
}
export interface LaunchApprovalDecision {
    codexArgs: string[];
    openCodePermission?: string;
    warning?: string;
}
export declare function codexApprovalRepairSnippet(tools?: string[]): string;
export declare function inspectCodexBorgApprovals(config: unknown): ApprovalInspection;
export declare function openCodeApprovalRepairObject(tools?: string[]): Record<string, OpenCodePermissionAction>;
/** Preserve every existing OpenCode permission rule, then append the exact
 * Borg coordination allows. This remains safe whether OPENCODE_PERMISSION is
 * deep-merged or replaces the configured permission value. */
export declare function mergeOpenCodePermission(permission: unknown, tools?: string[]): Record<string, unknown>;
export declare function inspectOpenCodeBorgApprovals(config: unknown): ApprovalInspection;
export declare function codexBorgApprovalArgs(tools?: string[]): string[];
export interface ApprovalIo {
    readCodexConfig: (approvalArgs?: string[]) => Promise<unknown> | unknown;
    readOpenCodeConfig: (permissionOverride?: string) => Promise<unknown> | unknown;
    isTTY: () => boolean;
    confirm: (message: string) => Promise<string>;
}
export interface EffectiveConfigOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    /** User-selected Codex profile/config flags, in their launch precedence. */
    codexArgs: string[];
    loadCodex?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
    loadOpenCode?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<unknown> | unknown;
}
export interface CodexEffectiveConfigRuntime {
    spawnProcess?: typeof spawn;
    timeoutMs?: number;
    maxResponseBytes?: number;
}
/** Keep only flags that participate in Codex config resolution. They are
 * replayed after Borg's hypothetical approval flags, matching real launch
 * precedence without passing prompts/images/remote-control flags to the
 * config-reader process. */
export declare function codexEffectiveConfigArgs(args: string[]): string[];
export declare function readCodexEffectiveConfig(args: string[], cwd: string, env: NodeJS.ProcessEnv, runtime?: CodexEffectiveConfigRuntime): Promise<unknown>;
export declare function readOpenCodeEffectiveConfig(cwd: string, env: NodeJS.ProcessEnv): unknown;
export declare function defaultApprovalIo(confirm: (message: string) => Promise<string>, isTTY: () => boolean, options?: Partial<EffectiveConfigOptions>): ApprovalIo;
export declare function resolveLaunchBorgApprovals(cli: BorgCli, io: ApprovalIo): Promise<LaunchApprovalDecision>;
export declare function buildOpenCodeLaunchArgs(cwd: string, port: number, prompt: string, passthroughArgs?: string[]): string[];
export declare function setupApprovalWarnings(deps: Pick<ApprovalIo, 'readCodexConfig' | 'readOpenCodeConfig'>, selected?: {
    codex?: boolean;
    opencode?: boolean;
}): Promise<string[]>;
export {};
//# sourceMappingURL=cli-tool-approval.d.ts.map