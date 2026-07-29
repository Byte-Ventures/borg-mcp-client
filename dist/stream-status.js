/**
 * Renderer + inbox-Monitor liveness probe for `borg_stream-status`.
 *
 * Split out from `index.ts` so the 5-state precedence logic and the
 * `pgrep`-based liveness check can be unit-tested without spinning up
 * the MCP server. drone-4's 18:30:51 UX contract is the spec for the
 * rendered output shape; this module is the implementation surface.
 *
 * Top-line states (drone-4 contract):
 *   1. Stream not started.
 *   2. Stream connected, awaiting first content event.
 *   3. Stream connected, last content <X> ago.
 *   4. Stream disconnected (reconnect attempt N).
 *   5. Stream connected (no inbox-Monitor — wake path broken).
 *
 * Precedence when both `disconnected` and `no inbox-Monitor` apply:
 *   prefer (4) — wire-disconnect is the upstream cause and resolves
 *   automatically when the wire comes back up; State 5 only matters
 *   when the wire is healthy but the file-watch isn't.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { heartbeatPathFor, legacyHeartbeatPathFor, HEARTBEAT_STALE_MS, } from './inbox-monitor.js';
import { shellEscape } from './shell-escape.js';
/**
 * Best-effort check: is a process tailing this inbox file?
 *
 * Returns:
 *   - true: at least one process matches `tail.*<inboxPath>` in pgrep
 *   - false: pgrep ran cleanly and found no match
 *   - null: cannot determine (pgrep unavailable, spawn error, no inbox path)
 *
 * The null case is informative — it means we don't know, so the
 * renderer must NOT fire State 5 (which would be misleading). State 5
 * only fires when we positively know the wake path is broken.
 *
 * Why `pgrep` and not a more elegant check: Claude Code Monitors are
 * tail-based subprocesses spawned by the harness, completely opaque to
 * the MCP server. The MCP server has no IPC channel into the harness's
 * task table. The cheapest reliable signal we can get from inside the
 * MCP server is "is there a tail subprocess open against this path?"
 * — which is what `pgrep -f` answers.
 *
 * macOS + Linux ship `pgrep`. Windows doesn't (borgmcp targets Mac /
 * Linux per package.json `os` field; the null branch handles other
 * platforms gracefully).
 */
export function checkInboxMonitorHealthy(inboxPath, monitorStateRoot) {
    if (!inboxPath)
        return null;
    try {
        // `-f` matches against the full command line so we catch the
        // `tail -n 0 -F <inboxPath>` form. `-l` lists matches; we only
        // need the exit code (0 = match, 1 = no match) and a sanity check
        // on stdout (some pgrep variants exit 0 with empty stdout under
        // permission errors — treat empty stdout as "no match" for safety).
        const res = spawnSync('pgrep', ['-f', inboxPath], {
            encoding: 'utf-8',
            timeout: 2_000,
        });
        if (res.error)
            return null;
        if (res.status === 0 && res.stdout.trim().length > 0) {
            // gh#822: a tail PROCESS is present — but presence ≠ health (a hung tail
            // still matches pgrep). Upgrade presence→health via the holder heartbeat
            // sidecar: if it exists and is STALE past the conservative threshold, the
            // holder is wedged → wake path broken (false). If it's fresh → healthy.
            // If it's ABSENT, fall back to presence (an old pre-#822 monitor, or a
            // #822 monitor armed <1 tick ago that hasn't written its first heartbeat)
            // → report healthy; never false-flag a monitor that simply lacks the
            // sidecar (conservative — err toward NOT warning).
            return !isHeartbeatStale(inboxPath, monitorStateRoot);
        }
        if (res.status === 1)
            return false;
        // pgrep exits 2 for syntax error, 3 for fatal — treat as unknown.
        return null;
    }
    catch {
        return null;
    }
}
/**
 * gh#822: are all present holder heartbeat sidecars stale past the threshold?
 * A fresh legacy sidecar wins during migration; absent sidecars (old monitor /
 * just-armed) still fall back to process presence. Only present-and-all-stale
 * state is a wedged-holder signal.
 */
export function isHeartbeatStale(inboxPath, monitorStateRoot) {
    const paths = [heartbeatPathFor(inboxPath, monitorStateRoot)];
    if (monitorStateRoot)
        paths.push(legacyHeartbeatPathFor(inboxPath));
    let sawHeartbeat = false;
    for (const path of new Set(paths)) {
        try {
            const mtimeMs = statSync(path).mtimeMs;
            sawHeartbeat = true;
            if (Date.now() - mtimeMs <= HEARTBEAT_STALE_MS)
                return false;
        }
        catch {
            // absent / unreadable → keep evaluating the migration counterpart
        }
    }
    return sawHeartbeat;
}
/**
 * Render the `borg_stream-status` markdown body per drone-4's 18:30:51
 * contract. Pure function — no I/O, no clock reads. Caller assembles
 * the inputs.
 */
export function renderStreamStatus(inputs) {
    const { status, inboxMonitorHealthy, inboxPath, monitorStateRoot, droneLabel, cubeName, humanAgo } = inputs;
    const wakePath = inputs.wakePath ?? {
        agentKind: 'claude',
        healthy: inboxMonitorHealthy,
        openCode: null,
    };
    const wakePathHealthy = wakePath.healthy;
    const isNotStarted = status.reconnectAttempts === 0 &&
        status.lastWireActivityAt === null &&
        !status.connected;
    const ownedByOther = status.ownership?.state === 'owned-by-other-process';
    const orphanedInitialization = status.ownership?.state === 'orphaned-initialization';
    const ownershipInitializing = status.ownership?.state === 'initializing';
    // Top-line verdict — 5 states + runtime wake-path override.
    // Precedence: disconnected > wake-path failure.
    let summary;
    if (orphanedInitialization) {
        summary = '**Stream blocked by an orphaned initialization lock.**';
    }
    else if (ownedByOther) {
        summary = '**Stream owned by another Borg MCP process.**';
    }
    else if (isNotStarted) {
        summary = '**Stream not started.**';
    }
    else if (!status.connected) {
        summary = `**Stream disconnected (reconnect attempt ${status.reconnectAttempts}).**`;
    }
    else if (wakePathHealthy === false) {
        summary = wakePath.agentKind === 'opencode'
            ? '**Stream connected (OpenCode delivery degraded).**'
            : wakePath.agentKind === 'codex'
                ? '**Stream connected (Codex wake path unavailable).**'
                : '**Stream connected (no inbox-Monitor — wake path broken).**';
    }
    else if (status.lastContentEventAt === null) {
        // State 2: wire works, no content yet. Collapses two underlying
        // conditions per drone-4 contract — fresh connect pre-first-content
        // and quiet cube post-reconnect. The body's heartbeat field
        // distinguishes them (populated vs `_(none)_`).
        summary = '**Stream connected, awaiting first content event.**';
    }
    else {
        summary = `**Stream connected, last content ${humanAgo(new Date(status.lastContentEventAt))}.**`;
    }
    const lines = [];
    lines.push(summary);
    lines.push('');
    lines.push('# Log-stream status');
    lines.push('');
    if (orphanedInitialization) {
        lines.push('- **state**: _(orphaned stream-owner initialization)_');
    }
    else if (ownershipInitializing) {
        lines.push('- **state**: _(stream-owner initialization in progress)_');
    }
    else if (ownedByOther) {
        lines.push('- **state**: _(stream owner is another local process)_');
    }
    else if (isNotStarted) {
        lines.push('- **state**: _(stream not started)_');
    }
    else {
        lines.push(`- **connected**: ${status.connected}`);
    }
    // Body shape per drone-4 contract: three timestamp lines (content,
    // heartbeat, wire) — looks redundant in the common case where they
    // coincide, but the asymmetric "content quiet, heartbeats alive" case
    // is exactly the diagnostic scenario this surface exists to support.
    lines.push(`- **last content event**: ${status.lastContentEventAt
        ? `${status.lastContentEventAt} (${humanAgo(new Date(status.lastContentEventAt))})`
        : '_(none yet)_'}`);
    lines.push(`- **last heartbeat at**: ${status.lastHeartbeatAt
        ? `${status.lastHeartbeatAt} (${humanAgo(new Date(status.lastHeartbeatAt))})`
        : '_(none)_'}`);
    lines.push(`- **last wire activity**: ${status.lastWireActivityAt
        ? `${status.lastWireActivityAt} (${humanAgo(new Date(status.lastWireActivityAt))})`
        : '_(none)_'}`);
    lines.push(`- **last persisted event id**: ${status.lastPersistedEventId ?? '_(none)_'}`);
    lines.push(`- **reconnect attempts**: ${status.reconnectAttempts}`);
    lines.push(`- **run-loop restarts**: ${status.runLoopRestartCount}`);
    lines.push(`- **stream ownership**: ${status.ownership?.state ?? '_(unknown)_'}`);
    if (status.ownership?.lockPath) {
        lines.push(`- **ownership lock path**: ${status.ownership.lockPath}`);
    }
    if (ownedByOther) {
        const owner = status.ownership;
        lines.push(`- **stream owner pid**: ${owner.pid ?? '_(unknown)_'}`);
        lines.push(`- **stream owner cwd**: ${owner.cwd ?? '_(unknown)_'}`);
        lines.push(`- **stream owner heartbeat age**: ${typeof owner.ageMs === 'number' && Number.isFinite(owner.ageMs)
            ? `${Math.max(0, Math.round(owner.ageMs / 1000))}s`
            : '_(unknown)_'}`);
    }
    if (wakePath.agentKind === 'opencode' && wakePath.openCode) {
        const delivery = wakePath.openCode.deliveryStates;
        lines.push(`- **OpenCode delivery connected**: ${wakePath.openCode.connected}`);
        lines.push(`- **OpenCode queued**: ${delivery.queued}`);
        lines.push(`- **OpenCode delivered-unconfirmed**: ${delivery['delivered-unconfirmed']}`);
        lines.push(`- **OpenCode retried**: ${delivery.retried}`);
        lines.push(`- **OpenCode failed**: ${delivery.failed}`);
    }
    // Runtime-specific wake-path warning. The wire-down case takes
    // precedence above; an indeterminate signal remains honest and silent.
    if (status.connected && wakePathHealthy === false) {
        if (wakePath.agentKind === 'opencode') {
            lines.push('- **OpenCode delivery**: _(degraded — inspect the durable unread log)_');
            lines.push('');
            lines.push('## OpenCode wake delivery is degraded');
            lines.push('One or more durable inbox entries were rejected or could not be confirmed. Run `borg_read-log unread_only=true` and drain the unread log now. Use `borg_stream-status` to check whether failed or delivered-unconfirmed entries remain.');
            return lines.join('\n');
        }
        if (wakePath.agentKind === 'codex') {
            lines.push('- **Codex wake path**: _(remote-control bridge unavailable)_');
            lines.push('');
            lines.push('## Codex wake delivery is unavailable');
            lines.push('The Codex remote-control bridge cannot currently deliver a wake. Run `borg_read-log unread_only=true` and drain the unread log now, then reconnect the Codex wake path.');
            return lines.join('\n');
        }
        lines.push(`- **inbox-monitor**: _(no watcher detected — wake path broken)_`);
        if (inboxPath && droneLabel && cubeName) {
            lines.push('');
            lines.push('## Real-time wake-up (do this now)');
            lines.push('No process is tailing this drone\'s inbox file — this session won\'t wake on real-time cube activity, only on its fallback timer, and will miss live coordination from other drones. Arm an inbox Monitor:');
            lines.push('');
            lines.push(`> Monitor command: \`${monitorCommand(inboxPath, monitorStateRoot)}\` — persistent, 1h timeout, description "borg inbox for ${droneLabel} on cube ${cubeName}".`);
        }
    }
    return lines.join('\n');
}
/**
 * Gate predicate for the regen wake-path warning (gh#51 — extracted
 * from the inline ternary in `src/index.ts` for direct unit-test
 * coverage of the (connected × healthy) cross-product).
 *
 * Returns true ONLY when the wire is up AND the runtime-specific wake
 * mechanism is positively unhealthy (`=== false` strict). The `null` branch
 * (couldn't determine) stays silent — surfacing an uncertain failure
 * mode is worse UX than omitting it (mirrors the State-5 precedence
 * rule in `renderStreamStatus`). When disconnected, the wire-down case
 * is the upstream cause and takes precedence; no point warning about
 * the wake path when its input has no events to deliver.
 */
export function shouldShowWakePathWarning(streamStatus, inboxMonitorHealthy) {
    return streamStatus.connected && inboxMonitorHealthy === false;
}
/**
 * Runtime-specific wake-path-broken prefix for `borg_regen` output.
 *
 * Pure function — caller decides whether to call (gates on
 * `shouldShowWakePathWarning`). Returns an empty string when called
 * with insufficient context to render the Monitor command (e.g., no
 * inbox path on a no-active-cube path), so callers can always prepend
 * the result unconditionally.
 *
 * Mirrors the State-5 self-arm instruction shape in
 * `renderStreamStatus` so a drone sees the same Monitor command via
 * both `borg_stream-status` and `borg_regen`. The differentiator: regen
 * runs on every /loop iteration, so the prefix gives passive
 * self-healing (worst-case latency = the /loop fallback heartbeat),
 * whereas stream-status only surfaces the warning when actively
 * called.
 */
export function formatWakePathPrefix(inputs) {
    const { inboxPath, monitorStateRoot, droneLabel, cubeName, wakePath } = inputs;
    if (wakePath?.agentKind === 'opencode') {
        const delivery = wakePath.openCode?.deliveryStates;
        return [
            '## ⚠ OpenCode wake delivery degraded',
            '',
            `Durable delivery has ${delivery
                ? `${delivery['delivered-unconfirmed']} delivered-unconfirmed and ${delivery.failed} failed entries`
                : 'an unhealthy runtime signal'}. Run \`borg_stream-status\`, then run \`borg_read-log unread_only=true\` and drain the unread log.`,
            '',
            '---',
            '',
        ].join('\n');
    }
    if (wakePath?.agentKind === 'codex') {
        return [
            '## ⚠ Codex wake path unavailable',
            '',
            'The remote-control bridge cannot currently deliver a wake. Run `borg_read-log unread_only=true` and drain the unread log, then reconnect the Codex wake path.',
            '',
            '---',
            '',
        ].join('\n');
    }
    if (!inboxPath || !droneLabel || !cubeName)
        return '';
    return [
        `## ⚠ Wake path broken — arm Monitor NOW`,
        ``,
        `No process is tailing this drone's inbox file. SSE delivery is healthy (entries reach disk), but Claude Code has no event source to wake on. Until you arm a Monitor, this session has no wake path and will miss live coordination from other drones:`,
        ``,
        `> Monitor command: \`${monitorCommand(inboxPath, monitorStateRoot)}\` — persistent, 1h timeout, description "borg inbox for ${droneLabel} on cube ${cubeName}".`,
        ``,
        `---`,
        ``,
    ].join('\n');
}
function monitorCommand(inboxPath, monitorStateRoot) {
    return monitorStateRoot
        ? `borg-inbox-monitor --state-root ${shellEscape(monitorStateRoot)} ${shellEscape(inboxPath)}`
        : `borg-inbox-monitor ${shellEscape(inboxPath)}`;
}
//# sourceMappingURL=stream-status.js.map