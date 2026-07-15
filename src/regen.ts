#!/usr/bin/env node
/**
 * borg-regen CLI
 *
 * Prints a markdown-formatted regen of the active cube to stdout.
 * Designed to be wired into a Claude Code SessionStart hook so that
 * each new session begins fully oriented to the cube.
 *
 * Behavior:
 * - No active cube: print a friendly notice to stdout, exit 0.
 *   (A SessionStart hook should not block session start over a missing
 *   cube — the user may not be using Borg in this directory.)
 * - Active cube + success: print regen markdown to stdout, exit 0.
 * - Active cube + HTTP/auth error: print one-line message to stderr,
 *   exit non-zero so the hook surfaces the failure but doesn't drown
 *   the session in a stack trace.
 */

import { regen, listCubes } from './remote-client.js';
import { findProjectRoot, getActiveCube, inboxPathForDrone } from './cubes.js';
import { monitorStateRootForWorktree } from './inbox-monitor.js';
import {
  parseHookSource,
  formatLeanOrientation,
  resolveLeanIdentity,
  type AgentKind,
} from './regen-format.js';
import { resolveSessionAgentKind } from './codex-app-wake.js';
import { handleVersionFlag } from './version.js';
import { gateAllowsActivation } from './launch-gate.js';
import { resolveWorkingRepo } from './working-repo.js';

/**
 * Drain the SessionStart hook's stdin payload (best-effort). Mirrors
 * log-audit.ts: a TTY / manual run has no piped payload, so return ''
 * rather than block. Any read error degrades to '' — a hook bin must
 * never throw on its input.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  handleVersionFlag();
  // gh#673 P1 (WI-4): the SessionStart orientation only activates in
  // borg-launched sessions — a vanilla `claude` anywhere (including an
  // assimilated repo) stays vanilla. Exit-0 no-op: a hook must never
  // block session start. ACTIVATION-only, never a security gate.
  if (!gateAllowsActivation('borg-regen SessionStart hook')) {
    return;
  }
  // gh#926/gh#927: the SessionStart `source` (startup/resume/clear/compact)
  // tags the orientation; on `/clear` Claude Code has cleared the
  // session-scoped `/loop` + `ScheduleWakeup`, and the kickoff prompt is
  // gone, so the lean orientation adds a "re-establish your wake path" note.
  const source = parseHookSource(await readStdin());

  const active = await getActiveCube();
  if (!active) {
    await emitUnassimilatedNotice();
    return;
  }

  const inboxPath = inboxPathForDrone(active.cubeId, active.droneId);
  const monitorStateRoot = monitorStateRootForWorktree(findProjectRoot());
  const agentKind: AgentKind = resolveSessionAgentKind();

  // gh#927: emit a LEAN ~2KB orientation, NOT the full ~20.7KB
  // formatRegenMarkdown — the harness truncates large SessionStart-hook
  // stdout to a ~2KB preview, so the full dump left weak models partially
  // oriented on EVERY source. The full context stays available on demand via
  // the borg_regen TOOL (the lean orientation points to it). Identity comes
  // from the network regen() when reachable (fresh role name + the identity
  // self-heal); on a network/auth failure we still emit a lean orientation
  // from local getActiveCube state (net-free fallback) instead of leaving the
  // drone unoriented — a weak drone that hits a SessionStart blip still gets
  // its wake-path arming, and the borg_regen tool re-surfaces the real error.
  let result: Awaited<ReturnType<typeof regen>> | null = null;
  try {
    result = await regen(active.sessionToken, active.apiUrl, {
      workingRepo: resolveWorkingRepo(),
    });
  } catch {
    result = null;
  }
  const identity = resolveLeanIdentity(active, result);
  process.stdout.write(
    formatLeanOrientation({ ...identity, inboxPath, monitorStateRoot, agentKind, source }) + '\n'
  );
}

/**
 * Render a discoverability stub for a session that's running with the
 * borg MCP server installed but no cube assimilated in this project.
 * Informs the user which cubes exist on their account. Written as a
 * status report TO THE USER, not as instructions to the drone — the
 * drone must wait for explicit user approval before calling
 * borg_assimilate or any other state-changing borg tool.
 */
async function emitUnassimilatedNotice(): Promise<void> {
  const lines: string[] = [];
  lines.push('# Borg MCP — not connected to a cube');
  lines.push('');
  lines.push('The borg MCP server is installed in this project but no cube has been joined here yet.');
  lines.push('');
  lines.push('**Drone instructions:**');
  lines.push('1. **Tell the user** which cubes exist on their account (see the list below) and ask them which one to join, or whether to create a new cube. This is the first thing you should surface in this session.');
  lines.push('2. **Do not** call `borg_assimilate`, `borg_create-cube`, or any other state-changing borg tool until the user has chosen.');
  lines.push('3. The user may also decline to use borg in this project at all — that\'s a valid choice; just stop suggesting it.');
  lines.push('');
  // Best-effort: list the user's cubes so the user can see what's
  // available if they decide to join one. Network failure or auth
  // issue here is non-fatal — the SessionStart hook should never
  // block session start.
  try {
    const { cubes } = await listCubes();
    if (cubes.length > 0) {
      lines.push('## Cubes on your account');
      for (const c of cubes) {
        lines.push(`- **${c.name}** (id: ${c.id})`);
      }
    } else {
      lines.push('## Cubes on your account');
      lines.push('_(none yet — offer to create one via `borg_create-cube` once the user confirms)_');
    }
  } catch (err: any) {
    lines.push('## Cubes on your account');
    lines.push('_(could not list — ' + (err?.message ?? String(err)) + ')_');
  }
  lines.push('');
  lines.push('## Tools you can call once the user has chosen');
  lines.push('- Join an existing cube: `borg_assimilate cube_name="<their choice>"`');
  lines.push('- Create a new cube: `borg_create-cube name="<name>" cube_directive="<markdown>"` (optionally `template="software-dev"`)');
  lines.push('- See available templates: `borg_list-templates`');
  process.stdout.write(lines.join('\n') + '\n');
}

main().catch((error: any) => {
  const msg = error?.message ?? String(error);
  process.stderr.write(`borg-regen: ${msg}\n`);
  process.exit(1);
});
