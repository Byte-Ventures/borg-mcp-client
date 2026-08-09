import fs from 'node:fs';
import path from 'node:path';
import { evaluateLogAudit } from './log-audit-core.js';
import { borgHomeRoot } from './private-root.js';
import { getPackageVersion } from './version.js';
export const OPENCODE_COMPATIBILITY = {
    // Empirically pinned on 2026-08-09. OpenCode 1.18.15 loads the default
    // function -> Hooks object shape while the installed SDK uses the 1.17.18
    // path/query/body client call shape. Do not replace it with the v2 flat
    // call shape without a new live compatibility measurement.
    opencode: '1.18.15',
    sdk: '1.17.18',
};
const COMPACT_FALLBACK = '## Borg Cube\nYou are in a Borg MCP multi-agent coordination cube. ' +
    'Use MCP tool borg_regen to get full context and recent activity.';
const KICKOFF_MARKER = 'borg-opencode-correlation:';
const RECOVERY_MARKER = 'borg-opencode-session-orientation:';
const PLUGIN_REL_PATH = path.join('.config', 'opencode', 'plugins', 'borg-orient.js');
/** Pure, dependency-injected behavior core. Its emitted JavaScript function
 * body is also embedded in the installed self-contained plugin. */
export function createOpenCodePluginCore(deps, options) {
    const claimedSessions = new Set();
    const textFromMessages = (messages) => messages
        .flatMap((message) => Array.isArray(message?.parts) ? message.parts : [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    const recoveryIdentity = `${options.recoveryMarker}${options.pluginVersion}`;
    const recoveryComment = `<!-- ${recoveryIdentity} -->`;
    const recoverNewSession = async (sessionID) => {
        try {
            for (let attempt = 0; attempt < options.kickoffPollAttempts; attempt++) {
                const messages = await deps.listMessages(sessionID);
                const text = textFromMessages(messages);
                if (text.includes(options.kickoffMarker) || text.includes(recoveryIdentity))
                    return;
                if (messages.length > 0)
                    return;
                if (attempt + 1 < options.kickoffPollAttempts)
                    await deps.wait(options.pollDelayMs);
            }
            const orientation = (await deps.renderOrientation('clear')).trim();
            if (!orientation)
                return;
            const beforeSubmit = await deps.listMessages(sessionID);
            const beforeText = textFromMessages(beforeSubmit);
            if (beforeText.includes(options.kickoffMarker) || beforeText.includes(recoveryIdentity))
                return;
            if (beforeSubmit.length > 0)
                return;
            await deps.submitPrompt(sessionID, `${orientation}\n\n${recoveryComment}`);
            // promptAsync is not idempotent. Confirmation may retry, submission may not.
            for (let attempt = 0; attempt < options.confirmationPollAttempts; attempt++) {
                const messages = await deps.listMessages(sessionID);
                if (textFromMessages(messages).includes(recoveryIdentity))
                    return;
                if (attempt + 1 < options.confirmationPollAttempts)
                    await deps.wait(options.pollDelayMs);
            }
        }
        catch {
            // The plugin is best-effort. Never block OpenCode session creation.
        }
    };
    return {
        event: async ({ event }) => {
            if (!options.enabled || event?.type !== 'session.created')
                return;
            const sessionID = event?.properties?.info?.id;
            if (typeof sessionID !== 'string' || claimedSessions.has(sessionID))
                return;
            claimedSessions.add(sessionID);
            deps.defer(() => recoverNewSession(sessionID));
        },
        'experimental.session.compacting': async (_input, output) => {
            if (!options.enabled)
                return;
            try {
                const orientation = (await deps.renderOrientation('compact')).trim();
                output.context.push(orientation || options.compactFallback);
            }
            catch {
                output.context.push(options.compactFallback);
            }
        },
        'chat.message': async (input, output) => {
            if (!options.enabled)
                return;
            try {
                const history = await deps.listMessages(input.sessionID);
                const current = { info: { role: 'user' }, parts: [...output.parts] };
                const nudge = deps.audit([...history, current]);
                if (nudge)
                    output.parts.push({ type: 'text', text: nudge });
            }
            catch {
                // Audit is advisory and must never block a prompt.
            }
        },
    };
}
export function buildBorgPluginSource(version) {
    const marker = `borgmcp-opencode-plugin:${version};opencode=${OPENCODE_COMPATIBILITY.opencode};sdk=${OPENCODE_COMPATIBILITY.sdk}`;
    return `// ${marker}
// Generated by borgmcp. Self-contained; do not edit.
const createCore = ${createOpenCodePluginCore.toString()};
const evaluateAudit = ${evaluateLogAudit.toString()};
export default async function (ctx) {
  const runRegen = async (source) => {
    const input = JSON.stringify({ source });
    const result = await ctx.$\`printf '%s' \${input} | borg-regen\`.quiet().nothrow();
    return result.exitCode === 0 ? result.stdout.toString('utf8') : '';
  };
  return createCore({
    defer: (task) => { setTimeout(() => { void task(); }, 0); },
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    listMessages: async (sessionID) => {
      const result = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      });
      return Array.isArray(result.data) ? result.data : [];
    },
    renderOrientation: runRegen,
    submitPrompt: async (sessionID, text) => {
      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        query: { directory: ctx.directory },
        body: { parts: [{ type: 'text', text }] },
      });
    },
    audit: (messages) => evaluateAudit(messages),
  }, {
    ...${JSON.stringify({
        pluginVersion: version,
        kickoffMarker: KICKOFF_MARKER,
        recoveryMarker: RECOVERY_MARKER,
        kickoffPollAttempts: 6,
        confirmationPollAttempts: 6,
        pollDelayMs: 200,
        compactFallback: COMPACT_FALLBACK,
    })},
    enabled: process.env.BORG_SESSION === '1',
  });
}
`;
}
export const BORG_PLUGIN_SOURCE = buildBorgPluginSource(getPackageVersion());
export function openCodePluginPath(homeDir = borgHomeRoot()) {
    return path.join(homeDir, PLUGIN_REL_PATH);
}
export function installBorgPlugin(options = {}) {
    const pluginPath = openCodePluginPath(options.homeDir);
    const source = buildBorgPluginSource(options.version ?? getPackageVersion());
    try {
        if (fs.existsSync(pluginPath) && fs.readFileSync(pluginPath, 'utf-8') === source)
            return;
        fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
        fs.writeFileSync(pluginPath, source, 'utf-8');
    }
    catch {
        // Best-effort — plugin is an optimization, not a requirement.
    }
}
//# sourceMappingURL=opencode-plugin.js.map