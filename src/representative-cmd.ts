/**
 * `borg representative <prepare|status|mcp>` — operator entry for the human
 * representative ("Hermes") connection.
 *
 * prepare  binds ONE dedicated non-human-seat drone in this repository's cube
 *          to ONE explicitly named Coordinator drone. It creates/resumes the
 *          seat through the launch-free assimilate seam: no agent CLI starts
 *          and no existing drone's identity is touched.
 * status   shows the saved binding and re-checks it against the live cube.
 * mcp      serves the restricted stdio MCP facade for a generic MCP host.
 *
 * No command accepts a credential: the seat bearer stays in the private seat
 * store and is hydrated in-process only.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ActiveCube } from './cubes.js';
import { normalizeServerEndpoint } from './server-endpoint.js';
import { validateName } from './name-validator.js';
import {
  RepresentativeError,
  assertRepresentativeRole,
  representativeStatus,
  resolveCoordinator,
  type RepresentativeBackend,
  type RepresentativeContext,
} from './representative-core.js';
import {
  RepresentativeStoreError,
  representativeRecoveryCommand,
  type RepresentativeBinding,
  type RepresentativeStore,
} from './representative-store.js';

import { shellEscape } from './shell-escape.js';

export const DEFAULT_REPRESENTATIVE_ROLE = 'hermes-representative';

export type RepresentativeCommand =
  | { action: 'prepare'; coordinator: string; role: string; rebind: boolean; worktreeName?: string; host?: string }
  | { action: 'status'; worktree?: string }
  | { action: 'mcp'; worktree?: string };

export type ParsedRepresentativeArgs =
  | { ok: true; command: RepresentativeCommand }
  | { ok: false; error: string };

export interface RepresentativeCmdDeps {
  cwd(): string;
  findProjectRoot(dir: string): string;
  /** Hydrates the saved seat bound to exactly this worktree, or null. */
  hydrateSeat(worktree: string): Promise<ActiveCube | null>;
  /** Launch-free seat creation/resume; never starts an agent CLI. */
  prepareSeat(input: { role: string; coordinator?: string; worktreeName?: string; host?: string; resume?: boolean }): Promise<{ code: number; worktree?: string }>;
  backendFor(active: ActiveCube): RepresentativeBackend | Promise<RepresentativeBackend>;
  store: RepresentativeStore;
  stdout(text: string): void;
  stderr(text: string): void;
}

export function parseRepresentativeArgs(args: readonly string[]): ParsedRepresentativeArgs {
  const [action, ...rest] = args;
  if (action !== 'prepare' && action !== 'status' && action !== 'mcp') {
    return { ok: false, error: 'expected one of: prepare, status, mcp' };
  }
  const values: Record<string, string> = {};
  let rebind = false;
  const valueFlags = action === 'prepare' ? ['--coordinator', '--role', '--worktree', '--host'] : ['--worktree'];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (action === 'prepare' && arg === '--rebind') {
      rebind = true;
    } else if (valueFlags.includes(arg)) {
      const next = rest[i + 1];
      if (typeof next !== 'string' || next.length === 0 || next.startsWith('-')) {
        return { ok: false, error: `${arg} requires a value` };
      }
      values[arg] = next;
      i += 1;
    } else {
      return {
        ok: false,
        error: `unknown argument: ${arg}. Supported: ${[...valueFlags, ...(action === 'prepare' ? ['--rebind'] : [])].join(', ')}`,
      };
    }
  }
  if (action !== 'prepare') {
    const worktree = values['--worktree'];
    if (worktree !== undefined && !isAbsolute(worktree)) {
      return { ok: false, error: '--worktree must be an absolute path to the representative worktree' };
    }
    return { ok: true, command: { action, ...(worktree ? { worktree } : {}) } };
  }
  const coordinator = values['--coordinator'];
  if (!coordinator) {
    return {
      ok: false,
      error: '--coordinator <drone-label> is required: name the exact Coordinator drone (see `borg drones`). It is never chosen for you.',
    };
  }
  const role = values['--role'] ?? DEFAULT_REPRESENTATIVE_ROLE;
  if (!validateName(role).ok) return { ok: false, error: '--role must be a valid role name' };
  if (values['--worktree'] !== undefined && !validateName(values['--worktree']).ok) {
    return { ok: false, error: '--worktree for prepare is a new worktree NAME (as in `borg assimilate --worktree`), not a path' };
  }
  return {
    ok: true,
    command: {
      action,
      coordinator,
      role,
      rebind,
      ...(values['--worktree'] ? { worktreeName: values['--worktree'] } : {}),
      ...(values['--host'] ? { host: values['--host'] } : {}),
    },
  };
}

function canonicalWorktree(path: string, deps: Pick<RepresentativeCmdDeps, 'findProjectRoot'>): string {
  let real = resolve(path);
  try {
    real = realpathSync(real);
  } catch {
    /* a missing path simply finds no binding below */
  }
  return deps.findProjectRoot(real);
}

function describeError(error: unknown): string {
  if (error instanceof RepresentativeError || error instanceof RepresentativeStoreError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function sameSeat(binding: RepresentativeBinding, active: ActiveCube): boolean {
  return active.cubeId === binding.cubeId &&
    active.droneId === binding.representativeDroneId &&
    active.apiUrl === binding.origin &&
    active.serverTrustIdentity === binding.trustIdentity;
}

/** Load the saved binding and prove the worktree's hydrated seat is still that exact seat. Fails closed. */
export async function resolveRepresentativeContext(
  worktree: string,
  deps: Pick<RepresentativeCmdDeps, 'hydrateSeat' | 'backendFor' | 'store'>,
): Promise<RepresentativeContext> {
  const binding = await deps.store.getBinding(worktree);
  if (!binding) {
    throw new RepresentativeError(
      'NOT_PREPARED',
      `No representative connection is prepared for ${worktree}. Run \`borg representative prepare --coordinator <drone-label>\` there first.`,
    );
  }
  const active = await deps.hydrateSeat(worktree);
  if (!active) {
    throw new RepresentativeError(
      'SEAT_UNAVAILABLE',
      `The saved representative connection is missing, reset or rejected. Run \`${representativeRecoveryCommand(binding)}\`.`,
    );
  }
  if (!sameSeat(binding, active)) {
    throw new RepresentativeError(
      'BINDING_MISMATCH',
      `This worktree's saved connection is not the bound server/cube/drone. Run \`${representativeRecoveryCommand(binding)}\` to confirm a rebind; nothing is sent until then.`,
    );
  }
  return { binding, backend: await deps.backendFor(active), store: deps.store };
}

export function hermesConfigSnippet(worktree: string): string {
  return (
    `mcp_servers:\n` +
    `  borg-representative:\n` +
    `    command: borg\n` +
    `    args: ["representative", "mcp", "--worktree", ${JSON.stringify(worktree)}]\n`
  );
}

export async function runRepresentativePrepare(
  command: Extract<RepresentativeCommand, { action: 'prepare' }>,
  deps: RepresentativeCmdDeps,
): Promise<number> {
  try {
    // Same canonical key as status/mcp, so a symlinked cwd cannot bind under a path they never look up.
    let worktree = canonicalWorktree(deps.cwd(), deps);
    const existing = command.worktreeName === undefined ? await deps.hydrateSeat(worktree) : null;
    if (existing && command.host && normalizeServerEndpoint(command.host) !== normalizeServerEndpoint(existing.apiUrl)) {
      throw new RepresentativeError('BINDING_MISMATCH', 'The explicit --host does not match this worktree\'s saved connection. Use a worktree connected to the requested server; nothing was rebound.');
    }
    const prepared = await deps.prepareSeat({
      role: command.role,
      coordinator: command.coordinator,
      ...(existing ? { resume: true } : {}),
      ...(command.worktreeName ? { worktreeName: command.worktreeName } : {}),
      ...(command.host ? { host: command.host } : {}),
    });
    if (prepared.code !== 0) {
      deps.stderr('borg representative: the representative connection could not be prepared; nothing was bound.\n');
      return prepared.code || 1;
    }
    if (prepared.worktree) worktree = canonicalWorktree(prepared.worktree, deps);
    const active = await deps.hydrateSeat(worktree);
    if (!active || !active.serverTrustIdentity) {
      throw new RepresentativeError('SEAT_UNAVAILABLE', `No usable saved connection was found for ${worktree}.`);
    }
    const backend = await deps.backendFor(active);
    const me = await backend.whoami();
    if (me.cube_id !== active.cubeId || me.drone_id !== active.droneId) {
      throw new RepresentativeError('BINDING_MISMATCH', 'The server does not recognise this worktree\'s saved connection.');
    }
    const roster = await backend.roster();
    const self = roster.drones.find((drone) => drone.id === me.drone_id);
    const selfRole = roster.roles.find((role) => role.id === self?.role_id);
    if (!self || !selfRole) throw new RepresentativeError('SEAT_UNAVAILABLE', 'The representative drone is not active in the cube.');
    assertRepresentativeRole(selfRole, self);
    if (selfRole.name.toLowerCase() !== command.role.toLowerCase()) {
      throw new RepresentativeError(
        'REPRESENTATIVE_ROLE_MISMATCH',
        `This worktree's drone ${self.label} holds role ${JSON.stringify(selfRole.name)}, not ${JSON.stringify(command.role)}. ` +
          'The representative needs its own dedicated drone. Use the preparation syntax in `borg representative --help` with an explicit Coordinator and the intended role or new worktree name.',
      );
    }
    const coordinator = resolveCoordinator(roster, { label: command.coordinator, selfDroneId: me.drone_id });
    const binding: RepresentativeBinding = {
      worktree,
      origin: active.apiUrl,
      trustIdentity: active.serverTrustIdentity,
      cubeId: me.cube_id,
      cubeName: me.cube_name,
      representativeDroneId: me.drone_id,
      representativeLabel: me.drone_label,
      representativeRoleName: selfRole.name,
      coordinatorDroneId: coordinator.drone.id,
      coordinatorLabel: coordinator.drone.label,
      coordinatorRoleName: coordinator.role.name,
      ...(active.repositoryOrigin ? { repositoryOrigin: active.repositoryOrigin } : {}),
      boundAt: new Date().toISOString(),
    };
    const outcome = await deps.store.saveBinding(binding, { rebind: command.rebind });
    deps.stdout(
      `◼ Human representative connection ${outcome === 'unchanged' ? 'resumed' : outcome}.\n` +
      `  cube:            ${binding.cubeName} (${binding.cubeId})\n` +
      `  representative:  ${binding.representativeLabel} — role ${binding.representativeRoleName} (not a human seat)\n` +
      `  coordinator:     ${binding.coordinatorLabel} — role ${binding.coordinatorRoleName} (human seat)\n` +
      `  worktree:        ${worktree}\n\n` +
      `No agent CLI was launched. Serve it to a generic MCP host with:\n` +
      `  borg representative mcp --worktree ${worktree}\n\n` +
      `Example host configuration (no secrets belong here):\n${hermesConfigSnippet(worktree)}`,
    );
    return 0;
  } catch (error) {
    deps.stderr(`◼ borg representative prepare: ${describeError(error)}\n`);
    return 1;
  }
}

export async function runRepresentativeStatus(
  command: Extract<RepresentativeCommand, { action: 'status' }>,
  deps: RepresentativeCmdDeps,
): Promise<number> {
  try {
    const worktree = canonicalWorktree(command.worktree ?? deps.cwd(), deps);
    const status = await representativeStatus(await resolveRepresentativeContext(worktree, deps));
    deps.stdout(`${JSON.stringify(status, null, 2)}\n`);
    return status.connected ? 0 : 1;
  } catch (error) {
    deps.stderr(`◼ borg representative status: ${describeError(error)}\n`);
    return 1;
  }
}

/**
 * Serve the stdio facade. The binding selection is captured at startup; a later
 * operator rebind is NOT picked up by a running process — calls fail closed
 * until the host restarts it.
 */
export async function runRepresentativeMcp(
  command: Extract<RepresentativeCommand, { action: 'mcp' }>,
  deps: RepresentativeCmdDeps,
  io: { version: string; pinSeat?: (active: ActiveCube) => void; stdin?: Readable; stdout?: Writable },
): Promise<number> {
  let worktree: string;
  let pinned: RepresentativeBinding;
  try {
    worktree = canonicalWorktree(command.worktree ?? deps.cwd(), deps);
    pinned = (await resolveRepresentativeContext(worktree, deps)).binding;
    const active = await deps.hydrateSeat(worktree);
    if (active) io.pinSeat?.(active);
  } catch (error) {
    // stdout is reserved for JSON-RPC frames; refuse to start on stderr only.
    deps.stderr(`◼ borg representative mcp: ${describeError(error)}\n`);
    return 1;
  }
  const { serveRepresentativeMcp } = await import('./representative-mcp.js');
  const served = await serveRepresentativeMcp({
    version: io.version,
    ...(io.stdin ? { stdin: io.stdin } : {}),
    ...(io.stdout ? { stdout: io.stdout } : {}),
    context: async () => {
      const ctx = await resolveRepresentativeContext(worktree, deps);
      if (
        ctx.binding.cubeId !== pinned.cubeId ||
        ctx.binding.coordinatorDroneId !== pinned.coordinatorDroneId ||
        ctx.binding.representativeDroneId !== pinned.representativeDroneId
      ) {
        throw new RepresentativeError(
          'BINDING_MISMATCH',
          'The operator changed this connection\'s cube or Coordinator while it was running. Restart the MCP server to use the new binding.',
        );
      }
      return ctx;
    },
  });
  const stdin = io.stdin ?? process.stdin;
  stdin.once('end', () => { void served.close(); });
  await served.closed;
  return 0;
}

export async function buildDefaultRepresentativeDeps(): Promise<RepresentativeCmdDeps> {
  const [{ findProjectRoot, getActiveCubeForWorktree }, { createSeatBackend }, { createRepresentativeStore }] =
    await Promise.all([
      import('./cubes.js'),
      import('./representative-core.js'),
      import('./representative-store.js'),
    ]);
  return {
    cwd: () => process.cwd(),
    findProjectRoot,
    hydrateSeat: (worktree) => getActiveCubeForWorktree(worktree),
    prepareSeat: async ({ role, coordinator, worktreeName, host, resume }) => {
      const [{ prepareConnection }, { buildDefaultAssimilateDeps }] = await Promise.all([
        import('./assimilate-cmd.js'),
        import('./assimilate-deps.js'),
      ]);
      let worktree: string | undefined;
      const code = await prepareConnection(
        { role, flags: { ...(resume ? { here: true } : {}), ...(worktreeName ? { worktree: worktreeName } : {}), ...(host ? { server: host } : {}) } },
        buildDefaultAssimilateDeps(),
        {
          validateRole: assertRepresentativeRole,
          onPrepared: (prepared) => { worktree = prepared.worktree; },
          authoritySelectionCommand: 'borg representative prepare --host <host>' +
            (coordinator ? ` --coordinator ${shellEscape(coordinator)}` : '') +
            ` --role ${shellEscape(role)}` +
            (worktreeName ? ` --worktree ${shellEscape(worktreeName)}` : ''),
        },
      );
      return { code, ...(worktree ? { worktree } : {}) };
    },
    backendFor: createSeatBackend,
    store: createRepresentativeStore(),
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  };
}
