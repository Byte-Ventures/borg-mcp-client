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
} as const;

const COMPACT_FALLBACK =
  '## Borg Cube\nYou are in a Borg MCP multi-agent coordination cube. ' +
  'Use MCP tool borg_regen to get full context and recent activity.';
export const OPENCODE_INJECTED_ENTRY_METADATA_KEY = 'borgOpenCodeInjectedEntry';
export const OPENCODE_WAKE_IDENTITY_METADATA_KEY = 'borgOpenCodeWakeIdentity';
export const OPENCODE_RECOVERY_METADATA_KEY = 'borgOpenCodeSessionOrientation';
export const OPENCODE_LAUNCH_CORRELATION_METADATA_KEY = 'borgOpenCodeLaunchCorrelation';
const PLUGIN_REL_PATH = path.join('.config', 'opencode', 'plugins', 'borg-orient.js');

export interface OpenCodePluginCoreDeps {
  defer(task: () => Promise<void>): void;
  wait(milliseconds: number): Promise<void>;
  listMessages(sessionID: string): Promise<any[]>;
  renderOrientation(source: 'clear' | 'compact'): Promise<string>;
  submitPrompt(
    sessionID: string,
    text: string,
    recoveryVersion: string,
    shouldSubmit: () => boolean,
  ): Promise<boolean>;
  audit(messages: readonly any[]): string | null;
}

export interface OpenCodePluginCoreOptions {
  enabled: boolean;
  pluginVersion: string;
  recoveryMetadataKey: string;
  injectedEntryMetadataKey: string;
  kickoffPollAttempts: number;
  confirmationPollAttempts: number;
  pollDelayMs: number;
  compactFallback: string;
  launchCorrelationMetadataKey: string;
  launchCorrelationIdentity: string;
}

/** Pure, dependency-injected behavior core. Its emitted JavaScript function
 * body is also embedded in the installed self-contained plugin. */
export function createOpenCodePluginCore(
  deps: OpenCodePluginCoreDeps,
  options: OpenCodePluginCoreOptions,
) {
  const claimedSessions = new Set<string>();
  const humanPromptSessions = new Set<string>();
  let launchCorrelationAttached = false;
  const textParts = (message: any): any[] => Array.isArray(message?.parts)
    ? message.parts.filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    : [];
  const isInjectedEntry = (message: any): boolean => {
    const parts = textParts(message);
    return message?.info?.role === 'user' &&
      parts[0]?.metadata?.[options.injectedEntryMetadataKey] === true;
  };
  const isOwnedRecovery = (message: any): boolean => {
    const parts = textParts(message);
    return message?.info?.role === 'user' &&
      parts[0]?.metadata?.[options.recoveryMetadataKey] === options.pluginVersion;
  };
  const hasRecoveryBlocker = (sessionID: string, messages: readonly any[]): boolean =>
    humanPromptSessions.has(sessionID) || messages.some((message) =>
      isOwnedRecovery(message) ||
      (message?.info?.role === 'user' && !isInjectedEntry(message)));

  const recoverNewSession = async (sessionID: string): Promise<void> => {
    try {
      for (let attempt = 0; attempt < options.kickoffPollAttempts; attempt++) {
        const messages = await deps.listMessages(sessionID);
        if (hasRecoveryBlocker(sessionID, messages)) return;
        if (attempt + 1 < options.kickoffPollAttempts) await deps.wait(options.pollDelayMs);
      }

      const orientation = (await deps.renderOrientation('clear')).trim();
      if (!orientation) return;
      const beforeSubmit = await deps.listMessages(sessionID);
      if (hasRecoveryBlocker(sessionID, beforeSubmit)) return;

      const submitted = await deps.submitPrompt(
        sessionID,
        orientation,
        options.pluginVersion,
        () => !hasRecoveryBlocker(sessionID, []),
      );
      if (!submitted) return;
      // promptAsync is not idempotent. Confirmation may retry, submission may not.
      for (let attempt = 0; attempt < options.confirmationPollAttempts; attempt++) {
        const messages = await deps.listMessages(sessionID);
        if (messages.some(isOwnedRecovery)) return;
        if (attempt + 1 < options.confirmationPollAttempts) await deps.wait(options.pollDelayMs);
      }
    } catch {
      // The plugin is best-effort. Never block OpenCode session creation.
    }
  };

  return {
    event: async ({ event }: any): Promise<void> => {
      if (!options.enabled || event?.type !== 'session.created') return;
      const sessionID = event?.properties?.info?.id;
      if (typeof sessionID !== 'string' || claimedSessions.has(sessionID)) return;
      claimedSessions.add(sessionID);
      deps.defer(() => recoverNewSession(sessionID));
    },
    'experimental.session.compacting': async (
      _input: { sessionID: string },
      output: { context: string[] },
    ): Promise<void> => {
      if (!options.enabled) return;
      try {
        const orientation = (await deps.renderOrientation('compact')).trim();
        output.context.push(orientation || options.compactFallback);
      } catch {
        output.context.push(options.compactFallback);
      }
    },
    'chat.message': async (
      input: { sessionID: string },
      output: { message: unknown; parts: any[] },
    ): Promise<void> => {
      if (!options.enabled) return;
      let current = { info: { role: 'user' }, parts: [...output.parts] };
      if (
        !launchCorrelationAttached &&
        options.launchCorrelationIdentity &&
        !isInjectedEntry(current) &&
        !isOwnedRecovery(current)
      ) {
        const index = output.parts.findIndex((part) =>
          part?.type === 'text' && typeof part.text === 'string');
        if (index >= 0) {
          const part = output.parts[index];
          output.parts[index] = {
            ...part,
            metadata: {
              ...(part.metadata && typeof part.metadata === 'object' ? part.metadata : {}),
              [options.launchCorrelationMetadataKey]: options.launchCorrelationIdentity,
            },
          };
          launchCorrelationAttached = true;
          current = { info: { role: 'user' }, parts: [...output.parts] };
        }
      }
      if (!isInjectedEntry(current) && !isOwnedRecovery(current)) {
        // chat.message fires before the user message is persisted. Record the
        // human turn synchronously so recovery cannot race that short gap.
        humanPromptSessions.add(input.sessionID);
      }
      try {
        const history = await deps.listMessages(input.sessionID);
        const nudge = deps.audit([...history, current]);
        if (nudge) {
          // OpenCode's chat.message hook receives resolved parts after their
          // id/sessionID/messageID fields have been assigned. A newly pushed
          // part skips that assignment and fails the durable PartUpdated
          // aggregate in Session.updatePart. Preserve the resolved identity by
          // replacing an existing text part with an augmented copy instead.
          const index = output.parts.findIndex((part) =>
            part?.type === 'text' && typeof part.text === 'string');
          if (index >= 0) {
            const part = output.parts[index];
            output.parts[index] = { ...part, text: `${part.text}\n\n${nudge}` };
          }
        }
      } catch {
        // Audit is advisory and must never block a prompt.
      }
    },
  };
}

export function buildBorgPluginSource(version: string): string {
  const marker = `borgmcp-opencode-plugin:${version};opencode=${OPENCODE_COMPATIBILITY.opencode};sdk=${OPENCODE_COMPATIBILITY.sdk};textpart-metadata=exists+persisted+tui-hidden+model-hidden;wake-identity-key=${OPENCODE_WAKE_IDENTITY_METADATA_KEY}`;
  return `// ${marker}
// Generated by borgmcp. Self-contained; do not edit.
const createCore = ${createOpenCodePluginCore.toString()};
const evaluateAudit = ${evaluateLogAudit.toString()};
export default async function (ctx) {
  const launchCorrelationIdentity = process.env.BORG_OPENCODE_LAUNCH_CORRELATION || '';
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
    launchCorrelationMetadataKey: OPENCODE_LAUNCH_CORRELATION_METADATA_KEY,
  })},
    enabled: process.env.BORG_SESSION === '1',
    launchCorrelationIdentity: /^[A-Za-z0-9_-]{43}$/.test(launchCorrelationIdentity)
      ? launchCorrelationIdentity
      : '',
  });
}
`;
}

export const BORG_PLUGIN_SOURCE = buildBorgPluginSource(getPackageVersion());

export function openCodePluginPath(homeDir: string = borgHomeRoot()): string {
  return path.join(homeDir, PLUGIN_REL_PATH);
}

export function installBorgPlugin(options: {
  homeDir?: string;
  version?: string;
} = {}): void {
  const pluginPath = openCodePluginPath(options.homeDir);
  const source = buildBorgPluginSource(options.version ?? getPackageVersion());
  try {
    if (!isCanonicalPath(pluginPath)) return;
    try {
      if (fs.lstatSync(pluginPath).isSymbolicLink()) return;
      if (fs.readFileSync(pluginPath, 'utf-8') === source) return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return;
    }
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    if (!isCanonicalPath(pluginPath)) return;
    try {
      if (fs.lstatSync(pluginPath).isSymbolicLink()) return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return;
    }
    fs.writeFileSync(pluginPath, source, 'utf-8');
  } catch {
    // Best-effort — plugin is an optimization, not a requirement.
  }
}
