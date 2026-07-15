import type { BorgCli } from './cubes.js';
import { wakePathArming, type AgentKind } from './regen-format.js';

/**
 * The claude kickoff prompt's wake-path section (gh#929) — the SAME shared
 * `wakePathArming` the SessionStart hook + /clear orientation use (one place,
 * not three), plus a one-line NEVER-TaskStop safety reminder preserved from
 * the pre-gh#929 monitorClause. Built by both launch call sites
 * (claude.ts + assimilate-cmd.ts) and passed to `buildAgentKickoffPrompt` as
 * `monitorClause`. Codex wakes via the app-server (no tail-Monitor / `/loop`
 * to arm) → empty; no active cube (no inboxPath) → empty.
 */
export function buildKickoffWakePathClause(
  agentKind: AgentKind,
  inboxPath: string | null,
  monitorStateRoot?: string | null
): string {
  if (agentKind === 'claude' && inboxPath) {
    return (
      wakePathArming('claude', inboxPath, monitorStateRoot) +
      '\nKeep this Monitor armed for the whole session — NEVER TaskStop it (the generic ' +
      '/loop "TaskStop any Monitor you armed" step does NOT apply to the cube inbox Monitor; ' +
      'it targets throwaway loop-scratch watches only). The sole exception is a confirmed ' +
      'terminal eviction (410 DRONE_EVICTED). '
    );
  }
  return '';
}

export interface CodexWakeTargetDeps {
  setCodexWakeTarget: (
    cubeId: string,
    droneId: string,
    target: { threadId: string; socketPath: string }
  ) => Promise<void>;
  findLoadedCodexThread: (options: {
    socketPath: string;
    cwd: string;
    previewIncludes: string;
    updatedAfter: number;
  }) => Promise<string | null>;
}

export function buildAgentKickoffPrompt(options: {
  cli: BorgCli;
  codexWakeNonce: string | null;
  monitorClause: string;
  codexWakePathClause?: string;
}): string {
  // gh#929: compacted to the load-bearing launch essentials (lean/explicit/
  // imperative, #914 treatment). STRIPPED: the read-log-triage paragraph (the
  // playbook owns it post-#914) + the role-specific anti-passive-Standing
  // clause (Coordinator/Queen-only; belongs in role-text, not injected for
  // ALL). KEPT: core call + MCP-disconnect recovery + the wake-path arming
  // (claude via the shared monitorClause = buildKickoffWakePathClause; codex
  // via codexWakePathClause) + the claude/codex/opencode cli-branching.
  const codexNonceClause = options.codexWakeNonce
    ? `Wake target nonce: ${options.codexWakeNonce}. `
    : '';
  const codexWakePathClause =
    options.codexWakePathClause ??
    `Codex Borg wakeups use remote-control when available; if no wake arrives, run borg_regen manually when returning to the session.`;
  const opencodeWakePathClause = `OpenCode wakes: the inbox Monitor is not available yet for OpenCode; check activity by calling borg_read-log periodically.`;
  const loopOrEmpty = options.cli === 'claude' ? '/loop ' : '';
  const wakeClause = options.cli === 'claude'
    ? options.monitorClause
    : options.cli === 'codex'
      ? codexWakePathClause
      : opencodeWakePathClause;
  return (
    `${loopOrEmpty}Call borg_regen and follow the playbook in its response. ` +
    codexNonceClause +
    `Note: at session start the borg MCP server is still spinning up in ` +
    `parallel — if a system reminder claims "MCP server disconnected" or ` +
    `the borg tools are not yet registered, do NOT bail. Recover via ` +
    `\`ToolSearch({query: "select:mcp__borg__borg_regen,mcp__borg__borg_log,Monitor", max_results: 3})\` ` +
    `to load the bootstrap tools in one call, then call borg_regen. ` +
    `The server typically becomes available within a few seconds. ` +
    wakeClause
  );
}

export function socketPathFromRemoteArgs(args: string[]): string | null {
  const index = args.indexOf('--remote');
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value?.startsWith('unix://')) return null;
  return value.slice('unix://'.length);
}

export function threadIdFromPassthroughArgs(args: string[]): string | null {
  if (args[0] === 'resume' && args[1] && !args[1].startsWith('-')) return args[1];
  const resumeIndex = args.indexOf('--resume');
  if (resumeIndex >= 0 && args[resumeIndex + 1]) return args[resumeIndex + 1];
  return null;
}

export async function recordCodexWakeTarget(options: {
  deps: CodexWakeTargetDeps;
  cubeId: string;
  droneId: string;
  socketPath: string;
  cwd: string;
  previewNeedle: string;
  launchedAtSeconds: number;
  passthroughArgs?: string[];
}): Promise<void> {
  try {
    const explicitThreadId = options.passthroughArgs
      ? threadIdFromPassthroughArgs(options.passthroughArgs)
      : null;
    if (explicitThreadId) {
      await options.deps.setCodexWakeTarget(options.cubeId, options.droneId, {
        threadId: explicitThreadId,
        socketPath: options.socketPath,
      });
      return;
    }

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const threadId = await options.deps.findLoadedCodexThread({
        socketPath: options.socketPath,
        cwd: options.cwd,
        previewIncludes: options.previewNeedle,
        updatedAfter: options.launchedAtSeconds - 5,
      });
      if (threadId) {
        await options.deps.setCodexWakeTarget(options.cubeId, options.droneId, {
          threadId,
          socketPath: options.socketPath,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // Best-effort mapping: launch still succeeds and manual regen remains available.
  }
}
