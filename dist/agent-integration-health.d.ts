import { type ManagedAgentHookConfigHealth } from './config-utils.js';
export declare const AGENT_HOOK_BINS: readonly ["borg-regen", "borg-clear-rewake", "borg-log-audit", "borg-foreign-path-reminder", "borg-inbox-monitor"];
export type AgentHookBinName = typeof AGENT_HOOK_BINS[number];
export interface AgentHookBinHealth {
    name: AgentHookBinName;
    status: 'ok' | 'missing' | 'wrong-owner' | 'version-skew' | 'unreadable';
    resolvedPath?: string;
    owner?: string;
    version?: string;
    detail?: string;
}
export interface AgentIntegrationHealth {
    expectedVersion: string;
    bins: AgentHookBinHealth[];
    issues: Array<AgentHookBinHealth | ManagedAgentHookConfigHealth | OpenCodePluginHealth>;
    hookConfigs: ManagedAgentHookConfigHealth[];
    openCodePlugin: OpenCodePluginHealth;
}
export interface OpenCodePluginHealth {
    path: string;
    configured: boolean;
    status: 'ok' | 'present' | 'absent' | 'missing' | 'outdated' | 'unreadable' | 'refused';
    version?: string;
    detail?: string;
}
export interface InspectAgentIntegrationHealthOptions {
    expectedVersion?: string;
    path?: string;
    homeDir?: string;
    resolveBin?: (name: AgentHookBinName, searchPath: string | undefined) => string | null;
}
export declare function inspectAgentIntegrationHealth(options?: InspectAgentIntegrationHealthOptions): AgentIntegrationHealth;
export declare function renderAgentIntegrationHealth(report: AgentIntegrationHealth): string;
export declare function assertAgentIntegrationHealthy(report: AgentIntegrationHealth): void;
export declare function runDoctor(options?: InspectAgentIntegrationHealthOptions & {
    stdout?: (text: string) => void;
    openCodeStartupLogPath?: string;
}): number;
export declare function renderOpenCodeStartupDiagnostics(logPath: string): string;
export declare function warnIfAgentIntegrationUnhealthy(options?: InspectAgentIntegrationHealthOptions & {
    stderr?: (text: string) => void;
}): boolean;
/** Update-time whole-integration refresh. Attempt each independent surface so
 * one malformed config does not hide later repairs, then aggregate failures. */
export declare function refreshAndVerifyManagedAgentIntegrations(): void;
//# sourceMappingURL=agent-integration-health.d.ts.map