/** Environment contract for the short-lived `borg assimilate` MCP readiness child. */
export declare const MCP_READINESS_PROBE_ENV = "BORG_MCP_READINESS_PROBE";
export declare function isMcpReadinessProbe(env?: NodeJS.ProcessEnv): boolean;
export declare function readinessProbeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
//# sourceMappingURL=readiness-probe.d.ts.map