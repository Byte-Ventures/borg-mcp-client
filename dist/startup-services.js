/**
 * Run normal long-lived MCP child startup work. The assimilation readiness
 * child must reach the initialize response without acquiring leases, fetching
 * SSE, mutating hooks, or starting timers because it is intentionally killed
 * immediately after that response.
 */
export async function runMcpStartupServices(readinessProbe, services) {
    if (readinessProbe)
        return;
    const tasks = [
        services.sessionStartHook,
        services.auditHook,
        services.sseStream,
        services.openCode,
    ];
    for (const task of tasks) {
        try {
            await task();
        }
        catch {
            // Every background service is best-effort and independent. A failure in
            // one must neither break MCP initialize nor suppress later services.
        }
    }
}
//# sourceMappingURL=startup-services.js.map