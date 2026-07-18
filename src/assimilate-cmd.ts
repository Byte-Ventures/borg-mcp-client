import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Role, RoleOccupant } from './role-resolver.js';
import {
  roleSlug,
  matchRoleByName,
  occupiedRoleIdsForAutoRole,
  pickDefaultRole,
} from './role-resolver.js';
import { deriveCubeName, parseGitRemote, sanitizeRemoteUrl } from './cube-name.js';
import { validateName } from './name-validator.js';
import { renderAssimilationWelcome } from './assimilate-welcome.js';
import { shellEscape } from './shell-escape.js';
import { withCodexCwdArg, type CodexRemoteLaunch } from './codex-remote.js';
import {
  buildAgentKickoffPrompt,
  buildKickoffWakePathClause,
  recordCodexWakeTarget,
  socketPathFromRemoteArgs,
} from './codex-launch.js';
import { perWorktreeBranchName, adoptWorktree, computeWorktreePath, localBranchExists, isMerged } from './worktree-lifecycle.js';
import { DroneEvictedError } from './drone-lifecycle.js';
import { codexBorgSessionConfigArgs } from './launch-gate.js';
import {
  codexAgentKindConfigArgs,
  codexRemoteWakeConfigArgs,
  withAgentRuntimeEnv,
} from './agent-runtime.js';
import type { BorgCli } from './cubes.js';
import { inboxPathForDrone } from './cubes.js';
import { monitorStateRootForWorktree } from './inbox-monitor.js';
import { resolveLaunchEnv } from './model-presets.js';
import { unlinkSync } from 'node:fs';
import {
  gcOrphanInboxesForCube,
  defaultListInboxLogs,
  defaultInboxLivenessDeps,
  isInboxLive,
  ORPHAN_INBOX_STALE_MS,
} from './gc-orphan-inboxes.js';
import { installBorgPlugin } from './opencode-plugin.js';
import { computeOpenCodePort, connectOpenCodeDrone, createOpenCodeLaunchKickoff, injectInitialKickoff } from './opencode-drone.js';
import { ensureCliMcpConfigured } from './ensure-mcp-config.js';
import { normalizeServerEndpoint } from './server-endpoint.js';
import { BorgServerError } from './server-errors.js';
import type { SeatStatus } from './seat-probe.js';
import type { ServerSessionOperation } from './config.js';
import { buildOpenCodeLaunchArgs, type LaunchApprovalDecision } from './cli-tool-approval.js';

export interface AssimilateFlags {
  worktree?: string;
  template?: string;
  noTemplate?: boolean;
  cubeName?: string;
  here?: boolean;
  yes?: boolean;
  cli?: BorgCli;
  model?: string;
  server?: string;
  enroll?: boolean;
}

export interface AssimilateArgs {
  role: string | undefined;
  flags: AssimilateFlags;
}

export interface CubeSummary {
  id: string;
  name: string;
}

export interface CubeDetail {
  id: string;
  name: string;
  roles: Role[];
  // Active seats in the cube (GET /api/cubes/:id returns active-only via
  // listDrones). Used to auto-pick an UNOCCUPIED worker role on a bare
  // assimilate. Optional — an older worker that omits drones degrades to
  // "no occupancy known" (first eligible worker / default).
  drones?: RoleOccupant[];
}

export interface AssimilateResult {
  cube_id: string;
  drone_id: string;
  drone_label: string;
  session_token?: string;
  role_id: string;
  local_session?: {
    credential_ref: string;
    expires_at: string | null;
  };
  // Idempotent-reattach discriminant: 'reused' when the server resolved the
  // client bearer to an existing seat, 'created' on a first/fresh attach.
  result?: 'created' | 'reused';
}

export interface ActiveCube {
  cubeId: string;
  droneId: string;
  name: string;
  sessionToken?: string;
  droneLabel: string;
  apiUrl: string;
  /** Verified local-server CA identity; absent for Borg Cloud cubes. */
  serverTrustIdentity?: string;
  localSessionCredentialRef?: string;
  localSessionExpiresAt?: string | null;
  // gh#899: assimilated role, persisted for connect-time tool-surface scoping
  // (mirrors cubes.ts ActiveCube; optional → backward-compatible).
  roleName?: string;
  roleClass?: 'queen' | 'worker';
  isHumanSeat?: boolean;
}

export interface AssimilateDeps {
  runSync: (cmd: string, args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };
  pathExists: (p: string) => boolean;
  cwd: () => string;
  chdir: (p: string) => void;

  // gh#556 Part 1 — worktree relocation to ~/.borg/worktrees/<repo>/<name>.
  // homedir seams $HOME (tests inject a sandbox); mkdirp is a plain recursive
  // create (NO chmod — must not disturb ~/.borg's existing perms / the
  // encrypted credentials file that lives there, config.ts).
  homedir: () => string;
  mkdirp: (dir: string) => void;
  exec: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<number>;

  stderr: (line: string) => void;
  stdout: (line: string) => void;
  prompt: (message: string) => Promise<string>;
  promptSecret: (message: string) => Promise<string>;
  isTTY: () => boolean;
  /** Selected-harness approval inspection/consent (client#20). */
  resolveCliApprovals?: (cli: BorgCli, cwd: string) => Promise<LaunchApprovalDecision>;

  // CR-PD-F1 (drone-2 Phase D review 2026-05-18T04:13Z) — gh#104
  // captured os.hostname() at assimilate-time as load-bearing for
  // DroneCard surfacing. Seamed so tests inject + Phase F wires
  // `() => os.hostname()`.
  getHostname: () => string;

  // CR-PD-F2 (same review) — spec rev-2 step 8 mandates terminal-title
  // `borg · <drone-label> · <cube-name>`. Real wiring imports from
  // src/terminal-title.ts:setTerminalTitle which is already
  // TTY-safe. Seamed so tests can verify the call without touching
  // process.stdout.
  setTerminalTitle: (label: string, cubeName: string) => void;

  // CR-PD-F3 — getActiveCube/setActiveCube are fs/promises-backed in
  // src/cubes.ts (Promise<ActiveCube|null> / Promise<void>).
  // The scaffold previously declared them sync; that would silently
  // mis-await in Phase F wiring. Promise<...> matches the real shape.
  getActiveCube: () => Promise<ActiveCube | null>;
  hasPersistedActiveCube: () => Promise<boolean>;
  probeSeat: (
    sessionToken: string,
    apiUrl: string,
    serverTrustIdentity?: string,
  ) => Promise<SeatStatus>;
  setActiveCube: (a: ActiveCube) => Promise<void>;
  findProjectRoot: (cwd: string) => string;

  // gh#673 P2 (WI-1): write the borg-regen SessionStart hook into the
  // launch root's .claude/settings.local.json (project-local; idempotent).
  // Real wiring = config-utils addProjectSessionStartHook.
  installProjectSessionHook: (projectRoot: string) => void;

  getCachedAuth: () => Promise<{ token: string; apiUrl: string } | null>;
  runSetup: () => Promise<{ token: string; apiUrl: string }>;
  cloudApiUrl: string;
  /** gh#27: optional test seam — when set, selectAssimilationAuthority uses
   *  this instead of prompting/failing. Not wired in production. */
  defaultAuthority?: AssimilationAuthority;
  detectLocalServer: () => Promise<string | null>;
  connectServer: (
    apiUrl: string,
    enrollment?: { invitation: string },
  ) => Promise<{
    token: string;
    trustIdentity: string;
    serverCapabilities?: readonly string[];
  }>;
  resumeServerEnrollment: (
    apiUrl: string,
    onPending?: () => void,
  ) => Promise<{
    token: string;
    trustIdentity: string;
    serverCapabilities?: readonly string[];
  } | null>;

  listCubes: (apiUrl: string, token: string, serverTrustIdentity?: string) => Promise<CubeSummary[]>;
  getCube: (apiUrl: string, token: string, cubeId: string, serverTrustIdentity?: string) => Promise<CubeDetail>;
  createCube: (
    apiUrl: string,
    token: string,
    params: { name?: string; template?: string; projectRoot?: string },
    serverTrustIdentity?: string,
  ) => Promise<CubeDetail>;
  assimilate: (
    apiUrl: string,
    token: string,
    params: { cube_id: string; role_id: string; hostname?: string | null; prior_drone_id?: string; remint_invalid_prior?: boolean; model?: string | null; agent_kind?: 'claude' | 'codex' | 'opencode' | null; session_operation?: ServerSessionOperation },
    serverTrustIdentity?: string,
  ) => Promise<AssimilateResult>;
  listTemplates: (apiUrl: string, token: string, serverTrustIdentity?: string) => Promise<Array<{ name: string; description: string }>>;

  // CR-PE-F1 (drone-2 Phase E review 2026-05-18T04:59Z): step 8 kickoff
  // must include the inbox-monitor clause that claude.ts:96-112 uses
  // for the no-args path. Real wiring imports `inboxPathForDrone` from
  // src/cubes.ts; tests stub a deterministic path.
  getInboxPath: (cubeId: string, droneId: string) => string;

  // BUG-5 / v0.9.3: probe whether the borg-mcp stdio binary starts
  // cleanly + responds to `initialize` within a short timeout. Used
  // before launching Claude Code in step 8 so the launched session
  // doesn't race against MCP-server startup. Resolves to `true` when
  // initialize succeeded within the timeout, `false` otherwise.
  // Real wiring spawns `borg-mcp`, sends initialize, awaits response,
  // kills child. Tests stub the result. Defense-in-depth alongside
  // the kickoff text recovery clause — fast-path keeps things silent
  // on healthy hosts; degraded-path surfaces a stderr warning and
  // still launches claude (never blocks).
  probeMcpReady: () => Promise<boolean>;
  resolveCli: (explicit?: BorgCli) => Promise<BorgCli>;
  prepareCodexRemoteLaunch: () => Promise<CodexRemoteLaunch>;
  setCodexWakeTarget: (cubeId: string, droneId: string, target: { threadId: string; socketPath: string }) => Promise<void>;
  findLoadedCodexThread: (options: {
    socketPath: string;
    cwd: string;
    previewIncludes: string;
    updatedAfter: number;
  }) => Promise<string | null>;

}

type AssimilationAuthority =
  | { kind: 'cloud'; apiUrl: string }
  | { kind: 'server'; apiUrl: string };

function affirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === '' || normalized === 'y' || normalized === 'yes';
}

function isLocalCubePresentationName(name: string): boolean {
  return name.length >= 1 && name.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name);
}

async function selectAssimilationAuthority(
  flags: AssimilateFlags,
  deps: AssimilateDeps,
): Promise<AssimilationAuthority | null> {
  if (flags.server !== undefined) {
    try {
      return { kind: 'server', apiUrl: normalizeServerEndpoint(flags.server) };
    } catch (error) {
      deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  }

  // gh#27: non-TTY and --yes must NOT infer Cloud — the user must explicitly
  // choose an authority. Fail closed instead of silently routing to Cloud.
  if (!deps.isTTY() || flags.yes) {
    if (deps.defaultAuthority) return deps.defaultAuthority;
    deps.stderr('No authority specified. Use --host <server> to select a local server, or run without --yes from an interactive terminal to choose an authority.\n');
    return null;
  }

  let detected: string | null = null;
  try {
    const candidate = await deps.detectLocalServer();
    detected = candidate ? normalizeServerEndpoint(candidate) : null;
  } catch {
    // Detection is advisory. A failed probe is the same UX state as "none
    // found"; an explicitly selected endpoint remains fail-closed below.
  }

  if (detected) {
    const answer = await deps.prompt(
      `Local Borg server detected at ${detected}.\nConnect this project to it? [Y/n]: `,
    );
    if (affirmative(answer)) return { kind: 'server', apiUrl: detected };
  }

  const choice = (await deps.prompt(
    'Connect this project to:\n' +
      '  1) A Borg server (local or self-hosted)\n' +
      '  2) Borg Cloud (borgmcp.ai; subscription required)\n' +
      '[1]: ',
  )).trim();
  if (choice === '' || choice === '1') {
    const host = await deps.prompt('Borg server host or URL: ');
    try {
      return { kind: 'server', apiUrl: normalizeServerEndpoint(host) };
    } catch (error) {
      deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  }
  if (choice !== '2') {
    deps.stderr(`invalid authority choice ${JSON.stringify(choice)}\n`);
    return null;
  }

  return { kind: 'cloud', apiUrl: deps.cloudApiUrl };
}

function localAssimilateCommand(apiUrl: string, enroll = false): string {
  return `\`borg assimilate --host ${apiUrl}${enroll ? ' --enroll' : ''}\``;
}

function localAssimilateRoleCommand(apiUrl: string): string {
  return `\`borg assimilate --host ${apiUrl} <role>\``;
}

function localAssimilateCliCommand(apiUrl: string, cli: BorgCli): string {
  return `\`borg assimilate --host ${apiUrl} --cli ${cli}\``;
}

function reportServerFailure(
  deps: AssimilateDeps,
  apiUrl: string,
  error: unknown,
  enroll = false,
): number {
  const message = error instanceof Error ? error.message : String(error);
  const retryCommand = localAssimilateCommand(apiUrl, enroll);
  if (error instanceof BorgServerError && error.code === 'CREATE_CUBE_DENIED') {
    deps.stderr(
      `This enrolled client cannot create a cube on ${apiUrl}. ` +
        'Ask the server operator to grant access to a cube, then rerun ' +
        `${localAssimilateCommand(apiUrl)}.\n`,
    );
    return 1;
  }
  if (error instanceof BorgServerError && error.code === 'NOT_ENROLLED') {
    deps.stderr(
      `No saved enrollment for ${apiUrl}. Run ` +
        `${localAssimilateCommand(apiUrl, true)} from the operator’s terminal.\n`,
    );
    return 1;
  }
  if (error instanceof BorgServerError && error.code === 'CREDENTIAL_REJECTED') {
    deps.stderr(
      `The saved enrollment for ${apiUrl} was rejected. Re-run ` +
        `${localAssimilateCommand(apiUrl, true)} from the operator’s terminal.\n`,
    );
    return 1;
  }
  if (error instanceof BorgServerError && error.code === 'INVITATION_REJECTED') {
    deps.stderr(
      `The enrollment invitation for ${apiUrl} was rejected or expired. ` +
        'Ask the server operator for a replacement enrollment invitation. ' +
        'For an unclaimed owner client, stop the server and run `borg-mcp-server owner-invite`; ' +
        'for an ordinary client, stop the server and run `borg-mcp-server client-invite`. ' +
        'Restart it with `borg-mcp-server start`, then rerun ' +
        `${localAssimilateCommand(apiUrl, true)}.\n`,
    );
    return 1;
  }
  if (/HTTP 40[13]|auth(?:entication|orization)|credential.*(?:invalid|rejected)/i.test(message)) {
    deps.stderr(
      `The saved enrollment for ${apiUrl} was rejected. Re-run ` +
        `${localAssimilateCommand(apiUrl, true)} from the operator’s terminal.\n`,
    );
    return 1;
  }
  if (/^Borg server keychain state is busy$/i.test(message)) {
    deps.stderr(
      `The OS keychain is busy for ${apiUrl} because another Borg process is ` +
        `creating or resuming secure state. Wait for it to finish, then rerun ${retryCommand}.\n`,
    );
    return 1;
  }
  if (/keychain|secure credential (?:store|storage)/i.test(message)) {
    deps.stderr(
      `Borg could not access the OS keychain for ${apiUrl}. ` +
        `Unlock or enable the keychain, then rerun ${retryCommand}.\n`,
    );
    return 1;
  }
  if (/trust|certificate|\bCA\b|authority state|pinned identity|cross-authority/i.test(message)) {
    deps.stderr(
      `Borg could not verify the expected server identity for ${apiUrl}. ` +
        'Verify that this is the expected server. If it was re-initialized, stop it, ' +
        'run `borg-mcp-server start`, then rerun ' +
        `${retryCommand}.\n`,
    );
    return 1;
  }
  if (/connect|fetch|network|timed? ?out|timeout|ECONN|ENOTFOUND|EHOST|unreachable|aborted|socket/i.test(message)) {
    deps.stderr(
      `Could not reach Borg server at ${apiUrl}. ` +
        'Start or restart it with `borg-mcp-server start`, then rerun ' +
        `${retryCommand}.\n`,
    );
    return 1;
  }
  const safeMessage = safeStderr(message)
    .replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')
    .slice(0, 240);
  deps.stderr(
    `Borg server at ${apiUrl} returned an unexpected response: ` +
      `${safeMessage || 'request failed'}. ` +
      `Check that the client and server versions are compatible, then rerun ${retryCommand}.\n`,
  );
  return 1;
}

export async function runAssimilate(
  args: AssimilateArgs,
  deps: AssimilateDeps
): Promise<number> {
  // ----- Input validation (before any subprocess work) -----
  if (args.role !== undefined) {
    const v = validateName(args.role);
    if (!v.ok) {
      deps.stderr(v.error + '\n');
      return 1;
    }
  }
  if (args.flags.worktree !== undefined) {
    const v = validateName(args.flags.worktree);
    if (!v.ok) {
      deps.stderr(v.error + '\n');
      return 1;
    }
  }

  // ----- Step 1: Authority selection, then authority-specific auth -----
  // This MUST precede cloud token lookup/setup. A selected local server never
  // receives Google credentials and never falls back to Cloud.
  const authority = await selectAssimilationAuthority(args.flags, deps);
  if (!authority) return 1;

  // ----- Repository + cube-name preflight -----
  // Resolve and, where necessary, confirm local presentation data before an
  // owner invitation can be consumed. A declined/underivable basename must
  // not leave a successfully enrolled client behind.
  const projectRoot = deps.findProjectRoot(deps.cwd());
  let cubeName: string | null;
  if (args.flags.cubeName) {
    cubeName = args.flags.cubeName;
  } else {
    const remoteResult = deps.runSync('git', ['remote', 'get-url', 'origin'], projectRoot);
    const remoteUrl = remoteResult.status === 0 ? remoteResult.stdout : null;
    const sanitizedRemote = remoteUrl ? sanitizeRemoteUrl(remoteUrl) : null;
    const parsedRepo = sanitizedRemote ? parseGitRemote(sanitizedRemote) : null;

    if (!parsedRepo) {
      const bareResult = deps.runSync('git', ['rev-parse', '--is-bare-repository'], projectRoot);
      if (bareResult.status === 0 && bareResult.stdout.trim() === 'true') {
        deps.stderr(
          'borg assimilate requires a non-bare repository worktree. ' +
            (authority.kind === 'server'
              ? `Clone or check out the repository, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`
              : 'Clone or check out the repository, then retry.\n'),
        );
        return 1;
      }
    }

    cubeName = deriveCubeName(projectRoot, remoteUrl);
    if (!cubeName) {
      deps.stderr(
        'Could not derive a cube name from this repository. ' +
          (authority.kind === 'server'
            ? `Rerun ${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\`.\n`
            : 'Pass --cube-name <name> and retry.\n'),
      );
      return 1;
    }

    if (!parsedRepo) {
      if (sanitizedRemote) {
        deps.stderr(
          `Could not parse the origin remote; using directory name '${cubeName}' as the cube name.\n`,
        );
      }
      if (!args.flags.yes) {
        if (!deps.isTTY()) {
          deps.stderr(
            `Using directory name '${cubeName}' as the cube name requires confirmation. ` +
              (authority.kind === 'server'
                ? `Rerun ${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\` or \`--yes\`.\n`
                : 'Re-run with --cube-name <name> or --yes.\n'),
          );
          return 1;
        }
        const confirmed = await deps.prompt(
          `No usable origin remote was found. Use directory name '${cubeName}' as the cube name? [Y/n]: `,
        );
        if (!affirmative(confirmed)) {
          deps.stderr(
            authority.kind === 'server'
              ? `Cube creation for ${authority.apiUrl} was cancelled. Rerun ` +
                `${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\`.\n`
              : 'Cube creation cancelled. Re-run with --cube-name <name> to choose a name.\n',
          );
          return 1;
        }
      }
    }
  }

  if (authority.kind === 'server' && !isLocalCubePresentationName(cubeName)) {
    deps.stderr(
      `Invalid cube name for ${authority.apiUrl}. Use 1–120 letters, digits, spaces, dots, ` +
        'underscores, or hyphens, starting with a letter or digit. Rerun ' +
        `${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\`.\n`,
    );
    return 1;
  }

  let auth: { token: string; apiUrl: string; serverTrustIdentity?: string };
  if (authority.kind === 'server') {
    try {
      let serverAuth: {
        token: string;
        trustIdentity: string;
        serverCapabilities?: readonly string[];
      };
      if (args.flags.enroll) {
        if (!deps.isTTY()) {
          deps.stderr(
            'Local enrollment requires an interactive operator terminal. ' +
              `Re-run ${localAssimilateCommand(authority.apiUrl, true)} from the operator’s terminal.\n`,
          );
          return 1;
        }
        const resumed = await deps.resumeServerEnrollment(authority.apiUrl, () => {
          deps.stderr(
            `Resuming the pending enrollment for \`${authority.apiUrl}\`; ` +
              'do not enter another invitation.\n',
          );
        });
        if (resumed) {
          serverAuth = resumed;
        } else {
          let invitation = await deps.promptSecret(
            `Enrollment invitation for \`${authority.apiUrl}\` (single-use; hidden input):`,
          );
          if (!invitation) {
            deps.stderr(
              `No enrollment invitation was entered for ${authority.apiUrl}. ` +
                `Ask the server operator for one, then rerun ${localAssimilateCommand(authority.apiUrl, true)}.\n`,
            );
            return 1;
          }
          try {
            serverAuth = await deps.connectServer(authority.apiUrl, { invitation });
          } finally {
            // Strings cannot be zeroized in JavaScript, but drop this command's
            // reference immediately after the exchange instead of retaining the
            // invitation through the rest of assimilation/agent launch.
            invitation = '';
          }
        }
        if (serverAuth.serverCapabilities?.includes('create_cube')) {
          deps.stderr(
            `Owner client enrolled with \`${authority.apiUrl}\`. ` +
              'Creating or joining this repository’s cube next.\n',
          );
        } else {
          deps.stderr(
            `Ordinary client enrolled with \`${authority.apiUrl}\`. ` +
              'Checking for an accessible repository cube next.\n',
          );
        }
      } else {
        serverAuth = await deps.connectServer(authority.apiUrl);
      }
      auth = {
        token: serverAuth.token,
        apiUrl: authority.apiUrl,
        serverTrustIdentity: serverAuth.trustIdentity,
      };
    } catch (error) {
      return reportServerFailure(deps, authority.apiUrl, error, args.flags.enroll === true);
    }
  } else {
    let cloudAuth = await deps.getCachedAuth();
    if (!cloudAuth) {
      if (!deps.isTTY() && !args.flags.yes) {
        deps.stderr('borg setup required and stdin is non-interactive. Run `borg setup` first in an interactive terminal, then `borg assimilate`.\n');
        return 1;
      }
      cloudAuth = await deps.runSetup();
    }
    auth = cloudAuth;
  }

  // gh#293: detect cross-account cube reference (owner-email:cube-name format).
  let crossAccountRef: { ownerEmail: string; cubeName: string } | null = null;
  if (cubeName && cubeName.includes('@') && cubeName.includes(':')) {
    const colonIdx = cubeName.lastIndexOf(':');
    crossAccountRef = {
      ownerEmail: cubeName.substring(0, colonIdx),
      cubeName: cubeName.substring(colonIdx + 1),
    };
    cubeName = crossAccountRef.cubeName;
  }

  // ----- Sprint 19 (gh#184): Reorder for strict-rollback semantics. -----
  // The previous flow created a sibling worktree (FS state) BEFORE
  // role resolution + API assimilate. Any early-return between
  // worktree-spawn and API success orphaned the worktree (gh#184
  // canonical case: unknown role arg). The new flow defers all FS
  // state until AFTER the API assimilate succeeds — early-return at
  // role resolution / listCubes / createCube / template-prompt /
  // template-invalid-choice is now structurally clean (no orphan
  // class possible). Worktree rollback narrows to the single
  // setActiveCube failure path post-worktree-creation.

  // Sprint 18: capture pre-chdir cwd for the post-exit shell-cd hint
  // (no chdir has happened yet; this is a stable starting point).
  const originalCwd = deps.cwd();

  // ----- Step 3: Cube existence check (with auto-refresh on auth failure) -----
  // gh#653 B4: announce each network step. These calls take 2–5s and were
  // previously silent, so a user read the wait as a hang and Ctrl-C'd mid-run.
  deps.stderr('Checking your cubes…\n');
  let allCubes: CubeSummary[];
  try {
    allCubes = auth.serverTrustIdentity === undefined
      ? await deps.listCubes(auth.apiUrl, auth.token)
      : await deps.listCubes(auth.apiUrl, auth.token, auth.serverTrustIdentity);
  } catch (err) {
    if (authority.kind === 'server') {
      return reportServerFailure(deps, authority.apiUrl, err);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Authentication required') || msg.includes('Authentication expired')) {
      deps.stderr('Re-authenticating...\n');
      auth = await deps.runSetup();
      allCubes = await deps.listCubes(auth.apiUrl, auth.token);
    } else {
      throw err;
    }
  }
  const existingCube = allCubes.find((c) => c.name === cubeName);

  // gh#312: cross-account typo guard. If the user typed owner@example.com:cube-name
  // and the cube isn't found, error out — don't silently create a new cube.
  if (!existingCube && crossAccountRef) {
    deps.stderr(
      `No cube named '${crossAccountRef.cubeName}' accessible to you owned by '${crossAccountRef.ownerEmail}'. Did you accept their invite? See borgmcp.ai/dashboard.\n`
    );
    return 1;
  }

  // ----- Step 4: Fetch detail OR create cube -----
  let cubeDetail: CubeDetail;
  let isFirstDrone: boolean;
  if (existingCube) {
    try {
      cubeDetail = auth.serverTrustIdentity === undefined
        ? await deps.getCube(auth.apiUrl, auth.token, existingCube.id)
        : await deps.getCube(
          auth.apiUrl,
          auth.token,
          existingCube.id,
          auth.serverTrustIdentity,
        );
    } catch (error) {
      if (authority.kind === 'server') return reportServerFailure(deps, authority.apiUrl, error);
      throw error;
    }
    isFirstDrone = false;
  } else {
    // ----- Step 4a: First-drone bootstrap (template selection) -----
    let chosenTemplate: string | undefined;
    if (authority.kind === 'server') {
      if (args.flags.noTemplate ||
          (args.flags.template !== undefined && args.flags.template !== 'default')) {
        deps.stderr(
          `Borg server ${authority.apiUrl} supports its default cube template only. ` +
            `Rerun ${localAssimilateCommand(authority.apiUrl)} without \`--template\` or \`--no-template\`.\n`,
        );
        return 1;
      }
      chosenTemplate = 'default';
    } else if (args.flags.template) {
      chosenTemplate = args.flags.template;
    } else if (args.flags.noTemplate) {
      chosenTemplate = undefined;
    } else if (!deps.isTTY()) {
      if (!args.flags.yes) {
        deps.stderr(
          'cube creation needs a template choice but stdin is non-interactive.\n' +
          'Pass --template <name>, --no-template, or --yes (defaults to starter).\n'
        );
        return 1;
      }
      chosenTemplate = 'starter';
    } else if (args.flags.yes) {
      chosenTemplate = 'starter';
    } else {
      let templates: Array<{ name: string; description: string }>;
      try {
        templates = auth.serverTrustIdentity === undefined
          ? await deps.listTemplates(auth.apiUrl, auth.token)
          : await deps.listTemplates(auth.apiUrl, auth.token, auth.serverTrustIdentity);
      } catch (error) {
        throw error;
      }
      const lines = ['First drone joining a new cube. Apply a template?'];
      templates.forEach((t, i) => {
        const tag = i === 0 ? ' (default)' : '';
        lines.push(`  ${i + 1}) ${t.name}${tag} — ${t.description}`);
      });
      lines.push(`  ${templates.length + 1}) skip — no template`);
      const answer = (await deps.prompt(lines.join('\n') + '\n[1]: ')).trim();
      const choice = answer === '' ? 1 : parseInt(answer, 10);
      if (Number.isNaN(choice) || choice < 1 || choice > templates.length + 1) {
        deps.stderr(`invalid choice "${answer}"\n`);
        return 1;
      }
      chosenTemplate = choice <= templates.length ? templates[choice - 1].name : undefined;
    }

    // gh#653 B4: progress for the create round-trip (silent-window stall).
    deps.stderr(cubeName ? `Creating cube '${cubeName}'…\n` : 'Creating your cube…\n');
    try {
      const createParams = chosenTemplate
        ? {
          name: cubeName ?? undefined,
          template: chosenTemplate,
          ...(authority.kind === 'server' ? { projectRoot } : {}),
        }
        : { name: cubeName ?? undefined };
      cubeDetail = auth.serverTrustIdentity === undefined
        ? await deps.createCube(auth.apiUrl, auth.token, createParams)
        : await deps.createCube(
          auth.apiUrl,
          auth.token,
          createParams,
          auth.serverTrustIdentity,
        );
    } catch (error) {
      if (authority.kind === 'server') return reportServerFailure(deps, authority.apiUrl, error);
      throw error;
    }
    isFirstDrone = true;
  }

  // Read the worktree identity before role selection. A live local seat must
  // retain its original role so the attach request reuses the exact durable
  // retry binding instead of selecting another unoccupied role and minting a
  // duplicate seat.
  const existing = await deps.getActiveCube();
  const hasPersistedIdentity = existing !== null || await deps.hasPersistedActiveCube();
  const wantSibling =
    args.flags.worktree !== undefined || (existing !== null && !args.flags.here);
  const sessionOperation: ServerSessionOperation = {
    // Capture the source repository before a successful sibling attach changes
    // cwd. This is the stable seat/sibling namespace for the pending bearer, so a
    // deliberate sibling never collides with the durable in-place seat's bearer.
    projectRoot,
    kind: wantSibling ? 'sibling' : 'seat',
    operationKey: wantSibling
      ? (args.flags.worktree === undefined
        ? 'implicit-sibling'
        : `named-sibling:${args.flags.worktree}`)
      : 'current-worktree',
  };
  let reattachPriorId: string | undefined;
  let remintInvalidPrior = false;
  let savedLocalRole: Role | undefined;
  if (existing && args.flags.here && existing.cubeId !== cubeDetail.id) {
    deps.stderr(
      authority.kind === 'server'
        ? `This directory already hosts an active drone for another cube on ${authority.apiUrl}. ` +
          `Remove \`--here\` or use a fresh worktree, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`
        : 'this directory already hosts an active drone; remove --here or run from a fresh worktree\n',
    );
    return 1;
  }

  if (authority.kind === 'server') {
    if (!existing && hasPersistedIdentity) {
      deps.stderr(
        `This worktree has saved seat metadata for ${authority.apiUrl}, but its secure session ` +
          'could not be loaded. No new seat was created. Unlock or restore the OS ' +
          `keychain, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`,
      );
      return 1;
    }
    if (
      existing && args.flags.here &&
      (existing.apiUrl !== auth.apiUrl ||
        existing.serverTrustIdentity !== auth.serverTrustIdentity)
    ) {
      deps.stderr(
        `This worktree's saved seat does not match ${authority.apiUrl}. ` +
          'No new seat was created. Restore the expected server identity or use a fresh ' +
          `worktree, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`,
      );
      return 1;
    }

    // The per-seat PENDING bearer is the resume mechanism: a lost attach
    // response is recovered when the next attach re-sends the identical bearer,
    // so there is no separate unfinished-attach store to scan. Reattach identity
    // for `--here` comes from this worktree's saved active cube below.
    if (existing && args.flags.here) {
      savedLocalRole = existing.roleName
        ? cubeDetail.roles.find((role) => role.name === existing.roleName)
        : undefined;
      const status = await deps.probeSeat(
        existing.sessionToken ?? '',
        auth.apiUrl,
        auth.serverTrustIdentity,
      );
      if (status === 'frozen') {
        deps.stderr(
          `This worktree's saved seat on ${authority.apiUrl} is temporarily frozen. ` +
            'No new seat was created. Ask the server operator to restore access, then rerun ' +
            `${localAssimilateCommand(authority.apiUrl)}.\n`,
        );
        return 1;
      }
      if (status === 'indeterminate') {
        deps.stderr(
          `Borg could not verify this worktree's saved seat on ${authority.apiUrl}. ` +
            'No new seat was created. Start or restart the server with ' +
            `\`borg-mcp-server start\`, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`,
        );
        return 1;
      }
      if (status === 'live' && !savedLocalRole) {
        deps.stderr(
          `Borg verified this worktree's saved seat on ${authority.apiUrl}, but its saved ` +
            'role is unavailable. No new seat was created. Ask the server operator to restore ' +
            `the role, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`,
        );
        return 1;
      }
      reattachPriorId = existing.droneId;
      remintInvalidPrior = status === 'evicted';
    }
  } else if (existing && args.flags.here) {
    if (existing.serverTrustIdentity !== undefined || existing.apiUrl !== auth.apiUrl) {
      deps.stderr(
        'This worktree\'s saved seat belongs to a different Borg authority. ' +
          'No new seat was created; use a fresh worktree.\n',
      );
      return 1;
    }
    reattachPriorId = existing.droneId;
  }

  // ----- Step 5: Role resolution -----
  let resolvedRole: Role | undefined;
  if (savedLocalRole) {
    resolvedRole = savedLocalRole;
  } else if (args.role !== undefined) {
    resolvedRole = matchRoleByName(cubeDetail.roles, args.role);
    if (!resolvedRole) {
      // Sprint 19 (gh#184) + drone-7 metaphor argument: include a
      // fuzzy-match "did you mean ...?" suggestion to serve Queen's
      // "more user-friendly" intent without violating the
      // Borg-collective metaphor (collective defines roles; drones
      // slot in). Levenshtein distance ≤2 on the cube's role names.
      const available = cubeDetail.roles.map((r) => r.name).join(', ');
      const suggestion = suggestRoleName(args.role, cubeDetail.roles.map((r) => r.name));
      const suggestionLine = suggestion ? ` Did you mean "${suggestion}"?` : '';
      if (authority.kind === 'server') {
        deps.stderr(
          `No role matching "${args.role}" in cube "${cubeDetail.name}" on ${authority.apiUrl}. ` +
            `Available: ${available}.${suggestionLine}\n` +
            `Rerun ${localAssimilateRoleCommand(authority.apiUrl)} with one of the available roles.\n`,
        );
      } else {
        deps.stderr(
          `no role matching "${args.role}" in cube "${cubeDetail.name}". Available: ${available}.${suggestionLine}\n` +
          `(Use --template <name> on first-drone setup or run \`borg_create-role\` from inside Claude.)\n`
        );
      }
      return 1;
    }
  } else {
    const occupiedRoleIds = occupiedRoleIdsForAutoRole(cubeDetail.drones ?? []);
    resolvedRole = pickDefaultRole(cubeDetail.roles, { isFirstDrone, occupiedRoleIds });
    if (!resolvedRole) {
      if (authority.kind === 'server') {
        deps.stderr(
          `Cube "${cubeDetail.name}" on ${authority.apiUrl} has no default or human-seat role. ` +
            `Ask the server operator to configure a role, then rerun ` +
            `${localAssimilateRoleCommand(authority.apiUrl)}.\n`,
        );
      } else {
        deps.stderr(
          `cube "${cubeDetail.name}" has no default or human-seat role; cannot infer a role. ` +
          `Either pass a role argument explicitly (e.g. \`borg assimilate builder\`) or ` +
          `run \`borg_create-role\` from inside Claude to set up roles.\n`
        );
      }
      return 1;
    }
  }

  // ----- Step 5b: --here collision check BEFORE the API mint (gh#780) -----
  // Pre-gh#780 this check lived in Step 7 — AFTER the API assimilate — so a
  // `--here` run in a directory that already hosts a drone minted a fresh
  // drones row server-side, then aborted before Step 8 ever persisted the
  // mapping: an orphan seat with no local identity. The check must precede
  // the mint. (The full worktree DECISION stays in Step 7 by design — FS
  // state only after API success; this hoists only the abort case.)
  //
  // PR-D refinement: --here + existing + SAME authority/cube is the
  // saved-seat recovery flow. Cloud passes prior_drone_id to its API. Local
  // seats first prove liveness with their keychained session, then reuse the
  // saved role/retry binding; only authoritative eviction rotates that retry.

  // Role defaults and local launch state do not select the model. The explicit
  // Claude-only flag remains temporarily for compatibility with existing
  // invocations.
  const effectiveModel: string | null = args.flags.model ?? null;

  // Resolve the agent CLI now so the worker learns agent_kind AT assimilate
  // time.
  const cli = await deps.resolveCli(args.flags.cli);
  try {
    ensureCliMcpConfigured(cli);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (authority.kind === 'server') {
      deps.stderr(
        `${cli} MCP configuration failed for ${authority.apiUrl}: ${safeStderr(message)}. ` +
          `Fix the ${cli} MCP configuration, then rerun ` +
          `${localAssimilateCliCommand(authority.apiUrl, cli)}.\n`,
      );
    } else {
      deps.stderr(`${cli} MCP configuration failed: ${message}\n`);
    }
    return 1;
  }

  // ----- Step 6: API assimilate (no FS state yet — clean exit on failure) -----
  // gh#653 B4: progress for the seat-mint round-trip (silent-window stall).
  deps.stderr(`Joining cube '${cubeDetail.name}' as ${resolvedRole.name}…\n`);
  let result: AssimilateResult;
  try {
    const assimilateParams = {
      cube_id: cubeDetail.id,
      role_id: resolvedRole.id,
      hostname: deps.getHostname(),
      agent_kind: cli,
      model: effectiveModel,
      ...(reattachPriorId ? { prior_drone_id: reattachPriorId } : {}),
      ...(remintInvalidPrior ? { remint_invalid_prior: true } : {}),
      ...(authority.kind === 'server'
        ? { session_operation: sessionOperation }
        : {}),
    };
    result = auth.serverTrustIdentity === undefined
      ? await deps.assimilate(auth.apiUrl, auth.token, assimilateParams)
      : await deps.assimilate(
        auth.apiUrl,
        auth.token,
        assimilateParams,
        auth.serverTrustIdentity,
      );
  } catch (err) {
    // gh#877 follow-up: a re-attach (`--here`) whose saved seat was evicted is
    // REFUSED server-side (410 DRONE_EVICTED) rather than silently re-minting a
    // fresh drone. Surface the terminal recovery path instead of the generic
    // "assimilate failed". Only on a reattach attempt (reattachPriorId set);
    // a non-reattach DroneEvictedError falls through to the generic message.
    if (err instanceof DroneEvictedError && reattachPriorId != null) {
      if (authority.kind === 'server') {
        deps.stderr(
          `This worktree's saved seat on ${authority.apiUrl} was evicted. ` +
            `Remove this worktree, or from a fresh worktree run ` +
            `${localAssimilateCommand(authority.apiUrl)}.\n`,
        );
      } else {
        deps.stderr(
          `seat evicted — this worktree's saved seat was evicted from the cube. ` +
            `Re-assimilate fresh from a terminal, or remove this worktree.\n`
        );
      }
      return 1;
    }
    if (authority.kind === 'server') {
      return reportServerFailure(deps, authority.apiUrl, err);
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(`assimilate failed: ${message}\n`);
    return 1;
  }

  if (authority.kind === 'server' && result.local_session === undefined) {
    return reportServerFailure(
      deps,
      authority.apiUrl,
      new Error('Borg server did not return compatible secure session metadata'),
    );
  }
  if (authority.kind === 'cloud' && !result.session_token) {
    deps.stderr('assimilate failed: Borg Cloud did not return a session token\n');
    return 1;
  }

  // The server may assimilate a member into a DIFFERENT role than the client's
  // auto-picked default (gh#700 fallback: when the member's invite doesn't
  // grant the default role, the server picks one of their GRANTED roles).
  // Resolve the role the SERVER ACTUALLY assigned (result.role_id) and use it
  // for all human-facing display + naming below — not the client's pre-pick.
  // The drone label / session token are already server-truth; this aligns the
  // displayed role name + worktree slug with what was actually assigned.
  const assignedRole =
    cubeDetail.roles.find((r) => r.id === result.role_id) ?? resolvedRole;
  if (result.result === 'reused') {
    // The seat's existing role is authoritative on an idempotent reattach —
    // a role difference is expected, not a grant fallback. The bearer is
    // reused, not rotated: no new drone minted.
    deps.stderr(
      `re-attached to existing seat ${result.drone_label} (same session, no new drone minted)\n`
    );
  } else if (assignedRole.id !== resolvedRole.id) {
    deps.stderr(
      `The requested role "${resolvedRole.name}" was unavailable; ` +
      `attached to the "${assignedRole.name}" seat instead.\n`
    );
  }

  // ----- Step 7: Worktree decision (FS state ONLY after API success) -----
  // (`existing` was read at Step 5b; a different-cube --here collision
  // already aborted there, pre-mint. The surviving --here + existing case
  // is the SAME-cube reattach — an in-place recovery, never a sibling
  // spawn.)
  let spawnedWorktreePath: string | null = null;

  if (wantSibling) {
    // BUG-4 / gh#150 fix (v0.9.5): `git worktree add --detach <path>`
    // fails with "fatal: not a valid object name: 'HEAD'" when the
    // repo has no commits yet (unborn HEAD). Detect explicitly via
    // `git rev-parse --verify HEAD` so we surface an actionable
    // prerequisite error rather than git's cryptic internal message.
    const headProbe = deps.runSync('git', ['rev-parse', '--verify', 'HEAD'], projectRoot);
    if (headProbe.status !== 0) {
      deps.stderr(
        `sibling worktree spawn requires HEAD pointing at a commit.\n` +
        `  Fix: create at least one commit (\`git commit --allow-empty -m "initial"\`)\n` +
        `  OR:  pass --here to skip the sibling spawn and use the current directory\n`
      );
      return 1;
    }
    const localHead = headProbe.stdout.trim();
    const originProbe = deps.runSync('git', ['remote', 'get-url', 'origin'], projectRoot);
    let startRef = 'HEAD';
    if (originProbe.status === 0 && originProbe.stdout.trim().length > 0) {
      // gh#238: when origin exists, fetch it so the new worktree starts on the
      // latest remote default branch rather than a possibly stale local HEAD.
      deps.runSync('git', ['fetch', 'origin'], projectRoot);

      const mainProbe = deps.runSync('git', ['rev-parse', '--verify', 'origin/main'], projectRoot);
      if (mainProbe.status === 0) {
        startRef = 'origin/main';
      } else {
        const masterProbe = deps.runSync('git', ['rev-parse', '--verify', 'origin/master'], projectRoot);
        if (masterProbe.status === 0) {
          startRef = 'origin/master';
        }
      }
    }

    if (startRef === 'HEAD') {
      deps.stderr(
        `note: no usable origin; new worktree will start on local HEAD (${localHead.slice(0, 7)})\n`
      );
    } else {
      // Warn if local HEAD diverges from the remote default branch.
      const remoteHead = deps.runSync('git', ['rev-parse', startRef], projectRoot).stdout.trim();
      if (localHead !== remoteHead) {
        deps.stderr(
          `note: local HEAD (${localHead.slice(0, 7)}) differs from ${startRef} (${remoteHead.slice(0, 7)}); ` +
          `new worktree will start on ${startRef}\n`
        );
      }
    }

    const repoBase = basename(projectRoot);
    const suffix = args.flags.worktree ?? roleSlug(assignedRole.name);
    // gh#556 Part 1: empty-suffix guard (CR-binding). roleSlug can yield '' for a
    // pathological all-special-char role name; an empty leaf would let join() collapse
    // the worktree path up to the repo-level dir (~/.borg/worktrees/<repo>) and spawn a
    // worktree at the parent-of-all-this-repo's-worktrees. Fail loud BEFORE the path calc.
    if (suffix.length === 0) {
      deps.stderr(
        `cannot derive a worktree name from role "${assignedRole.name}"; ` +
        `pass an explicit --worktree <name>\n`
      );
      return 1;
    }
    // gh#556 Part 1: NEW worktrees live under ~/.borg/worktrees/<repo>/<name>
    // (was a sibling <parent>/<repo>-<name>). Existing siblings are untouched
    // (absolute git-registered paths). Collision dedup KEPT (<name>-<n>).
    const homeDir = deps.homedir();
    let candidate = computeWorktreePath(homeDir, repoBase, suffix);
    let wtBranch = perWorktreeBranchName(basename(candidate), repoBase);
    let n = 2;
    // gh#864: dedup against an existing worktree PATH/registration AND against a
    // lingering UNMERGED per-worktree branch. `git worktree add -b <wtBranch>`
    // (below) hard-fails when <wtBranch> already exists even if its old worktree
    // was pruned — so a stale ref would block the spawn. A MERGED lingering
    // branch is safely adoptable (handled at the add), so it does NOT force a
    // suffix bump; only an UNMERGED ref (carrying un-merged commits) bumps to a
    // fresh suffix so we never reuse/clobber its work.
    while (
      deps.pathExists(candidate) ||
      worktreeRegistered(deps, projectRoot, candidate) ||
      (localBranchExists(deps.runSync, projectRoot, wtBranch) &&
        !isMerged(deps.runSync, projectRoot, wtBranch, startRef))
    ) {
      candidate = computeWorktreePath(homeDir, repoBase, suffix, n);
      wtBranch = perWorktreeBranchName(basename(candidate), repoBase);
      n++;
    }
    // gh#556 Part 1: create the intermediate ~/.borg/worktrees/<repo>/ before
    // `git worktree add` (git creates the leaf, not the parent chain). Plain
    // recursive mkdir — NO chmod of the existing ~/.borg (credentials file).
    deps.mkdirp(dirname(candidate));
    // gh#33 (Q1/Q4): spawn on a named per-worktree branch (wt-<suffix>),
    // NOT detached HEAD. The named branch is current with startRef and is
    // where the drone's feature branches get cut from. Uniform for every
    // role incl. coordinator — main is never a working branch (Q4).
    // Branch naming is UNAFFECTED by the relocation: perWorktreeBranchName's
    // as-is else-branch maps the new basename <suffix> → wt-<suffix> (== old).
    //
    // gh#864: if <wtBranch> already exists here it is MERGED (the loop bumped
    // past any unmerged ref), so ADOPT it — `git worktree add <path> <branch>`
    // (no -b) attaches the merged branch instead of failing on a create-
    // collision. A fresh suffix has no ref → create it at startRef with -b.
    const wt = localBranchExists(deps.runSync, projectRoot, wtBranch)
      ? deps.runSync('git', ['worktree', 'add', candidate, wtBranch], projectRoot)
      : deps.runSync('git', ['worktree', 'add', '-b', wtBranch, candidate, startRef], projectRoot);
    if (wt.status !== 0) {
      deps.stderr(`git worktree add failed: ${safeStderr(wt.stderr)}\n`);
      return 1;
    }
    deps.stderr(
      `spawned sibling worktree at ${candidate} on branch ${wtBranch} (${startRef}); ` +
      `original dir is registered as active (edit ~/.config/borgmcp/cubes.json if stale).\n`
    );
    deps.chdir(candidate);
    deps.stderr(renderWorktreeSteeringNote(candidate, wtBranch, projectRoot));
    spawnedWorktreePath = deps.cwd();
  }

  // ----- Step 8: setActiveCube (narrow rollback — worktree exists if spawned) -----
  try {
    await deps.setActiveCube({
      cubeId: result.cube_id,
      droneId: result.drone_id,
      name: cubeDetail.name,
      droneLabel: result.drone_label,
      apiUrl: auth.apiUrl,
      ...(auth.serverTrustIdentity === undefined
        ? { sessionToken: result.session_token! }
        : {
          serverTrustIdentity: auth.serverTrustIdentity,
          localSessionCredentialRef: result.local_session!.credential_ref,
          localSessionExpiresAt: result.local_session!.expires_at,
        }),
      // gh#899: persist the assimilated role so the connect-time ListTools
      // handler can role-scope the native tool surface.
      roleName: assignedRole.name,
      isHumanSeat: assignedRole.is_human_seat,
      ...(assignedRole.role_class ? { roleClass: assignedRole.role_class } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(`setActiveCube failed: ${message}\n`);
    if (spawnedWorktreePath) {
      const rm = deps.runSync('git', ['worktree', 'remove', '--force', spawnedWorktreePath], projectRoot);
      if (rm.status === 0) {
        deps.stderr(`rolled back spawned worktree at ${spawnedWorktreePath}\n`);
      } else {
        deps.stderr(
          `manual cleanup needed: \`git worktree remove --force ${spawnedWorktreePath}\` ` +
          `(rollback attempt failed: ${safeStderr(rm.stderr).trim() || 'unknown'})\n`
        );
      }
    }
    return 1;
  }

  // The worktree, not a reminted drone UUID, is the stable local seat identity
  // for monitor runtime state. Capture it once before the lazy GC and launch
  // paths so both use the exact same explicit root.
  const agentCwd = deps.cwd(); // post-chdir if step 3 spawned a worktree
  const seatWorktree = deps.findProjectRoot(agentCwd);
  const monitorStateRoot = monitorStateRootForWorktree(seatWorktree);

  // gh#793: best-effort GC of orphaned inbox files (evicted/dead drones) in the
  // cube just joined — lazy-on-assimilate, no cron/new command. NEVER blocks or
  // fails the assimilate (whole call swallowed). Local-only signal (CubeDetail
  // carries no roster → droneState 'absent'; an inbox is reaped only when
  // no-live-holder AND ≥30-day stale). The live-safety gate (raw pgrep tail /
  // fresh heartbeat / live pidfile) vetoes any live holder — a wrong delete is
  // permanent deafness, a missed orphan is harmless.
  try {
    const livenessDeps = defaultInboxLivenessDeps();
    const cubeInboxDir = dirname(inboxPathForDrone(result.cube_id, result.drone_id));
    gcOrphanInboxesForCube({
      cubeInboxDir,
      selfDroneId: result.drone_id,
      deps: {
        listInboxLogs: defaultListInboxLogs,
        isLive: (p) => isInboxLive(p, livenessDeps, monitorStateRoot),
        droneState: () => 'absent',
        unlink: (p) => unlinkSync(p),
        now: livenessDeps.now,
        staleMs: ORPHAN_INBOX_STALE_MS,
      },
      monitorStateRoot,
    });
  } catch {
    /* gh#793: orphan GC is best-effort — never block or fail the assimilate */
  }

  // ----- Step 8: Launch selected agent CLI -----
  // Mirrors the kickoff invocation from claude.ts (no-args path): the agent
  // picks up the newly-persisted ActiveCube via the MCP stdio server on
  // startup. The kickoff prompt re-enters /loop borg_regen so the new
  // drone bootstraps into the cube cleanly. The monitor clause (CR-PE-F1)
  // arms the inbox tail so the new drone wakes on peer log entries in
  // real time — without this, drones miss real-time wake events during
  // the bootstrap window and only self-heal at the /loop heartbeat.
  deps.setTerminalTitle(result.drone_label, cubeDetail.name);

  // Pedagogical hint to stdout before Claude takes over the terminal.
  // Ink does not enter alt-screen-buffer (verified empirically via PTY
  // probe 2026-05-19), so lines printed here remain visible in the
  // user's terminal scrollback above Claude's interactive UI. Color is
  // gated on TTY + NO_COLOR/CI env-var conventions; the welcome shape
  // itself is cube-agnostic so non-default templates render identically.
  const useColor = deps.isTTY() && !process.env.NO_COLOR && !process.env.CI;
  deps.stdout(
    renderAssimilationWelcome(
      result.drone_label,
      assignedRole.name,
      cubeDetail.name,
      useColor,
      authority.kind === 'server' ? authority.apiUrl : undefined,
    ),
  );

  // gh#673 P2 (WI-1): install the project-local SessionStart orientation
  // hook into the launch root — covers BOTH the freshly-spawned sibling
  // worktree (agentCwd = the new worktree post-chdir) and the in-place /
  // --here path. Best-effort: a hook-install failure must never block
  // the assimilate (the bare-`borg` launcher re-ensures it).
  try {
    deps.installProjectSessionHook(agentCwd);
  } catch {
    deps.stderr(`warning: could not install the project-local SessionStart hook in ${agentCwd}; it will be re-attempted on the next borg launch\n`);
  }

  // gh#33 (Q2/Q4/Q6): in-place wt- adoption. A freshly-spawned worktree is
  // already at origin/main on a fresh wt- branch, so only the in-place /
  // --here path (running in an existing checkout) needs handling. ADOPT
  // the per-worktree branch — switch the checkout onto wt-<suffix> at
  // origin/main when clean + merged. This both moves the drone off main
  // (Q4: main is never a working branch) AND brings the branch current,
  // which a bare ff-sync would not do (it would leave a main checkout on
  // main — the gap two-of-four-CR 27af1001 + QA c7a0c615 caught). Dirty ->
  // skip + surface; unmerged HEAD -> block + surface; NEVER discards.
  // Using adoptWorktree (HEAD-merged check + explicit `switch -C wtBranch
  // ref`) also closes one-of-four-CR's compute-name-vs-current-branch NIT.
  // Best-effort: a skip/block surfaces but never blocks the launch.
  if (!spawnedWorktreePath) {
    deps.runSync('git', ['fetch', 'origin', '--prune'], agentCwd);
    const wtBranch = perWorktreeBranchName(basename(agentCwd), basename(projectRoot));
    const adopt = adoptWorktree(deps.runSync, agentCwd, wtBranch, 'origin/main');
    if (adopt.action === 'adopted') {
      deps.stderr(`worktree: adopted branch ${wtBranch} at origin/main\n`);
      deps.stderr(renderInPlaceWorktreeNote(agentCwd, wtBranch));
    } else if (adopt.message) {
      deps.stderr(`worktree sync: ${adopt.message}\n`);
    }
  }

  // BUG-5 / v0.9.3: probe MCP readiness before launching claude so
  // the launched session sees tools at startup. Non-blocking: probe
  // failure surfaces a stderr warning but the launch proceeds (the
  // kickoff text's ToolSearch recovery clause is the second line of
  // defense).
  const mcpReady = await deps.probeMcpReady();
  if (!mcpReady) {
    deps.stderr(
      `warning: borg-mcp readiness probe did not complete within the timeout; ` +
      `launching ${cli} anyway — the kickoff prompt's ToolSearch fallback ` +
      `will recover if the MCP server takes longer to start.\n`
    );
  }
  const inboxPath = deps.getInboxPath(result.cube_id, result.drone_id);
  const codexWakeNonce = cli === 'codex' ? `borg-wake-${randomUUID()}` : null;
  // gh#929: shared wakePathArming + NEVER-TaskStop (unified with claude.ts —
  // the two call sites previously carried divergent monitorClause strings).
  const monitorClause = buildKickoffWakePathClause(
    cli,
    cli === 'claude' ? inboxPath : null,
    cli === 'claude' ? monitorStateRoot : null
  );
  let codexWakePathClause: string | undefined;
  let remoteArgs: string[] = [];
  let launchArgs: string[];
  let codexSocketPath: string | null = null;
  let codexServerCleanup: (() => void) | null = null;
  const launchApproval = deps.resolveCliApprovals
    ? await deps.resolveCliApprovals(cli, agentCwd)
    : { codexArgs: [] };
  if (launchApproval.warning) deps.stderr(`warning: ${launchApproval.warning}\n`);

  // Temporary Claude-only model compatibility. Local/provider models are
  // configured by the selected agent CLI and are never rewritten by Borg.
  const modelEnv = resolveLaunchEnv(effectiveModel);
  const childEnv: Record<string, string> = {
    ...(withAgentRuntimeEnv(process.env, cli) as Record<string, string>),
    ...modelEnv.set,
    BORG_SESSION: '1',
  };
  if (cli === 'opencode' && launchApproval.openCodePermission) {
    childEnv.OPENCODE_PERMISSION = launchApproval.openCodePermission;
  }
  for (const key of modelEnv.unset) {
    delete childEnv[key];
  }

  if (cli === 'codex') {
    const remote = await deps.prepareCodexRemoteLaunch();
    if (remote.warning) {
      deps.stderr(`warning: ${remote.warning}\n`);
      codexWakePathClause =
        `⚠ Codex wake-path capability check failed: remote-control is unavailable for this session. Run borg_regen manually whenever you return, and expect only fallback wakeups until relaunch.`;
    } else {
      codexWakePathClause =
        `Codex wake-path capability check passed: remote-control socket established for this session.`;
    }
    remoteArgs = remote.args;
    // Codex env takes precedence over model env when there is overlap.
    if (Object.keys(remote.env).length > 0) {
      Object.assign(childEnv, remote.env);
    }
    codexSocketPath = socketPathFromRemoteArgs(remote.args);
    codexServerCleanup = remote.server?.cleanup ?? null;
  }
  const kickoff = buildAgentKickoffPrompt({
    cli,
    codexWakeNonce,
    monitorClause,
    codexWakePathClause,
  });
  // Keep Claude and Codex on the unmodified shared kickoff. Only OpenCode
  // receives a nonce-bearing copy so the later MCP connection can identify
  // this exact launch among same-text sessions.
  let openCodeKickoff: ReturnType<typeof createOpenCodeLaunchKickoff> | null = null;
  let dronePort: number | undefined;
  launchArgs = [kickoff];
  if (cli === 'codex') {
    // gh#673 P1-codex: -c overrides deliver BORG_SESSION and the selected
    // CLI identity to the codex-spawned borg-mcp child (inherited env never
    // reaches Codex MCP children — V2/V2b probes). Explicitly pin remote wake
    // off when no socket is available, overriding legacy static configs that
    // formerly used this transport marker as Codex identity.
    launchArgs = [
      ...launchApproval.codexArgs,
      ...codexBorgSessionConfigArgs(),
      ...codexAgentKindConfigArgs(),
      ...codexRemoteWakeConfigArgs(codexSocketPath !== null),
      ...remoteArgs,
      ...withCodexCwdArg(launchArgs, agentCwd),
    ];
  } else if (cli === 'opencode') {
    // OpenCode assimilate launch: start TUI with the kickoff passed via
    // --prompt (auto-submits it as the first message). BORG_SESSION is
    // pinned in opencode.json. A unique port is assigned so the MCP child
    // can connect via the HTTP API for context-streaming (injectOpenCodeEntry).
    dronePort = computeOpenCodePort(result.drone_id);
    installBorgPlugin();
    const cwd = agentCwd;
    openCodeKickoff = createOpenCodeLaunchKickoff(kickoff);
    launchArgs = buildOpenCodeLaunchArgs(cwd, dronePort, openCodeKickoff.prompt);
  }
  // gh#673 P1: mark the launched agent session as borg-launched so the
  // MCP child + hook bins activate (launch-gate.ts). childEnv is the
  // complete child environment (process.env + model.set, minus unset
  // keys, plus BORG_SESSION + codex env). The exec seam must use it
  // directly without re-merging process.env (assimilate-deps.ts).
  const exitPromise = deps.exec(cli, launchArgs, agentCwd, childEnv);
  if (cli === 'codex' && codexSocketPath && codexWakeNonce) {
    void recordCodexWakeTarget({
      deps,
      cubeId: result.cube_id,
      droneId: result.drone_id,
      socketPath: codexSocketPath,
      cwd: agentCwd,
      previewNeedle: codexWakeNonce,
      launchedAtSeconds: Math.floor(Date.now() / 1000),
    });
  }
  // gh#opencode: inject the kickoff prompt into the TUI's first session via
  // the SDK. OpenCode doesn't accept a prompt as a CLI arg, so we do it
  // programmatically once the HTTP server is ready. Best-effort.
  if (cli === 'opencode' && openCodeKickoff) {
    const launchKickoff = openCodeKickoff;
    const serverUrl = `http://127.0.0.1:${dronePort}`;
    connectOpenCodeDrone({
      serverUrl,
      directory: agentCwd,
      droneLabel: result.drone_label,
      cubeName: cubeName ?? 'borg',
    })
      .then(() => injectInitialKickoff(launchKickoff))
      .catch(() => {});
  }
  const exitCode = await exitPromise;
  // gh#528: kill the borg-owned Codex app-server when the assimilate-launched
  // session exits, so it isn't left orphaned (live → not pruned by pid liveness).
  // OpenCode has no app-server to clean up.
  if (codexServerCleanup) {
    try {
      codexServerCleanup();
    } catch {
      // best-effort
    }
  }

  // Sprint 18: when a sibling worktree was spawned, the user's shell
  // returns to their original cwd after Claude exits (process.chdir
  // doesn't propagate to the parent). Emit a stderr hint so they know
  // how to get back into the worktree. shellEscape defangs any shell
  // metachars in the path against paste-injection (drone-11 SR-LANE).
  // Skip the hint when no worktree was spawned (--here / no-worktree
  // flow) or when originalCwd already matches the worktree path
  // (defensive against the no-op edge case drone-9 UX-LANE flagged).
  if (spawnedWorktreePath && originalCwd !== spawnedWorktreePath) {
    deps.stderr(
      `\nAgent exited. You were working in ${spawnedWorktreePath}; your shell is back in ${originalCwd}.\n` +
      `To return:\n` +
      `  cd ${shellEscape(spawnedWorktreePath)}\n`
    );
  }

  return exitCode;
}

function renderWorktreeSteeringNote(worktreePath: string, wtBranch: string, primaryPath: string): string {
  return (
    `\nWORKTREE STEERING: You are in worktree ${worktreePath} on branch ${wtBranch}. ` +
    `Do ALL work HERE — cut your feature branch (fix/.../feat/...) off ${wtBranch} in THIS worktree, ` +
    `use relative paths / your cwd. NEVER \`git -C ${primaryPath}\` or operate on the primary checkout ${primaryPath}: ` +
    `the same branch can't be checked out in two worktrees, so work created in the primary won't reach your wt-branch ` +
    `without manual surgery (cherry-pick/merge).\n`
  );
}

function renderInPlaceWorktreeNote(worktreePath: string, wtBranch: string): string {
  return (
    `\nWORKTREE STEERING: This checkout is now on branch ${wtBranch}. ` +
    `Do ALL work HERE in ${worktreePath} — cut your feature branch (fix/.../feat/...) off ${wtBranch}, ` +
    `use relative paths / your cwd.\n`
  );
}

/**
 * Sprint 4 / gh#147 (drone-8 SR-PE-FINDING-1): strip ASCII control
 * characters before interpolating subprocess stderr into operator-
 * facing messages. Defense-in-depth against a local attacker editing
 * `.git/config` to embed ANSI escapes (e.g. `\x1b[2J` cursor moves,
 * `\x1b]0;...\x07` title injection) — git command stderr then carries
 * them, and unfiltered orchestrator output corrupts the terminal.
 *
 * Strips `[\x00-\x1F\x7F]` (NUL, all C0 controls, DEL). ASCII
 * whitespace inside C0 (tab, newline, CR) gets stripped too — the
 * orchestrator only ever interpolates short status fragments where
 * preserving multi-line layout isn't load-bearing; over-strip
 * trade-off accepted for shape simplicity.
 */
export function safeStderr(msg: string): string {
  return msg.replace(/[\x00-\x1F\x7F]/g, '');
}

function worktreeRegistered(deps: AssimilateDeps, projectRoot: string, candidate: string): boolean {
  const res = deps.runSync('git', ['worktree', 'list', '--porcelain'], projectRoot);
  if (res.status !== 0) return false;
  return res.stdout.split('\n').some((line) => line === `worktree ${candidate}`);
}

/**
 * Sprint 19 (gh#184): suggest the closest cube-role name for a misspelled
 * CLI role argument. Levenshtein distance ≤2 against the cube's role
 * names; case-insensitive. Returns null when no close match exists.
 *
 * Serves Queen's "more user-friendly" intent without violating the
 * Borg-collective metaphor (collective defines roles; drones slot in).
 * The original strict-failure semantic is preserved; the suggestion
 * is an additive nudge in the error message, not a fallback path.
 */
export function suggestRoleName(input: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const inputLower = input.toLowerCase();
  let best: { name: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = levenshtein(inputLower, candidate.toLowerCase());
    if (distance <= 2 && (best === null || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best ? best.name : null;
}

/**
 * Minimal Levenshtein distance implementation. Used only by
 * `suggestRoleName` for the fuzzy-match nudge; intentionally
 * unexported and not a general-purpose helper.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
