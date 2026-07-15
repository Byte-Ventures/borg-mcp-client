export type McpStartupTask = () => void | Promise<void>;
/** Required named services: omission from index wiring is a type error. */
export interface McpStartupServices {
    sessionStartHook: McpStartupTask;
    auditHook: McpStartupTask;
    sseStream: McpStartupTask;
    openCode: McpStartupTask;
    healthBeat: McpStartupTask;
}
/**
 * Run normal long-lived MCP child startup work. The assimilation readiness
 * child must reach the initialize response without acquiring leases, fetching
 * SSE, mutating hooks, or starting timers because it is intentionally killed
 * immediately after that response.
 */
export declare function runMcpStartupServices(readinessProbe: boolean, services: McpStartupServices): Promise<void>;
//# sourceMappingURL=startup-services.d.ts.map