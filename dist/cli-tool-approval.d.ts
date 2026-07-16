import type { BorgCli } from './cubes.js';
/**
 * Client #20: the narrow coordination surface a borg-launched agent needs
 * without an approval round-trip. Keep this list deliberately smaller than
 * the complete Borg MCP surface: deferred product/admin tools still follow the
 * operator's normal agent policy.
 */
export declare const BORG_COORDINATION_TOOLS: readonly ["regen", "log", "read-log", "roster", "ack", "stream-status", "whoami", "tool", "describe-tool"];
export declare const CODEX_BORG_COORDINATION_TOOLS: string[];
export declare const OPENCODE_BORG_COORDINATION_TOOLS: string[];
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
export declare function inspectCodexBorgApprovals(text: string): ApprovalInspection;
export declare function openCodeApprovalRepairObject(tools?: string[]): Record<string, OpenCodePermissionAction>;
/** Preserve every existing OpenCode permission rule, then append the exact
 * Borg coordination allows. This remains safe whether OPENCODE_PERMISSION is
 * deep-merged or replaces the configured permission value. */
export declare function mergeOpenCodePermission(permission: unknown, tools?: string[]): Record<string, unknown>;
export declare function inspectOpenCodeBorgApprovals(config: unknown): ApprovalInspection;
export declare function codexBorgApprovalArgs(tools?: string[]): string[];
export interface ApprovalIo {
    readCodexConfig: () => string;
    readOpenCodeConfig: () => unknown;
    isTTY: () => boolean;
    confirm: (message: string) => Promise<string>;
}
export declare function defaultApprovalIo(confirm: (message: string) => Promise<string>, isTTY: () => boolean, env?: NodeJS.ProcessEnv): ApprovalIo;
export declare function resolveLaunchBorgApprovals(cli: BorgCli, io: ApprovalIo): Promise<LaunchApprovalDecision>;
export declare function buildOpenCodeLaunchArgs(cwd: string, port: number, prompt: string, passthroughArgs?: string[]): string[];
export declare function setupApprovalWarnings(deps: Pick<ApprovalIo, 'readCodexConfig' | 'readOpenCodeConfig'>): string[];
export {};
//# sourceMappingURL=cli-tool-approval.d.ts.map