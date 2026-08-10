import fs from 'node:fs';
import path from 'node:path';
import { evaluateLogAudit } from './log-audit-core.js';
import { borgHomeRoot, isCanonicalPath } from './private-root.js';
import { getPackageVersion } from './version.js';
export const OPENCODE_COMPATIBILITY = {
    // Empirically pinned on 2026-08-09. OpenCode 1.18.15 loads the default
    // function -> Hooks object shape while the installed SDK uses the 1.17.18
    // path/query/body client call shape. TextPart.metadata exists, persists
    // through history/compaction/reload, and is hidden from the TUI and model.
    // Do not replace either contract without a new live compatibility measurement.
    opencode: '1.18.15',
    sdk: '1.17.18',
};
const COMPACT_FALLBACK = '## Borg Cube\nYou are in a Borg MCP multi-agent coordination cube. ' +
    'Use MCP tool borg_regen to get full context and recent activity.';
export const OPENCODE_INJECTED_ENTRY_METADATA_KEY = 'borgOpenCodeInjectedEntry';
export const OPENCODE_WAKE_IDENTITY_METADATA_KEY = 'borgOpenCodeWakeIdentity';
export const OPENCODE_RECOVERY_METADATA_KEY = 'borgOpenCodeSessionOrientation';
const PLUGIN_REL_PATH = path.join('.config', 'opencode', 'plugins', 'borg-orient.js');
/** Pure, dependency-injected behavior core. Its emitted JavaScript function
 * body is also embedded in the installed self-contained plugin. */
export function createOpenCodePluginCore(deps, options) {
    const claimedSessions = new Set();
    const humanPromptSessions = new Set();
    const textParts = (message) => Array.isArray(message?.parts)
        ? message.parts.filter((part) => part?.type === 'text' && typeof part.text === 'string')
        : [];
    const isInjectedEntry = (message) => {
        const parts = textParts(message);
        return message?.info?.role === 'user' &&
            parts[0]?.metadata?.[options.injectedEntryMetadataKey] === true;
    };
    const isOwnedRecovery = (message) => {
        const parts = textParts(message);
        return message?.info?.role === 'user' &&
            parts[0]?.metadata?.[options.recoveryMetadataKey] === options.pluginVersion;
    };
    const hasRecoveryBlocker = (sessionID, messages) => humanPromptSessions.has(sessionID) || messages.some((message) => isOwnedRecovery(message) ||
        (message?.info?.role === 'user' && !isInjectedEntry(message)));
    const recoverNewSession = async (sessionID) => {
        try {
            for (let attempt = 0; attempt < options.kickoffPollAttempts; attempt++) {
                const messages = await deps.listMessages(sessionID);
                if (hasRecoveryBlocker(sessionID, messages))
                    return;
                if (attempt + 1 < options.kickoffPollAttempts)
                    await deps.wait(options.pollDelayMs);
            }
            const orientation = (await deps.renderOrientation('clear')).trim();
            if (!orientation)
                return;
            const beforeSubmit = await deps.listMessages(sessionID);
            if (hasRecoveryBlocker(sessionID, beforeSubmit))
                return;
            const submitted = await deps.submitPrompt(sessionID, orientation, options.pluginVersion, () => !hasRecoveryBlocker(sessionID, []));
            if (!submitted)
                return;
            // promptAsync is not idempotent. Confirmation may retry, submission may not.
            for (let attempt = 0; attempt < options.confirmationPollAttempts; attempt++) {
                const messages = await deps.listMessages(sessionID);
                if (messages.some(isOwnedRecovery))
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
            const current = { info: { role: 'user' }, parts: [...output.parts] };
            if (!isInjectedEntry(current) && !isOwnedRecovery(current)) {
                // chat.message fires before the user message is persisted. Record the
                // human turn synchronously so recovery cannot race that short gap.
                humanPromptSessions.add(input.sessionID);
            }
            try {
                const history = await deps.listMessages(input.sessionID);
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
    const marker = `borgmcp-opencode-plugin:${version};opencode=${OPENCODE_COMPATIBILITY.opencode};sdk=${OPENCODE_COMPATIBILITY.sdk};textpart-metadata=exists+persisted+tui-hidden+model-hidden;wake-identity-key=${OPENCODE_WAKE_IDENTITY_METADATA_KEY}`;
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
    submitPrompt: async (sessionID, text, recoveryVersion, shouldSubmit) => {
      if (!shouldSubmit()) return false;
      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        query: { directory: ctx.directory },
        body: { parts: [{
          type: 'text',
          text,
          metadata: { [${JSON.stringify(OPENCODE_RECOVERY_METADATA_KEY)}]: recoveryVersion },
        }] },
      });
      return true;
    },
    audit: (messages) => evaluateAudit(messages),
  }, {
    ...${JSON.stringify({
        pluginVersion: version,
        recoveryMetadataKey: OPENCODE_RECOVERY_METADATA_KEY,
        injectedEntryMetadataKey: OPENCODE_INJECTED_ENTRY_METADATA_KEY,
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
        if (!isCanonicalPath(pluginPath))
            return;
        try {
            if (fs.lstatSync(pluginPath).isSymbolicLink())
                return;
            if (fs.readFileSync(pluginPath, 'utf-8') === source)
                return;
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                return;
        }
        fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
        if (!isCanonicalPath(pluginPath))
            return;
        try {
            if (fs.lstatSync(pluginPath).isSymbolicLink())
                return;
        }
        catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                return;
        }
        fs.writeFileSync(pluginPath, source, 'utf-8');
    }
    catch {
        // Best-effort — plugin is an optimization, not a requirement.
    }
}
//# sourceMappingURL=opencode-plugin.js.map