import type { BorgCli } from './cubes.js';
import type { AgentKind } from './agent-runtime.js';
import { wakePathArming } from './regen-format.js';
import { OPENCODE_WAKE_PATH_GUIDANCE } from './opencode-wake-copy.js';
import { withCodexCwdArg, type CodexRemoteReadyLaunch } from './codex-remote.js';
import { codexBorgSessionConfigArgs } from './launch-gate.js';
import {
  codexAgentKindConfigArgs,
  codexRemoteWakeConfigArgs,
  codexStateRootConfigArgs,
} from './agent-runtime.js';

/**
 * The claude kickoff prompt's wake-path section (gh#929) — the SAME shared
 * `wakePathArming` the SessionStart hook + /clear orientation use (one place,
 * not three), plus a one-line NEVER-TaskStop safety reminder preserved from
 * the pre-gh#929 monitorClause. Built by both launch call sites
 * (claude.ts + assimilate-cmd.ts) and passed to `buildAgentKickoffPrompt` as
 * `monitorClause`. Codex wakes via the app-server (no tail-Monitor to arm) →
 * empty; no active cube (no inboxPath) → empty.
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
      '"TaskStop any Monitor you armed" guidance does NOT apply to the cube inbox Monitor; ' +
      'it targets throwaway scratch watches only). The sole exception is a confirmed ' +
      'terminal eviction (410 DRONE_EVICTED). '
    );
  }
  return '';
}

export function buildAgentKickoffPrompt(options: {
  cli: BorgCli;
  monitorClause: string;
}): string {
  // gh#929: compacted to the load-bearing launch essentials (lean/explicit/
  // imperative, #914 treatment). STRIPPED: the read-log-triage paragraph (the
  // playbook owns it post-#914) + the role-specific anti-passive-Standing
  // clause (Coordinator/Queen-only; belongs in role-text, not injected for
  // ALL). KEPT: core call + MCP-disconnect recovery + the wake-path arming
  // (claude via the shared monitorClause = buildKickoffWakePathClause; codex
  // via the Borg-owned remote socket clause) + the cli-specific branching.
  const codexWakePathClause =
    'Codex Borg wakeups use the Borg-owned remote-control socket for this session.';
  const opencodeWakePathClause = OPENCODE_WAKE_PATH_GUIDANCE;
  const wakeClause = options.cli === 'claude'
    ? options.monitorClause
    : options.cli === 'codex'
      ? codexWakePathClause
      : opencodeWakePathClause;
  return (
    `Call borg_regen and follow the playbook in its response. ` +
    `Note: at session start the borg MCP server is still spinning up in ` +
    `parallel — if a system reminder claims "MCP server disconnected" or ` +
    `the borg tools are not yet registered, do NOT bail. Make one recovery attempt via ` +
    `\`ToolSearch({query: "select:mcp__borg__borg_regen,mcp__borg__borg_log,Monitor", max_results: 3})\` ` +
    `to load the bootstrap tools in one call, then call borg_regen. ` +
    `If that bounded attempt fails, stop and escalate to the operator. ` +
    `Never start, stop, restart, update, or recover the Borg server. ` +
    wakeClause
  );
}

export type CodexLaunchArgsResult =
  | { ready: true; args: string[] }
  | { ready: false; reason: string };

export function buildCodexLaunchArgs(options: {
  remote: CodexRemoteReadyLaunch;
  cwd: string;
  kickoff: string;
  approvalArgs?: string[];
  accessArgs?: string[];
  seatExpectationArgs?: string[];
  passthroughArgs?: string[];
}): CodexLaunchArgsResult {
  const passthroughArgs = options.passthroughArgs ?? [];
  if (passthroughArgs.some((arg) => arg === '--remote' || arg.startsWith('--remote='))) {
    return {
      ready: false,
      reason: 'Borg owns Codex remote control; remove the passthrough --remote option and retry.',
    };
  }
  const remoteValue = `unix://${options.remote.server.socketPath}`;
  if (options.remote.args.length !== 2 || options.remote.args[0] !== '--remote' || options.remote.args[1] !== remoteValue) {
    return { ready: false, reason: 'The Borg-owned Codex remote socket is unavailable.' };
  }
  return {
    ready: true,
    args: [
      ...(options.accessArgs ?? []),
      ...(options.approvalArgs ?? []),
      ...codexBorgSessionConfigArgs(),
      ...codexAgentKindConfigArgs(),
      ...codexRemoteWakeConfigArgs(),
      ...codexStateRootConfigArgs(),
      ...(options.seatExpectationArgs ?? []),
      ...options.remote.args,
      ...withCodexCwdArg([...passthroughArgs, options.kickoff], options.cwd),
    ],
  };
}
