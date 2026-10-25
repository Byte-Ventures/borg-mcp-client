import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fs } from './guarded-fs.js';
import { parseJsonc } from './config-utils.js';
import { applyOpenCodeV2LaunchPermissions } from './opencode-v2-permissions.js';
import { inspectOpenCodeInstallation, verifyOpenCodeExecutableStillMatches, OpenCodeExecutableChangedError, type OpenCodeInstallation } from './opencode-installation.js';
import { startOpenCodeV2Server } from './opencode-v2-server.js';
import { createOpenCodeV2Transport } from './opencode-v2-transport.js';
import { startOpenCodeV2Broker, OPENCODE_V2_DESCRIPTOR_ENV, type OpenCodeV2Seat } from './opencode-v2-broker.js';
import { installLaunchOpenCodePlugin, migrateLegacyOpenCodePlugin } from './opencode-launch-plugin.js';
import { selectOpenCodeAdapter } from './opencode-adapter.js';
import { borgAgentConfigEnv } from './private-root.js';
import { openCodePrivateRoot, sameOpenCodeDirectory } from './opencode-private-state.js';
import { resolveMcpBinaryPath, resolveRegenPath } from './self-path.js';
import { getActiveCube, BORG_LAUNCH_EXPECTED_SEAT_ENV } from './cubes.js';
import type { ConfigEntry } from '@opencode/client';

export function preserveOpenCodeV2McpOptions(sources: readonly ConfigEntry[]): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  let environment: Record<string, string> = {};
  for (const source of sources) {
    if (source.type !== 'document') continue;
    const mcp: any = source.info.mcp;
    const entry = mcp?.servers?.borg ?? mcp?.borg;
    if (!entry || typeof entry !== 'object') continue;
    for (const key of ['codemode', 'timeout', 'protocol']) if (entry[key] !== undefined) preserved[key] = entry[key];
    environment = { ...environment, ...entry.environment };
  }
  delete environment.OPENCODE_PASSWORD; delete environment.OPENCODE_SERVER_PASSWORD;
  return { ...preserved, environment };
}

export interface OpenCodeV2SessionArgs { sessionID?: string; continue: boolean; rest: string[] }
class OpenCodeV2LaunchError extends Error {}
export function parseOpenCodeV2SessionArgs(args: readonly string[]): OpenCodeV2SessionArgs {
  const result: OpenCodeV2SessionArgs = { continue: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--continue' || arg === '-c') { result.continue = true; continue; }
    if (arg === '--session' || arg === '-s' || arg.startsWith('--session=') || /^-s.+/.test(arg)) {
      const value = arg === '--session' || arg === '-s' ? args[++i] : arg.startsWith('--session=') ? arg.slice(10) : arg.slice(2);
      if (!value || !/^ses_[A-Za-z0-9_-]+$/.test(value) || result.sessionID) throw new Error('Supply one valid OpenCode session ID.');
      result.sessionID = value; continue;
    }
    if (arg === '--' || /^(--(?:server|standalone|port|hostname|fork|prompt|directory)(?:=|$)|-p)/.test(arg)) {
      throw new Error('Borg owns the OpenCode 2 server, session, and kickoff. Remove the conflicting launch option.');
    }
    result.rest.push(arg);
  }
  if (result.sessionID && result.continue) throw new Error('Choose --session or --continue, not both.');
  return result;
}

/** Native V2 config stays launch-local. JSONC files are read, never rewritten. */
export function openCodeV2LaunchOverlay(env: NodeJS.ProcessEnv, descriptorPath: string, pluginDirectory: string,
  mcpCommand: string[] = [process.execPath, resolveMcpBinaryPath()]): NodeJS.ProcessEnv {
  const content: any = env.OPENCODE_CONFIG_CONTENT ? parseJsonc(env.OPENCODE_CONFIG_CONTENT) : {};
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Invalid OPENCODE_CONFIG_CONTENT');
  const existing = content.mcp?.servers?.borg ?? content.mcp?.borg ?? {};
  const environment: Record<string, string> = {
    BORG_SESSION: '1', BORG_AGENT_KIND: 'opencode', BORG_OPENCODE: '1',
    [OPENCODE_V2_DESCRIPTOR_ENV]: descriptorPath,
  };
  for (const key of ['BORG_STATE_ROOT', 'BORG_API_URL', BORG_LAUNCH_EXPECTED_SEAT_ENV]) if (env[key]) environment[key] = env[key]!;
  return { ...borgAgentConfigEnv(env), BORG_SESSION: '1', BORG_AGENT_KIND: 'opencode', BORG_OPENCODE: '1', [OPENCODE_V2_DESCRIPTOR_ENV]: descriptorPath,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content,
      mcp: { ...content.mcp, servers: { ...content.mcp?.servers,
        borg: { ...existing, type: 'local', command: mcpCommand, environment,
          disabled: false, ...(existing.codemode === false ? { codemode: false } : {}) } } },
      plugins: [...(content.plugins ?? content.plugin ?? []), pluginDirectory],
    }),
  };
}

function renderOrientation(directory: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [resolveRegenPath()], { cwd: directory, env, timeout: 10_000, maxBuffer: 1_048_576 },
      (error, stdout) => resolve(error ? '' : stdout));
    child.stdin?.end(JSON.stringify({ source: 'compact' }));
  });
}

export async function launchOpenCodeV2Process(options: {
  installation: OpenCodeInstallation; cwd: string; env: NodeJS.ProcessEnv;
  prompt: string; passthroughArgs?: string[]; skipApprovalOverride?: boolean;
  seat?: OpenCodeV2Seat; spawnProcess?: typeof spawn;
  /** Dependency seam for the opt-in native compatibility harness. */
  mcpCommand?: string[];
}): Promise<{ process: ReturnType<typeof spawn>; cleanup: () => Promise<void> }> {
  const args = parseOpenCodeV2SessionArgs(options.passthroughArgs ?? []);
  if (options.installation.minor < 1 || (options.installation.minor === 1 && options.installation.patch < 2)) {
    throw new Error('Borg requires OpenCode 2.1.2 or newer for OpenCode 2 integration.');
  }
  const directory = realpathSync(options.cwd);
  const active = options.seat ? null : await getActiveCube();
  const seat = options.seat ?? { worktree: realpathSync(active?.worktree ?? directory),
    droneId: active?.droneId ?? 'unassimilated', cubeId: active?.cubeId ?? 'unassimilated' };
  if (!sameOpenCodeDirectory(directory, seat.worktree)) throw new Error('OpenCode 2 must launch in the selected drone worktree.');
  migrateLegacyOpenCodePlugin();
  let installation = options.installation;
  for (let attempt = 0; attempt < 2; attempt++) {
    const launch = randomBytes(32).toString('base64url');
    const plugin = installLaunchOpenCodePlugin(2, launch);
    const descriptorPath = path.join(openCodePrivateRoot(), `opencode-v2-${launch}.json`);
    const env = openCodeV2LaunchOverlay(options.env, descriptorPath, plugin.directory, options.mcpCommand);
    // V1's per-launch permission object is not a V2 policy source.
    delete env.OPENCODE_PERMISSION;
    let server: Awaited<ReturnType<typeof startOpenCodeV2Server>> | undefined;
    let broker: Awaited<ReturnType<typeof startOpenCodeV2Broker>> | undefined;
    let phase = 'private server startup';
    let kickoffAttempted = false;
    const cleanup = async () => {
      await broker?.close(); await server?.close(); fs.rmSync(plugin.directory, { recursive: true, force: true });
    };
    try {
      server = await startOpenCodeV2Server({ installation, directory, env });
      phase = 'configuration inspection';
      const transport = await createOpenCodeV2Transport(server);
      const mcpOptions = preserveOpenCodeV2McpOptions(await transport.client.config.get({ location: { directory } }));
      const { Session } = await import('@opencode/schema/session');
      let sessionID = args.sessionID ?? Session.ID.create();
      phase = 'session broker startup';
      broker = await startOpenCodeV2Broker({ launch, transport, seat, sessionID, mcpOptions,
        server: { pid: server.pid!, version: server.version }, orientation: () => renderOrientation(directory, env) });
      phase = 'session selection';
      if (args.continue) {
        // Native --continue is an explicit user request; never use this list
        // heuristic for later autonomous wake/session switching.
        const sessions = await transport.client.session.list({ directory, parentID: null, order: 'desc', limit: 100 });
        const candidate = sessions.data.find((s) => !s.parentID && sameOpenCodeDirectory(s.location.directory, directory));
        if (candidate) sessionID = candidate.id;
      }
      if (args.sessionID) {
        try { await transport.client.session.get({ sessionID }); }
        catch { await transport.client.session.create({ id: sessionID, location: { directory } }, { signal: AbortSignal.timeout(60_000) }); }
      } else if (!args.continue || sessionID === broker.descriptor.sessionID) {
        // Creating the first native instance can initialize plugins/providers.
        // Keep that startup bounded without applying its longer limit to wakes.
        await transport.client.session.create({ id: sessionID, location: { directory }, title: 'Borg' }, { signal: AbortSignal.timeout(60_000) });
      }
      phase = 'session binding';
      await broker.selectSession(sessionID);
      phase = 'runtime plugin readiness';
      // The published native host lazily loads plugins on prompt admission,
      // not on metadata/registry reads. Queue an inert, non-resuming probe and
      // cancel it before attaching the TUI or admitting the real kickoff.
      const probe = await broker.call('/wake', { text: 'Borg runtime readiness probe', key: 'readiness',
        source: 'readiness', allowSubmit: true, resume: false });
      if (!probe.accepted) throw new OpenCodeV2LaunchError('OpenCode 2 runtime readiness could not be confirmed.');
      await transport.client.session.inbox.cancel({ sessionID, inboxID: probe.id });
      await broker.call('/settle', { source: 'readiness' });
      const status = await broker.call('/status');
      if (!status.pluginReady) throw new OpenCodeV2LaunchError('OpenCode 2 Borg plugin did not become ready. No kickoff was submitted.');
      phase = 'Borg tool registry readiness';
      const mcpDeadline = Date.now() + 15_000;
      while (seat.droneId !== 'unassimilated') {
        const mcp = await transport.client.mcp.list({ location: { directory } });
        const borg = mcp.data.find(item => item.name === 'borg');
        if (borg?.status.status === 'connected' && (await broker.call('/status')).tools.length) break;
        if (borg?.status.status === 'failed' || Date.now() >= mcpDeadline) {
          throw new OpenCodeV2LaunchError('OpenCode 2 could not connect its Borg MCP server. No kickoff was submitted.');
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      phase = 'permission inspection';
      for (const warning of await applyOpenCodeV2LaunchPermissions(transport.client, sessionID, directory, options.skipApprovalOverride === true,
        [directory, ...(options.env.BORG_LAUNCH_SCRATCH ? [options.env.BORG_LAUNCH_SCRATCH] : [])])) console.error(`warning: ${warning}`);
      const launchArgs = selectOpenCodeAdapter(installation).buildTuiArgs({ directory,
        port: Number(new URL(server.url).port), sessionId: sessionID, prompt: options.prompt, passthroughArgs: args.rest });
      verifyOpenCodeExecutableStillMatches(installation, env);
      phase = 'TUI attachment';
      const child = (options.spawnProcess ?? spawn)(installation.executable, launchArgs,
        { cwd: directory, stdio: 'inherit', shell: false, env: { ...env, ...server.tuiEnv() } });
      let stopped = false;
      child.once('error', () => { stopped = true; void cleanup(); });
      child.once('exit', () => { stopped = true; void cleanup(); });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('OpenCode 2 TUI could not start.'))); });
      void server.closed.then(() => { if (!stopped) child.kill(); });
      // The runtime probe verified hooks before the TUI was started. Admit
      // exactly one real kickoff after successful native process creation.
      if (stopped) { child.kill(); throw new OpenCodeV2LaunchError('OpenCode 2 exited before kickoff admission.'); }
      phase = 'kickoff admission'; kickoffAttempted = true;
      const admission = await broker.call('/wake', { text: options.prompt, key: 'kickoff', source: 'kickoff', allowSubmit: true });
      if (!admission.accepted) { child.kill(); throw new OpenCodeV2LaunchError('OpenCode 2 kickoff admission could not be confirmed.'); }
      return { process: child, cleanup };
    } catch (error) {
      await cleanup();
      if (error instanceof OpenCodeExecutableChangedError && attempt === 0) {
        installation = inspectOpenCodeInstallation(options.env);
        if (installation.major !== 2) throw new Error('OpenCode changed major version during launch. Relaunch Borg.');
        continue;
      }
      if (error instanceof OpenCodeV2LaunchError) throw error;
      throw new OpenCodeV2LaunchError(`OpenCode 2 failed during ${phase}. ${kickoffAttempted
        ? 'Kickoff admission is unconfirmed; inspect the session before submitting it again.'
        : 'No kickoff was submitted. Check the selected session and worktree, then relaunch Borg.'}`);
    }
  }
  throw new Error('OpenCode changed repeatedly during launch. Relaunch Borg.');
}
