#!/usr/bin/env node
/**
 * Borg MCP Client - Main Entry Point
 *
 * stdio MCP server that:
 * 1. Connects to Claude Code via stdio transport
 * 2. Proxies MCP tools to a verified local (self-hosted) Borg server
 * 3. Provides the borg: cube tool surface (assimilate / cube / role /
 *    roster / read-log) so Claude can act as a Drone in a hive of
 *    collaborating sessions.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { assertRoleMatches } from './role-match.js';
import { getCubeInfo, getRoleInfo, getRoleInfoByName, getRoster, readLog, appendLog, ackLogEntry, recordDecision, removeDecision, listDecisions, regen, listCubes, createCube, updateCube, deleteCube, createRole, updateRole, patchRoleSection, patchTaxonomyClass, deleteRole, reassignDrone, evictDrone, getCube, syncRoles, applyTemplate, whoami, roleRationale, } from './remote-client.js';
import { getTemplate, listTemplateNames, resolveCubeDirectiveForCreate, resolveCubeDirectiveForApply, resolveMessageTaxonomyForCreate, } from 'borgmcp-shared/templates';
import { activeCubeWithFreshRegenIdentity, getActiveCube, setActiveCube, findProjectRoot, inboxPathForDrone, } from './cubes.js';
import { isEntryInvocation, monitorStateRootForWorktree } from './inbox-monitor.js';
import { addSessionStartHook, addUserPromptSubmitHook } from './config-utils.js';
import { humanAgo, formatLogEntryMarkdown, formatRegenMarkdown, getDronePlaybook, getDronePlaybookChapter, nullTaxonomyTip, regenWakePathDroneLabel, } from './regen-format.js';
import { startLogStream, getStreamStatus } from './log-stream.js';
import { isMcpReadinessProbe } from './readiness-probe.js';
import { runMcpStartupServices } from './startup-services.js';
import { TOOL_MANIFEST } from './tool-manifest.js';
import { DOCS_SECTIONS, matchDocsSections, formatDocsIndex } from './docs-sections.js';
import { renderRoleList } from './list-roles-render.js';
import { filterToolsForRole } from './tool-scope.js';
import { getPackageVersion, getOnDiskVersion, handleVersionFlag } from './version.js';
import { renderStreamStatus, checkInboxMonitorHealthy, formatWakePathPrefix, shouldShowWakePathWarning, } from './stream-status.js';
import { formatRoleAgentLabel, formatWorkingRepoLabel, renderRoster } from './roster-render.js';
import { resolveWorkingRepo } from './working-repo.js';
import { resolveDroneIdByLabel, isUuidShape } from './evict-drone.js';
import { DroneEvictedError, formatEvictedToolResult, } from './drone-lifecycle.js';
import { classifyInSessionAssimilate, reattachOnlyRefusal, reattachFailureMessage, } from './assimilate-guard.js';
import { gateAllowsActivation, borgSessionToolNotice } from './launch-gate.js';
import { renderSyncRolesResult } from './sync-roles-render.js';
import { initConsolePrefix, consolePrefix } from './console-prefix.js';
import { resolveSessionAgentKind, } from './codex-app-wake.js';
import { connectOpenCodeDrone, injectOpenCodeEntry, computeOpenCodePort, } from './opencode-drone.js';
import { installBorgPlugin } from './opencode-plugin.js';
import { setModuleInjectOpenCode } from './log-stream.js';
import { lifecycleSignalForMessage, recordLifecycleLog, shouldSuppressLifecycleLog, } from './lifecycle-log-guard.js';
import { normalizeDirectLogRecipients, } from './direct-log.js';
/**
 * Apply a template's roles + message_taxonomy to a cube.
 *
 * gh#473 PR2 — delegates to the NON-CLOBBERING server route. New roles
 * are inserted; existing template-named roles get ADD fragments (template
 * sections/classes the cube lacks) auto-applied, but EVOLVED (conflicting)
 * fragments are surfaced server-side and KEPT — never silently
 * overwritten. The old per-role blanket `updateRole`/whole-taxonomy
 * `updateCube` overwrite path is removed. Operators who want to take the
 * template version of a conflicting fragment use `borg_sync-roles` with a
 * `decisions` map. Returns `{ created, updated }` for the caller's toast.
 */
async function applyTemplateToCube(cubeId, template) {
    return await applyTemplate(cubeId, template.name);
}
/**
 * Throw a friendly error if the client has not been assimilated to a cube.
 */
async function requireActiveCube() {
    const active = await getActiveCube();
    if (!active) {
        throw new Error('Not assimilated to a cube. Use borg_assimilate <cube-name> first.');
    }
    return active;
}
/**
 * Main entry point - MCP stdio server
 */
export async function main() {
    // Honor `--version` / `-v` BEFORE any side-effecting work (hooks,
    // readiness checks, stream consumer spawn, MCP handshake). Lets
    // operators run `borg-mcp --version` cleanly to confirm the
    // installed client version.
    handleVersionFlag();
    const readinessProbe = isMcpReadinessProbe();
    await runMcpStartupServices(readinessProbe, {
        // Auto-register the SessionStart hook so existing users get borg-regen
        // auto-orientation on session start without re-running borg setup. Idempotent.
        sessionStartHook: () => {
            addSessionStartHook();
        },
        // Auto-register the UserPromptSubmit audit hook so the drone gets a
        // nudge if the previous assistant span used state-changing tools
        // without calling borg_log. Domain-agnostic — knows nothing about git
        // or any specific convention. Idempotent.
        auditHook: () => {
            addUserPromptSubmitHook();
        },
        // Spawn the SSE log-stream consumer. This gives drones real-time
        // wakeup: when another drone posts to the cube, the worker pushes
        // an `event: log` over SSE, the consumer appends one line to the
        // per-drone inbox file (see inboxPathForDrone in cubes.ts), and the
        // launcher's Monitor wakes the active /loop iteration immediately.
        // Same inbox-file shape as the prior long-poll path — the file is
        // still the harness-side wake primitive — only the wire layer
        // changed. See:
        //   docs/superpowers/specs/2026-05-11-server-push-log-subscription.md
        // Failure here is non-fatal — the launcher's fallback heartbeat
        // still keeps things moving.
        sseStream: () => {
            startLogStream();
        },
        // gh#opencode: initialize opencode drone module for autonomous entry
        // injection. Installs the plugin (idempotent) and connects the SDK client
        // when the runtime is opencode (BORG_OPENCODE=1). The module-level
        // injectOpenCode hook routes SSE entries into the TUI's session.
        // Best-effort; never breaks the MCP server.
        openCode: async () => {
            installBorgPlugin();
            const active = await getActiveCube();
            if (active && process.env.BORG_OPENCODE === '1') {
                const port = computeOpenCodePort(active.droneId);
                const serverUrl = `http://127.0.0.1:${port}`;
                await connectOpenCodeDrone({
                    serverUrl,
                    directory: process.cwd(),
                    droneLabel: active.droneLabel,
                    cubeName: active.name,
                });
                setModuleInjectOpenCode(injectOpenCodeEntry);
            }
        },
    });
    // Create MCP server. `version` is the installed borgmcp version
    // (T1.4 of 0.6.0): read at runtime from package.json so Claude
    // Code's `/mcp` view shows the real version instead of the
    // long-standing hardcoded "0.1.0".
    const server = new Server({
        name: 'borg-mcp-client',
        version: getPackageVersion(),
    }, {
        capabilities: {
            tools: {},
            prompts: {},
        },
    });
    // gh#899: tool definitions built once at setup, then role-scoped per caller
    // in the ListTools handler below (the dispatcher reaches deferred tools).
    const allToolDefs = TOOL_MANIFEST;
    // Register tool listing — role-scope the native surface (gh#899). Missing role
    // (old cubes.json / pre-assimilate) → full set; deferred tools stay reachable
    // via borg_tool. Never an auth boundary — server RLS/ownership is unchanged.
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        let scope = null;
        try {
            const active = await getActiveCube();
            if (active) {
                scope = { roleName: active.roleName, roleClass: active.roleClass, isHumanSeat: active.isHumanSeat };
            }
        }
        catch {
            scope = null; // unreadable cube state → full set (fail-safe)
        }
        return { tools: filterToolsForRole(allToolDefs, scope) };
    });
    // Register tool execution handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        let { name, arguments: args } = request.params;
        // gh#899: borg_describe-tool — schema-only, NEVER executes. Returns the
        // named tool's def from allToolDefs so a role-scoped session can learn a
        // deferred tool's arguments before invoking it via borg_tool.
        if (name === 'borg_describe-tool') {
            const target = typeof args?.name === 'string' ? args.name : '';
            const def = allToolDefs.find((t) => t.name === target);
            if (!def) {
                return {
                    content: [{ type: 'text', text: `Unknown borg tool: ${target || '(none)'}. Pass { name: "<borg_tool>" }.` }],
                    isError: true,
                };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify({ name: def.name, description: def.description, inputSchema: def.inputSchema }, null, 2) }],
            };
        }
        // gh#899: borg_tool dispatcher — unwrap to the inner tool and fall through
        // to the SAME switch below (identical activation gate + per-tool auth/Zod
        // validation; no weaker entry — the server RLS/ownership boundary is
        // unchanged). Guards against dispatcher self-reference / recursion.
        if (name === 'borg_tool') {
            const inner = typeof args?.name === 'string' ? args.name : '';
            if (!inner || inner === 'borg_tool' || inner === 'borg_describe-tool') {
                return {
                    content: [{ type: 'text', text: 'borg_tool: pass { name: "<borg_tool>", arguments: {...} } naming a real borg tool (not the dispatcher itself).' }],
                    isError: true,
                };
            }
            args = (args?.arguments && typeof args.arguments === 'object')
                ? args.arguments
                : {};
            name = inner;
        }
        // gh#673 P1 (WI-5): the borg tool surface activates only in
        // borg-launched sessions — BOTH harnesses ride the same gate. A
        // vanilla `claude`/`codex` gets a non-silent re-launch notice per
        // tool, never a half-activated, un-wakeable drone; ListTools stays
        // intact so the agent learns WHY. Claude children inherit
        // BORG_SESSION from the wrapper's launchEnv; codex children receive
        // it via the per-launch `-c mcp_servers.borg.env.BORG_SESSION="1"`
        // override (codexBorgSessionConfigArgs — inherited env never reaches
        // codex MCP children, V2/V2b probes). ACTIVATION-only per the SR
        // binding — never a security decision (server auth unchanged).
        if (!gateAllowsActivation(`tool ${name}`)) {
            return {
                content: [{ type: 'text', text: borgSessionToolNotice(name) }],
                isError: true,
            };
        }
        try {
            switch (name) {
                case 'borg_regen': {
                    const active = await getActiveCube();
                    if (!active) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: 'Not connected to a cube. Use `borg_assimilate cube_name="<name>"` to join one.',
                                },
                            ],
                        };
                    }
                    const since = typeof args?.since === 'string' ? args.since : undefined;
                    const mode = args?.mode === 'lite' ? 'lite' : 'full';
                    const reportedModel = typeof args?.model === 'string' ? args.model : undefined;
                    const result = await regen(active.sessionToken, active.apiUrl, {
                        since,
                        reportedModel,
                        workingRepo: resolveWorkingRepo(),
                        serverTrustIdentity: active.serverTrustIdentity,
                    });
                    const freshActive = activeCubeWithFreshRegenIdentity(active, result);
                    if (freshActive !== active) {
                        await setActiveCube(freshActive);
                    }
                    // Wake-path self-heal (gh#43): SSE delivery to the inbox file
                    // is independent from Claude Code waking on file writes. The
                    // latter requires a `tail -F` Monitor against the inbox path;
                    // if that Monitor dies (or was never armed across a session
                    // boundary), the drone misses every incoming entry until the
                    // /loop fallback heartbeat. Because regen runs on every /loop
                    // iteration, surfacing the breakage here gives self-healing at
                    // worst-case latency = the heartbeat interval. Mirrors the
                    // State-5 self-arm instruction in stream-status.ts.
                    const streamStatus = getStreamStatus();
                    const inboxPath = inboxPathForDrone(freshActive.cubeId, freshActive.droneId);
                    const monitorStateRoot = monitorStateRootForWorktree(findProjectRoot());
                    // Non-Claude CLIs do not use the Claude inbox Monitor. Keep the
                    // agent CLI distinction independent from whether Codex's optional
                    // remote-wake transport is currently armed.
                    const agentKind = resolveSessionAgentKind();
                    const inboxMonitorHealthy = agentKind === 'claude'
                        ? checkInboxMonitorHealthy(inboxPath, monitorStateRoot)
                        : true;
                    const prefix = shouldShowWakePathWarning(streamStatus, inboxMonitorHealthy)
                        ? formatWakePathPrefix({
                            inboxPath,
                            monitorStateRoot,
                            droneLabel: regenWakePathDroneLabel(result, freshActive.droneLabel),
                            cubeName: freshActive.name,
                        })
                        : '';
                    // gh#285: version-mismatch nudge when on-disk package is newer.
                    let versionHeader = '';
                    try {
                        const running = getPackageVersion();
                        const onDisk = getOnDiskVersion();
                        if (running !== 'unknown' && onDisk !== 'unknown' && onDisk !== running) {
                            const [rMaj, rMin, rPat] = running.split('.').map(Number);
                            const [dMaj, dMin, dPat] = onDisk.split('.').map(Number);
                            const onDiskNewer = dMaj > rMaj || (dMaj === rMaj && dMin > rMin) || (dMaj === rMaj && dMin === rMin && dPat > rPat);
                            if (onDiskNewer) {
                                versionHeader = `## 🔄 borgmcp ${onDisk} installed — run /mcp and reconnect (or restart Claude Code) to apply. Currently running ${running}.\n\n`;
                            }
                        }
                    }
                    catch { /* never break regen */ }
                    return { content: [{ type: 'text', text: versionHeader + prefix + formatRegenMarkdown(result, { mode }) }] };
                }
                case 'borg_assimilate': {
                    const cubeName = args?.cube_name;
                    if (!cubeName)
                        throw new Error('cube_name is required');
                    // gh#780 (Queen ruling 33a62d94): RE-ATTACH-ONLY. The old handler
                    // POSTed /api/assimilate, which always MINTS a new drones row —
                    // so agents "recovering" from auth blips spawned orphan seats.
                    // This tool now re-attaches to the worktree's saved identity or
                    // refuses with CLI guidance; it is structurally incapable of
                    // minting. Seat creation lives in the CLI (`borg assimilate`).
                    const active = await getActiveCube();
                    const decision = classifyInSessionAssimilate(active, cubeName);
                    if (decision.kind !== 'reattach') {
                        return {
                            content: [{ type: 'text', text: reattachOnlyRefusal(decision, cubeName) }],
                            isError: true,
                        };
                    }
                    // Re-attach = serve the saved identity through the
                    // server-validated regen path (SR cond-4: no fabricated success
                    // — an evicted/revoked seat FAILS server-side and is surfaced).
                    try {
                        const result = await regen(active.sessionToken, active.apiUrl, {
                            workingRepo: resolveWorkingRepo(),
                            serverTrustIdentity: active.serverTrustIdentity,
                        });
                        const freshActive = activeCubeWithFreshRegenIdentity(active, result);
                        if (freshActive !== active) {
                            await setActiveCube(freshActive);
                        }
                        const header = [
                            `# Re-attached to cube: ${freshActive.name}`,
                            ``,
                            `**Drone label:** ${freshActive.droneLabel}`,
                            `**Seat:** existing identity reused — no new drone minted (gh#780)`,
                            ``,
                            ``,
                        ].join('\n');
                        return {
                            content: [{ type: 'text', text: header + formatRegenMarkdown(result, { mode: 'full' }) }],
                        };
                    }
                    catch (err) {
                        const failure = reattachFailureMessage(err ?? {});
                        return { content: [{ type: 'text', text: failure }], isError: true };
                    }
                }
                case 'borg_version': {
                    return { content: [{ type: 'text', text: `borgmcp ${getPackageVersion()}` }] };
                }
                case 'borg_playbook': {
                    // gh#912: serve the on-demand operating-playbook chapter (static
                    // client-side text — no cube/auth needed; the rule-spine is already
                    // inline in regen). Lets the bootstrap regen stay light.
                    return { content: [{ type: 'text', text: getDronePlaybookChapter() }] };
                }
                case 'borg_docs': {
                    // gh#docs-site B: return the docs index (URLs + summaries) so the agent
                    // can WebFetch the right page. No server-side fetch, no search service —
                    // the topic match is a lazy keyword filter over DOCS_SECTIONS.
                    const topic = typeof args?.topic === 'string' ? args.topic.trim() : '';
                    const matched = topic ? matchDocsSections(topic) : [];
                    const sections = matched.length > 0 ? matched : DOCS_SECTIONS;
                    const header = topic && matched.length > 0
                        ? `Best-matching docs section(s) for "${topic}" — WebFetch the URL for the full page:`
                        : topic
                            ? `No exact match for "${topic}". Full Borg MCP docs index — WebFetch the URL you need:`
                            : `Borg MCP docs index — WebFetch the URL of the section you need:`;
                    return { content: [{ type: 'text', text: `${header}\n\n${formatDocsIndex(sections)}` }] };
                }
                case 'borg_whoami': {
                    const active = await requireActiveCube();
                    const result = await whoami(active.sessionToken, active.apiUrl, active.serverTrustIdentity);
                    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
                }
                case 'borg_cube': {
                    // No-cache invariant (T1.2 — 0.7.0): both `getCubeInfo` and
                    // `getRoleInfo` MUST fetch fresh per invocation. Never
                    // memoize / cache the cube or role payload in process memory
                    // or in `cubes.json` — `borg_reassign-drone` changes the
                    // calling drone's role in the DB, and subsequent
                    // `borg_cube` reads MUST reflect the new role within one
                    // round-trip. Locked in by the regression probe at
                    // `client/__tests__/integration/01-role-cache-freshness.integration.ts`;
                    // a future refactor that introduces caching here will fail
                    // that probe. See drone-8's 19:38:56 observation + drone-6's
                    // 06:00:31 finding for the original incident trace.
                    const active = await requireActiveCube();
                    const [{ cube, roles }] = await Promise.all([
                        getCubeInfo(active.sessionToken, active.apiUrl, active.serverTrustIdentity),
                        getRoleInfo(active.sessionToken, active.apiUrl, active.serverTrustIdentity),
                    ]);
                    const lines = [];
                    lines.push(`# Cube: ${cube.name}`);
                    lines.push('');
                    lines.push('## Cube directive');
                    lines.push(cube.cube_directive || '_(none)_');
                    lines.push('');
                    const taxonomyTip = nullTaxonomyTip(cube.message_taxonomy);
                    if (taxonomyTip) {
                        lines.push(taxonomyTip);
                        lines.push('');
                    }
                    lines.push('## Roles in this cube');
                    if (!roles.length) {
                        lines.push('_(no roles defined)_');
                    }
                    else {
                        for (const r of roles) {
                            const tags = [
                                r.role_class === 'queen' ? 'Queen' : null,
                                r.is_human_seat ? 'human-seat' : null,
                                r.is_default ? 'default' : null,
                                r.is_mandatory ? 'mandatory' : null,
                            ].filter(Boolean).join(', ');
                            const marker = tags ? ` (${tags})` : '';
                            const desc = r.short_description || '_(no description)_';
                            lines.push(`- **${r.name}**${marker} — ${desc}`);
                        }
                        // Sprint 6 / gh#153 discoverability nudge per drone-7 UX-FEEDBACK:
                        // point Coordinator-class readers at the tool that surfaces role IDs.
                        lines.push('');
                        lines.push('_(Coordinator-class drones can fetch role IDs via `borg_list-roles` for use with `borg_reassign-drone`.)_');
                    }
                    lines.push('');
                    lines.push(getDronePlaybook());
                    return { content: [{ type: 'text', text: lines.join('\n') }] };
                }
                case 'borg_role': {
                    // No-cache invariant (T1.2 — 0.7.0): role reads MUST fetch
                    // fresh per invocation. See 01-role-cache-freshness.integration.ts.
                    const active = await requireActiveCube();
                    const requested = typeof args?.role === 'string' ? args.role.trim() : '';
                    if (requested) {
                        const { role } = await getRoleInfoByName(active.sessionToken, active.apiUrl, requested, active.serverTrustIdentity);
                        assertRoleMatches(requested, role);
                        const text = [
                            `# Role: ${role.name}`,
                            ``,
                            role.detailed_description || '_(no detailed description set)_',
                        ].join('\n');
                        return { content: [{ type: 'text', text }] };
                    }
                    const { role } = await getRoleInfo(active.sessionToken, active.apiUrl, active.serverTrustIdentity);
                    const text = [
                        `# Your role: ${role.name}`,
                        ``,
                        role.detailed_description || '_(no detailed description set)_',
                    ].join('\n');
                    return { content: [{ type: 'text', text }] };
                }
                case 'borg_role-rationale': {
                    const active = await requireActiveCube();
                    const role = typeof args?.role === 'string' ? args.role : '';
                    const section = typeof args?.section === 'string' ? args.section : '';
                    const result = await roleRationale(active.sessionToken, active.apiUrl, role, section, active.serverTrustIdentity);
                    const text = [
                        `# Role rationale: ${result.role} — ${result.section}`,
                        '',
                        result.body || '_(empty)_',
                    ].join('\n');
                    return { content: [{ type: 'text', text }] };
                }
                case 'borg_roster': {
                    const active = await requireActiveCube();
                    const since = typeof args?.since === 'string' ? args.since : undefined;
                    const { drones, roles, since: resolvedSince } = await getRoster(active.sessionToken, active.apiUrl, since, active.serverTrustIdentity);
                    const text = renderRoster({
                        cubeName: active.name,
                        drones,
                        roles,
                        resolvedSince: resolvedSince ?? null,
                        humanAgo,
                    });
                    return { content: [{ type: 'text', text }] };
                }
                case 'borg_stream-status': {
                    // Probe the in-process SSE consumer state. Does NOT require
                    // an active cube — if the consumer hasn't started or is
                    // between cubes, the snapshot still reports current values.
                    // Also probes wake-path completeness (T1.2): is anyone tailing
                    // the inbox file? Without that, SSE delivery still works but
                    // the harness `/loop` never wakes on the file write.
                    const status = getStreamStatus();
                    const active = await getActiveCube();
                    const inboxPath = active
                        ? inboxPathForDrone(active.cubeId, active.droneId)
                        : null;
                    const monitorStateRoot = active
                        ? monitorStateRootForWorktree(findProjectRoot())
                        : null;
                    // Non-Claude CLIs have their own wake mechanism, so this Claude-only
                    // Monitor diagnostic must not be inferred from Codex transport state.
                    const nonClaudeSession = active && resolveSessionAgentKind() !== 'claude';
                    const inboxMonitorHealthy = active
                        ? nonClaudeSession
                            ? true
                            : checkInboxMonitorHealthy(inboxPath, monitorStateRoot)
                        : null;
                    let silentInertWarning = '';
                    if (status.runLoopHealth === 'silent-inert') {
                        silentInertWarning = '## ⚠ SSE stream loop silent-inert — run /mcp and reconnect to restart\n\n' +
                            'The log-stream consumer started but never connected. This drone will not receive real-time cube events.\n\n';
                    }
                    const text = renderStreamStatus({
                        status,
                        inboxMonitorHealthy,
                        inboxPath,
                        monitorStateRoot,
                        droneLabel: active?.droneLabel ?? null,
                        cubeName: active?.name ?? null,
                        humanAgo,
                    });
                    return { content: [{ type: 'text', text: silentInertWarning + text }] };
                }
                case 'borg_read-log': {
                    const active = await requireActiveCube();
                    const since = typeof args?.since === 'string' ? args.since : undefined;
                    const limit = typeof args?.limit === 'number' ? args.limit : undefined;
                    const unreadOnly = args?.unread_only === true || args?.unread_only === 'true';
                    const { entries, drones, roles, behind_by, has_more } = await readLog(active.sessionToken, active.apiUrl, {
                        since,
                        limit,
                        unreadOnly,
                        serverTrustIdentity: active.serverTrustIdentity,
                    });
                    const droneById = new Map();
                    for (const d of drones)
                        droneById.set(d.id, d);
                    const roleById = new Map();
                    for (const r of roles)
                        roleById.set(r.id, r);
                    const lines = [];
                    lines.push(`# Activity log: ${active.name}`);
                    lines.push('');
                    if (!entries.length) {
                        lines.push('_(no entries)_');
                    }
                    else {
                        for (const e of entries) {
                            lines.push(formatLogEntryMarkdown(e, droneById, roleById));
                        }
                    }
                    // gh#709 part B: nudge a behind drone to drain. `behind_by` is the
                    // count of entries VISIBLE to this drone still unread AFTER this read
                    // advanced the watermark — if > 0 you under-read (limit-capped or a
                    // non-cursor read) and will skip messages unless you keep reading.
                    if (has_more === true) {
                        lines.push('');
                        lines.push(`⚠ has_more: true — call \`borg_read-log unread_only=true\` again until has_more=false so you finish draining unread entries.`);
                    }
                    else if (typeof behind_by === 'number' && behind_by > 0) {
                        lines.push('');
                        lines.push(`⚠ behind_by: ${behind_by} more unread ${behind_by === 1 ? 'entry' : 'entries'} addressed to you — call \`borg_read-log unread_only=true\` again until behind_by=0 so you don't skip messages.`);
                    }
                    return { content: [{ type: 'text', text: lines.join('\n') }] };
                }
                case 'borg_log': {
                    const message = args?.message;
                    if (!message || typeof message !== 'string')
                        throw new Error('message is required');
                    const active = await getActiveCube();
                    if (!active)
                        throw new Error('Not assimilated to a cube. Use borg_assimilate <cube-name> first.');
                    if (lifecycleSignalForMessage(message)) {
                        const decision = await shouldSuppressLifecycleLog(active, message);
                        if (decision.suppress) {
                            await recordLifecycleLog(active, message);
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: `Suppressed duplicate ${decision.signal?.toUpperCase()} lifecycle log for ${active.droneLabel}; recent cube log already contains this signal.`,
                                    },
                                ],
                            };
                        }
                    }
                    const hasTo = Object.prototype.hasOwnProperty.call(args ?? {}, 'to');
                    const recipients = hasTo ? normalizeDirectLogRecipients(args?.to) : undefined;
                    const explicitClass = typeof args?.class === 'string' ? args.class : undefined;
                    const visibility = args?.visibility === 'broadcast' || args?.visibility === 'direct'
                        ? args.visibility
                        : undefined;
                    const appendOpts = {
                        ...(explicitClass ? { class: explicitClass } : {}),
                        ...(hasTo ? { to: recipients ?? [] } : {}),
                        ...(visibility ? { visibility } : {}),
                        ...(active.serverTrustIdentity === undefined
                            ? {}
                            : { serverTrustIdentity: active.serverTrustIdentity }),
                    };
                    const result = await appendLog(active.sessionToken, active.apiUrl, message, appendOpts);
                    await recordLifecycleLog(active, message);
                    const echo = result.routing?.message ? `\n${result.routing.message}` : '';
                    // gh#534: surface to the SENDER which directed recipients are
                    // currently unreachable via the wake path. The message is delivered
                    // regardless (persisted server-side); they read it when they return.
                    const unreachable = result.unreachableRecipients?.length
                        ? `\n⚠ ${result.unreachableRecipients.length} directed recipient(s) currently unreachable (wake-path:deaf): ${result.unreachableRecipients
                            .map((r) => r.label)
                            .join(', ')}. Message delivered — they'll read it when they return.`
                        : '';
                    const text = `Logged to cube "${active.name}" as ${active.droneLabel}. (entry id: ${result.entry.id})${echo}${unreachable}`;
                    return { content: [{ type: 'text', text }] };
                }
                case 'borg_ack': {
                    const entryId = args?.entry_id;
                    if (!entryId || typeof entryId !== 'string') {
                        throw new Error('entry_id is required');
                    }
                    // gh#418: default 'ack'. Only 'claim' is the other allowed kind; the
                    // worker re-validates at the Zod boundary so an unknown value is
                    // rejected server-side, but normalize here to keep the wire clean.
                    const kind = args?.kind === 'claim' ? 'claim' : 'ack';
                    const active = await requireActiveCube();
                    await ackLogEntry(active.sessionToken, active.apiUrl, entryId, kind, active.serverTrustIdentity);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: kind === 'claim'
                                    ? `Claimed entry ${entryId} in cube "${active.name}" (advisory — merge stays keyed on REVIEW-APPROVED).`
                                    : `Acked entry ${entryId} in cube "${active.name}".`,
                            },
                        ],
                    };
                }
                case 'borg_decide': {
                    const topic = args?.topic;
                    const decision = args?.decision;
                    if (!topic || typeof topic !== 'string')
                        throw new Error('topic is required');
                    if (!decision || typeof decision !== 'string')
                        throw new Error('decision is required');
                    const rationale = typeof args?.rationale === 'string' ? args.rationale : undefined;
                    const active = await requireActiveCube();
                    const { decision: row } = await recordDecision(active.sessionToken, active.apiUrl, {
                        topic,
                        decision,
                        ...(rationale !== undefined ? { rationale } : {}),
                    }, active.serverTrustIdentity);
                    const superseded = row?.supersedes ? ' (superseded the prior decision on this topic)' : '';
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Recorded ratified decision on "${topic}" in cube "${active.name}"${superseded}. Cite it via borg_decisions; it surfaces in borg_regen.`,
                            },
                        ],
                    };
                }
                case 'borg_decisions': {
                    const topic = typeof args?.topic === 'string' ? args.topic : undefined;
                    const active = await requireActiveCube();
                    const { decisions } = await listDecisions(active.sessionToken, active.apiUrl, topic, active.serverTrustIdentity);
                    const text = decisions.length === 0
                        ? topic
                            ? `No active ratified decision on "${topic}" in cube "${active.name}".`
                            : `No active ratified decisions in cube "${active.name}".`
                        : decisions
                            .map((d) => `**${d.topic}:** ${d.decision}${d.rationale ? ` — ${d.rationale}` : ''}`)
                            .join('\n');
                    return { content: [{ type: 'text', text }] };
                }
                case 'borg_remove-decision': {
                    const topic = typeof args?.topic === 'string' ? args.topic : undefined;
                    const decisionId = typeof args?.decision_id === 'string' ? args.decision_id : undefined;
                    if (Number(topic !== undefined) + Number(decisionId !== undefined) !== 1) {
                        throw new Error('provide exactly one of topic or decision_id');
                    }
                    const active = await requireActiveCube();
                    const selector = topic !== undefined ? { topic } : { decision_id: decisionId };
                    const { decision } = await removeDecision(active.sessionToken, active.apiUrl, selector, active.serverTrustIdentity);
                    return {
                        content: [{
                                type: 'text',
                                text: `Removed the active ratified decision on "${decision.topic}" from cube "${active.name}".`,
                            }],
                    };
                }
                case 'borg_list-cubes': {
                    const { cubes } = await listCubes();
                    if (!cubes.length) {
                        return { content: [{ type: 'text', text: 'No cubes yet. Use borg_create-cube to make your first one.' }] };
                    }
                    const lines = cubes.map((c) => `- **${c.name}** (id: ${c.id})\n  ${(c.cube_directive || '_(no directive set)_').split('\n')[0].slice(0, 120)}`);
                    return { content: [{ type: 'text', text: `Your cubes (${cubes.length}):\n\n${lines.join('\n\n')}` }] };
                }
                case 'borg_create-cube': {
                    const name = args?.name;
                    const cubeDirective = args?.cube_directive;
                    const templateName = args?.template;
                    if (!name)
                        throw new Error('name is required');
                    if (cubeDirective === undefined)
                        throw new Error('cube_directive is required (pass empty string if none)');
                    // Resolve template (validates name early so the cube isn't
                    // created in a partial state if the template name is wrong).
                    let template = null;
                    if (templateName) {
                        template = getTemplate(templateName);
                        if (!template) {
                            throw new Error(`Unknown template "${templateName}". Available: ${listTemplateNames().join(', ')}`);
                        }
                    }
                    // Sprint 14: template cube_directive fills empty operator input.
                    // Operator-supplied text takes precedence — templates fill
                    // the blank, never stomp.
                    const resolvedCubeDirective = resolveCubeDirectiveForCreate(cubeDirective, template);
                    // v0.9.2: createCube now returns the flat shape directly
                    // (see remote-client unwrap). `cube.id` / `cube.name` work
                    // verbatim on the returned object.
                    const resolvedMessageTaxonomy = resolveMessageTaxonomyForCreate(undefined, template);
                    const cube = await createCube(name, resolvedCubeDirective, {
                        message_taxonomy: resolvedMessageTaxonomy,
                    });
                    // Apply template roles if requested. Merges by name: any role the
                    // server auto-seeded (e.g. "Drone") that the template doesn't
                    // also include stays put; templated roles upsert.
                    if (template) {
                        const summary = await applyTemplateToCube(cube.id, template);
                        const cubeDirectiveNote = resolvedCubeDirective !== cubeDirective
                            ? ' Template cube directive applied (operator passed empty).'
                            : '';
                        const text = `Created cube **${cube.name}** (id: ${cube.id}) with template **${templateName}** applied — ${summary.created} role(s) created, ${summary.updated} updated.${cubeDirectiveNote} Use borg_assimilate ${cube.name} to join as a drone.`;
                        return { content: [{ type: 'text', text }] };
                    }
                    const text = `Created cube **${cube.name}** (id: ${cube.id}). A default "Drone" role was seeded — rename or replace it via borg_update-role / borg_create-role / borg_delete-role. Use borg_assimilate ${cube.name} to join as a drone.`;
                    return { content: [{ type: 'text', text }] };
                }
                case 'borg_update-cube': {
                    const cubeId = args?.cube_id;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    const updates = {};
                    if (typeof args?.name === 'string')
                        updates.name = args.name;
                    if (typeof args?.cube_directive === 'string')
                        updates.cube_directive = args.cube_directive;
                    if (Array.isArray(args?.message_taxonomy))
                        updates.message_taxonomy = args.message_taxonomy;
                    if (Object.keys(updates).length === 0)
                        throw new Error('Pass at least one of: name, cube_directive, message_taxonomy.');
                    const { cube } = await updateCube(cubeId, updates);
                    return { content: [{ type: 'text', text: `Updated cube **${cube.name}** (id: ${cube.id}).` }] };
                }
                case 'borg_patch-taxonomy-class': {
                    const cubeId = args?.cube_id;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    const action = args?.action;
                    if (action !== 'add' && action !== 'replace' && action !== 'remove') {
                        throw new Error('action must be one of: add, replace, remove.');
                    }
                    let cube;
                    let label;
                    if (action === 'remove') {
                        const className = args?.class;
                        if (!className)
                            throw new Error('class is required for remove.');
                        ({ cube } = await patchTaxonomyClass(cubeId, { action, class: className }));
                        label = className;
                    }
                    else {
                        const classDef = args?.class_def;
                        if (classDef == null || typeof classDef !== 'object' || Array.isArray(classDef)) {
                            throw new Error('class_def (object) is required for add/replace.');
                        }
                        ({ cube } = await patchTaxonomyClass(cubeId, { action, class_def: classDef }));
                        label = String(classDef.class ?? '');
                    }
                    const verb = action === 'add' ? 'Added' : action === 'replace' ? 'Replaced' : 'Removed';
                    return { content: [{ type: 'text', text: `${verb} taxonomy class **${label}** in cube **${cube.name}** (id: ${cube.id}).` }] };
                }
                case 'borg_delete-cube': {
                    const cubeId = args?.cube_id;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    await deleteCube(cubeId);
                    return { content: [{ type: 'text', text: `Deleted cube ${cubeId} (and all its roles, drones, log entries).` }] };
                }
                case 'borg_create-role': {
                    const cubeId = args?.cube_id;
                    const name = args?.name;
                    const shortDesc = args?.short_description;
                    const detailedDesc = args?.detailed_description;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    if (!name)
                        throw new Error('name is required');
                    if (shortDesc === undefined)
                        throw new Error('short_description is required (pass empty string if none)');
                    if (detailedDesc === undefined)
                        throw new Error('detailed_description is required (pass empty string if none)');
                    const isDefault = args?.is_default === true;
                    const isMandatory = args?.is_mandatory === true;
                    const isHumanSeat = args?.is_human_seat === true;
                    const canBroadcast = args?.can_broadcast === true;
                    const receivesAllDirect = args?.receives_all_direct === true;
                    const { role } = await createRole(cubeId, {
                        name,
                        short_description: shortDesc,
                        detailed_description: detailedDesc,
                        is_default: isDefault,
                        is_mandatory: isMandatory,
                        is_human_seat: isHumanSeat,
                        can_broadcast: canBroadcast,
                        receives_all_direct: receivesAllDirect,
                        ...(typeof args?.default_model === 'string' ? { default_model: args.default_model } : {}),
                    });
                    const tags = [
                        role.role_class === 'queen' ? 'Queen' : null,
                        role.is_human_seat ? 'human-seat' : null,
                        role.is_default ? 'default' : null,
                        role.is_mandatory ? 'mandatory' : null,
                    ].filter(Boolean).join(', ');
                    const tag = tags ? ` (${tags})` : '';
                    return { content: [{ type: 'text', text: `Created role **${role.name}**${tag} (id: ${role.id}) in cube ${cubeId}.` }] };
                }
                case 'borg_update-role': {
                    const roleId = args?.role_id;
                    if (!roleId)
                        throw new Error('role_id is required');
                    const updates = {};
                    if (typeof args?.name === 'string')
                        updates.name = args.name;
                    if (typeof args?.short_description === 'string')
                        updates.short_description = args.short_description;
                    if (typeof args?.detailed_description === 'string')
                        updates.detailed_description = args.detailed_description;
                    if (typeof args?.is_default === 'boolean')
                        updates.is_default = args.is_default;
                    if (typeof args?.is_mandatory === 'boolean')
                        updates.is_mandatory = args.is_mandatory;
                    if (typeof args?.is_human_seat === 'boolean')
                        updates.is_human_seat = args.is_human_seat;
                    if (typeof args?.can_broadcast === 'boolean')
                        updates.can_broadcast = args.can_broadcast;
                    if (typeof args?.receives_all_direct === 'boolean')
                        updates.receives_all_direct = args.receives_all_direct;
                    if (typeof args?.default_model === 'string')
                        updates.default_model = args.default_model;
                    if (Object.keys(updates).length === 0)
                        throw new Error('Pass at least one of: name, short_description, detailed_description, is_default, is_mandatory, is_human_seat, can_broadcast, receives_all_direct.');
                    const { role } = await updateRole(roleId, updates);
                    const tags = [
                        role.role_class === 'queen' ? 'Queen' : null,
                        role.is_human_seat ? 'human-seat' : null,
                        role.is_default ? 'default' : null,
                        role.is_mandatory ? 'mandatory' : null,
                    ].filter(Boolean).join(', ');
                    const tag = tags ? ` (${tags})` : '';
                    return { content: [{ type: 'text', text: `Updated role **${role.name}**${tag} (id: ${role.id}).` }] };
                }
                case 'borg_patch-role-section': {
                    const roleId = args?.role_id;
                    if (!roleId)
                        throw new Error('role_id is required');
                    const action = args?.action;
                    if (action !== 'replace' && action !== 'insert' && action !== 'delete') {
                        throw new Error('action must be one of: replace, insert, delete.');
                    }
                    const heading = args?.heading;
                    if (!heading)
                        throw new Error('heading is required');
                    let role;
                    if (action === 'delete') {
                        ({ role } = await patchRoleSection(roleId, { action, heading }));
                    }
                    else {
                        const body = args?.body;
                        if (typeof body !== 'string') {
                            throw new Error('body is required for replace/insert (pass empty string for an empty section).');
                        }
                        if (action === 'insert') {
                            const after = (typeof args?.after === 'string' ? args.after : null);
                            ({ role } = await patchRoleSection(roleId, { action, heading, body, after }));
                        }
                        else {
                            ({ role } = await patchRoleSection(roleId, { action, heading, body }));
                        }
                    }
                    const verb = action === 'replace' ? 'Replaced' : action === 'insert' ? 'Inserted' : 'Deleted';
                    return { content: [{ type: 'text', text: `${verb} section **${heading}** in role **${role.name}** (id: ${role.id}).` }] };
                }
                case 'borg_delete-role': {
                    const roleId = args?.role_id;
                    if (!roleId)
                        throw new Error('role_id is required');
                    await deleteRole(roleId);
                    return { content: [{ type: 'text', text: `Deleted role ${roleId}.` }] };
                }
                case 'borg_reassign-drone': {
                    const droneId = args?.drone_id;
                    const roleId = args?.role_id;
                    if (!droneId)
                        throw new Error('drone_id is required');
                    if (!roleId)
                        throw new Error('role_id is required');
                    const { drone } = await reassignDrone(droneId, roleId);
                    return { content: [{ type: 'text', text: `Reassigned drone ${drone.label} (${drone.id}) to role ${drone.role_id}.` }] };
                }
                case 'borg_evict-drone': {
                    const droneIdArg = args?.drone_id?.trim();
                    const label = args?.label?.trim();
                    const cubeId = args?.cube_id?.trim();
                    let targetId;
                    let targetLabel;
                    if (droneIdArg) {
                        // Explicit UUID path — mirrors borg_reassign-drone. gh#782:
                        // validate the shape BEFORE building the URL so a label (or a
                        // path-shaped value) passed as drone_id gets a clear error
                        // instead of a confusing not-found / malformed request path.
                        if (!isUuidShape(droneIdArg)) {
                            throw new Error(`drone_id "${droneIdArg}" is not a UUID — if that's a drone label, pass it as label + cube_id instead.`);
                        }
                        targetId = droneIdArg;
                        targetLabel = droneIdArg;
                    }
                    else if (label) {
                        // Label path: resolve to id against the owner-scoped cube roster.
                        if (!cubeId)
                            throw new Error('cube_id is required when evicting by label');
                        const { drones } = await getCube(cubeId);
                        const match = resolveDroneIdByLabel(drones, label);
                        if (!match) {
                            throw new Error(`No active drone labelled "${label}" in cube ${cubeId} (it may already be evicted; check borg_list-drones).`);
                        }
                        targetId = match.id;
                        targetLabel = match.label;
                    }
                    else {
                        throw new Error('Provide drone_id, or label + cube_id, to identify the drone to evict');
                    }
                    await evictDrone(targetId);
                    return { content: [{ type: 'text', text: `Evicted drone ${targetLabel} (${targetId}). Soft-deleted: removed from the roster and freed its seat; log history preserved with anonymized attribution.` }] };
                }
                case 'borg_list-drones': {
                    const cubeId = args?.cube_id;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    const { drones, roles } = await getCube(cubeId);
                    if (!drones.length) {
                        return { content: [{ type: 'text', text: 'No drones in this cube yet.' }] };
                    }
                    const rolesById = new Map(roles.map((r) => [r.id, r]));
                    const lines = drones.map((d) => {
                        const r = rolesById.get(d.role_id);
                        const roleLabel = formatRoleAgentLabel(r?.name ?? '?', d.agent_kind);
                        const wakeClass = d.wake_path_alert_class && d.wake_path_alert_class !== 'independent'
                            ? ` — wake-path-class: ${d.wake_path_alert_class}`
                            : '';
                        const reportedModel = d.reported_model
                            ? ` — Reported model: ${d.reported_model}`
                            : ' — Reported model: not reported';
                        const workingRepo = formatWorkingRepoLabel(d);
                        const workingRepoText = workingRepo ? ` — ${workingRepo}` : '';
                        return `- **${d.label}** (id: ${d.id}) — role: ${roleLabel} (${d.role_id}) — last seen ${d.last_seen}${wakeClass}${reportedModel}${workingRepoText}`;
                    });
                    return { content: [{ type: 'text', text: `Drones in cube ${cubeId} (${drones.length}):\n\n${lines.join('\n')}` }] };
                }
                case 'borg_list-roles': {
                    // Sprint 6 / gh#153: surface role IDs to Coordinator-class drones
                    // for use with borg_reassign-drone (e.g. promoting a drone to Queen).
                    // Uses the same owner-scoped GET /api/cubes/:id endpoint as
                    // borg_list-drones — data is already accessible to the cube owner
                    // via the dashboard surface; this tool just makes role IDs
                    // discoverable inside the MCP tool namespace per drone-7's UX-FEEDBACK.
                    // Render logic extracted to list-roles-render.ts for testability
                    // per drone-3 QA-FAIL 2026-05-18T13:27:53Z.
                    const cubeId = args?.cube_id;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    const { roles } = await getCube(cubeId);
                    return { content: [{ type: 'text', text: renderRoleList(roles, cubeId) }] };
                }
                case 'borg_list-templates': {
                    const names = listTemplateNames();
                    const lines = names.map((n) => {
                        const t = getTemplate(n);
                        return `- **${n}**: ${t.description}`;
                    });
                    return { content: [{ type: 'text', text: `Available templates:\n\n${lines.join('\n')}` }] };
                }
                case 'borg_sync-roles': {
                    const cubeId = args?.cube_id;
                    const templateName = args?.template_name || 'software-dev';
                    const apply = args?.apply === true;
                    // gh#473 PR2 — per-conflict-fragment accept/reject decisions.
                    // Keyed on the stable fragment key surfaced by the dry-run (e.g.
                    // `role:Builder:section:Workflow`). Unspecified conflicts default
                    // to REJECT (keep the cube's evolved text).
                    const decisions = args?.decisions && typeof args.decisions === 'object'
                        ? args.decisions
                        : undefined;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    const result = await syncRoles(cubeId, templateName, apply, decisions);
                    return { content: [{ type: 'text', text: renderSyncRolesResult(result, templateName) }] };
                }
                case 'borg_apply-template': {
                    const cubeId = args?.cube_id;
                    const templateName = args?.template_name;
                    if (!cubeId)
                        throw new Error('cube_id is required');
                    if (!templateName)
                        throw new Error('template_name is required');
                    const template = getTemplate(templateName);
                    if (!template) {
                        throw new Error(`Unknown template "${templateName}". Available: ${listTemplateNames().join(', ')}`);
                    }
                    const summary = await applyTemplateToCube(cubeId, template);
                    // Sprint 14: optionally write template's cube_directive to the
                    // cube. No-clobber discipline — only fills empty directives,
                    // never overwrites operator-customized text.
                    let cubeDirectiveNote = '';
                    const cubeForRules = await getCube(cubeId);
                    const newCubeDirective = resolveCubeDirectiveForApply(cubeForRules.cube_directive, template);
                    if (newCubeDirective !== null) {
                        await updateCube(cubeId, { cube_directive: newCubeDirective });
                        cubeDirectiveNote = ' Template cube directive applied (cube directive was empty).';
                    }
                    return { content: [{ type: 'text', text: `Applied template **${templateName}** to cube ${cubeId} — ${summary.created} role(s) created, ${summary.updated} updated.${cubeDirectiveNote}` }] };
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (error) {
            // gh#877: the drone-lifecycle verdict returns a RECOGNIZABLE tool RESULT
            // (not a generic "Error: ..." the agent retries) so the /loop + role
            // playbook can branch deterministically. Checked FIRST: an evicted seat is
            // a lifecycle terminal — it gets its own recognizable result rather than
            // the generic error rendering below.
            if (error instanceof DroneEvictedError) {
                return {
                    content: [{ type: 'text', text: formatEvictedToolResult(error.message) }],
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: ${error.message}`,
                    },
                ],
                isError: true,
            };
        }
    });
    // Register prompts listing — the client exposes no prompts.
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
        return { prompts: [] };
    });
    // Register prompt getter
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const { name } = request.params;
        throw new Error(`Unknown prompt: ${name}`);
    });
    // Create stdio transport
    const transport = new StdioServerTransport();
    // Connect server to transport
    await server.connect(transport);
    // Resolve drone self-identification prefix before any console output
    // (gh#25). Falls back to `[unassimilated · <repo>]` if no cube cached.
    await initConsolePrefix();
    console.error(`${consolePrefix()}◼ Borg MCP Client started`);
    console.error(`${consolePrefix()}◼ Use borg_assimilate <cube-name> to join a cube as a drone`);
    console.error(`${consolePrefix()}◼ Manage your cubes with borg --help`);
}
if (isEntryInvocation(process.argv[1], import.meta.url)) {
    main().catch((error) => {
        console.error(`${consolePrefix()}Fatal error:`, error);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map