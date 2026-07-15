/** Environment contract for the short-lived `borg assimilate` MCP readiness child. */
export const MCP_READINESS_PROBE_ENV = 'BORG_MCP_READINESS_PROBE';

export function isMcpReadinessProbe(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MCP_READINESS_PROBE_ENV] === '1';
}

export function readinessProbeEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...env, [MCP_READINESS_PROBE_ENV]: '1' };
}
