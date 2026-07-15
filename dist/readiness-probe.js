/** Environment contract for the short-lived `borg assimilate` MCP readiness child. */
export const MCP_READINESS_PROBE_ENV = 'BORG_MCP_READINESS_PROBE';
export function isMcpReadinessProbe(env = process.env) {
    return env[MCP_READINESS_PROBE_ENV] === '1';
}
export function readinessProbeEnv(env = process.env) {
    return { ...env, [MCP_READINESS_PROBE_ENV]: '1' };
}
//# sourceMappingURL=readiness-probe.js.map