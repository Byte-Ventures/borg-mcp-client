import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import {
  getProjectCliPreferenceForPath,
  readAllProjectIdentities,
  withLaunchSeatExpectationEnv,
  type ActiveCube,
  type BorgCli,
  type LaunchSeatExpectation,
} from './cubes.js';
import { resolveBorgPath } from './launch-all-command.js';
import { getActiveSeatForWorktree, readAllBoundSeats, seatRef, type SeatRecord } from './seats.js';

export type LocalSeatState = 'active' | 'pending';

export interface LocalSeatRow {
  droneLabel: string;
  droneId: string;
  cubeName: string;
  cubeId: string;
  worktree: string;
  canonicalWorktree: string | null;
  credentialRef: string;
  cli: BorgCli | null;
  state: LocalSeatState;
}

export interface SeatCommandDeps {
  readAllProjectIdentities: () => Promise<Array<{ projectPath: string; cube: ActiveCube }>>;
  readAllBoundSeats: () => Promise<Array<{ worktree: string; record: SeatRecord }>>;
  getActiveSeatForWorktree: (worktree: string) => Promise<SeatRecord | null>;
  getProjectCliPreference: (worktree: string) => Promise<BorgCli | null>;
  pathExists: (path: string) => boolean;
  realpath: (path: string) => string;
  /** Run this same borg executable with no args from the selected worktree,
   * carrying only the expected durable identity for child-side verification. */
  launchBareBorg: (worktree: string, expectation: LaunchSeatExpectation) => Promise<number>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export type ParsedSeatsArgs = { ok: true } | { ok: false; error: string };

export function parseSeatsArgs(args: readonly string[]): ParsedSeatsArgs {
  return args.length === 0
    ? { ok: true }
    : { ok: false, error: 'takes no arguments' };
}

export type ParsedLaunchSeatArgs =
  | { ok: true; target: string; cube?: string }
  | { ok: false; error: string };

export function parseLaunchSeatArgs(args: readonly string[]): ParsedLaunchSeatArgs {
  let target: string | undefined;
  let cube: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cube') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        return { ok: false, error: '--cube requires a cube name' };
      }
      cube = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--cube=')) {
      const value = arg.slice('--cube='.length);
      if (!value) return { ok: false, error: '--cube requires a cube name' };
      cube = value;
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, error: `unknown option: ${arg}` };
    if (target !== undefined) {
      return { ok: false, error: 'accepts exactly one drone label or id prefix' };
    }
    target = arg;
  }

  if (!target) return { ok: false, error: 'requires a drone label or id prefix' };
  return { ok: true, target, ...(cube ? { cube } : {}) };
}

function safeRealpath(deps: SeatCommandDeps, path: string): string | null {
  try {
    return deps.realpath(path);
  } catch {
    return null;
  }
}

function seatKey(cubeId: string, droneId: string): string {
  return `${cubeId}\0${droneId}`;
}

export async function readLocalSeatRows(deps: SeatCommandDeps): Promise<LocalSeatRow[]> {
  const [identities, boundSeats] = await Promise.all([
    deps.readAllProjectIdentities(),
    deps.readAllBoundSeats(),
  ]);
  const identityBySeat = new Map(
    identities.map((entry) => [seatKey(entry.cube.cubeId, entry.cube.droneId), entry]),
  );
  const identityByRealpath = new Map<string, { projectPath: string; cube: ActiveCube }>();
  for (const entry of identities) {
    const canonical = safeRealpath(deps, entry.projectPath);
    if (canonical) identityByRealpath.set(canonical, entry);
  }

  const rows = await Promise.all(boundSeats.map(async ({ worktree, record }) => {
    const exists = deps.pathExists(worktree);
    const canonicalWorktree = exists ? safeRealpath(deps, worktree) : null;
    const identity = (record.droneId ? identityBySeat.get(seatKey(record.cubeId, record.droneId)) : undefined)
      ?? (canonicalWorktree ? identityByRealpath.get(canonicalWorktree) : undefined);
    const cube = identity?.cube;
    const launchPath = identity?.projectPath ?? worktree;
    const launchCanonical = deps.pathExists(launchPath) ? safeRealpath(deps, launchPath) : null;
    return {
      droneLabel: cube?.droneLabel ?? record.droneLabel ?? '<unknown>',
      droneId: cube?.droneId ?? record.droneId ?? '',
      cubeName: cube?.name ?? record.name ?? '<unknown>',
      cubeId: cube?.cubeId ?? record.cubeId,
      worktree: launchPath,
      canonicalWorktree: launchCanonical,
      credentialRef: seatRef(record),
      cli: await deps.getProjectCliPreference(launchPath),
      state: record.state,
    };
  }));

  return rows.sort((a, b) =>
    a.droneLabel.localeCompare(b.droneLabel)
      || a.cubeName.localeCompare(b.cubeName)
      || a.worktree.localeCompare(b.worktree)
  );
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ');
}

export function formatLocalSeatRows(rows: readonly LocalSeatRow[]): string {
  if (rows.length === 0) {
    return 'No drone seats are registered on this machine. Run `borg assimilate` in a project repository to create one.\n';
  }
  const headings = ['DRONE', 'CUBE', 'STATE', 'CLI', 'WORKTREE'];
  const values = rows.map((row) => [
    oneLine(row.droneLabel),
    oneLine(row.cubeName),
    row.state,
    row.cli ?? '-',
    oneLine(row.worktree),
  ]);
  const widths = headings.slice(0, -1).map((heading, index) =>
    Math.max(heading.length, ...values.map((row) => row[index].length))
  );
  const render = (row: string[]) =>
    row.slice(0, -1).map((value, index) => value.padEnd(widths[index] + 2)).join('') + row[row.length - 1];
  return `${render(headings)}\n${values.map(render).join('\n')}\n`;
}

function formatAmbiguousMatches(rows: readonly LocalSeatRow[]): string {
  const labels = rows.map((row) => row.droneLabel);
  const cubes = rows.map((row) => row.cubeName);
  const labelWidth = Math.max(...labels.map((label) => label.length));
  const cubeWidth = Math.max(...cubes.map((cube) => cube.length));
  return rows.map((row) =>
    `  ${row.droneLabel.padEnd(labelWidth + 2)}${row.cubeName.padEnd(cubeWidth + 2)}id:${row.droneId.slice(0, 8)}`
  ).join('\n');
}

export async function runSeats(deps: SeatCommandDeps): Promise<number> {
  try {
    deps.stdout(formatLocalSeatRows(await readLocalSeatRows(deps)));
    return 0;
  } catch (error) {
    deps.stderr(`borg seats: could not read the local registry: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runLaunchSeat(
  args: { target: string; cube?: string },
  deps: SeatCommandDeps,
): Promise<number> {
  let rows: LocalSeatRow[];
  try {
    rows = await readLocalSeatRows(deps);
  } catch (error) {
    deps.stderr(`borg launch: could not read the local registry: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (args.cube) {
    const cubeIds = new Set(rows.filter((row) => row.cubeName === args.cube).map((row) => row.cubeId));
    if (cubeIds.size === 0) {
      deps.stderr(`borg launch: no drone matches '${args.target}' on this machine. Run \`borg seats\` to list the drones you can launch.\n`);
      return 1;
    }
    rows = rows.filter((row) => cubeIds.has(row.cubeId));
  }

  const labelMatches = rows.filter((row) => row.droneLabel === args.target);
  const matches = labelMatches.length > 0
    ? labelMatches
    : rows.filter((row) => row.droneId.toLowerCase().startsWith(args.target.toLowerCase()));
  if (matches.length === 0) {
    if (rows.length === 0) {
      deps.stderr(
        `borg launch: drone '${args.target}' is not in this machine's seat registry. ` +
        `The registry is local to each machine and lists only drones assimilated here. ` +
        `Run \`borg seats\` on the machine where the drone was created.\n`,
      );
    } else {
      deps.stderr(
        `borg launch: no drone matches '${args.target}' on this machine. ` +
        `Run \`borg seats\` to list the drones you can launch.\n`,
      );
    }
    return 1;
  }
  if (matches.length > 1) {
    deps.stderr(
      `borg launch: '${args.target}' matches ${matches.length} drones:\n` +
      `${formatAmbiguousMatches(matches)}\n` +
      `Add --cube <name>, or use the drone id prefix: borg launch ${matches[0].droneId.slice(0, 8)}.\n`,
    );
    return 1;
  }

  const selected = matches[0];
  if (!selected.canonicalWorktree) {
    deps.stderr(
      `borg launch: drone '${selected.droneLabel}' is registered at ${selected.worktree}, but that directory does not exist. ` +
      `Restore the directory, or run \`borg cleanup\` to review orphaned worktrees.\n`,
    );
    return 1;
  }
  if (selected.state !== 'active') {
    deps.stderr(
      `borg launch: drone '${selected.droneLabel}' has a pending seat (shown as \`pending\` in \`borg seats\`) — ` +
      `its assimilation did not complete, so launching now would start an unattached session. ` +
      `To complete the seat, run \`borg assimilate\` in ${selected.worktree}, then run ` +
      `\`borg launch ${selected.droneLabel}\` again.\n`,
    );
    return 1;
  }

  let preferred: SeatRecord | null;
  try {
    preferred = await deps.getActiveSeatForWorktree(selected.canonicalWorktree);
  } catch {
    preferred = null;
  }
  if (!preferred) {
    deps.stderr(
      `borg launch: did not launch '${selected.droneLabel}' — its seat registration changed before the launch could start. ` +
      `Run \`borg seats\` to see the current state, then try again.\n`,
    );
    return 1;
  }
  if (
    seatRef(preferred) !== selected.credentialRef ||
    preferred.cubeId !== selected.cubeId ||
    preferred.droneId !== selected.droneId
  ) {
    deps.stderr(
      `borg launch: did not launch '${selected.droneLabel}' — the worktree at ${selected.worktree} would resume ` +
      `'${preferred.droneLabel}' (cube '${preferred.name}') instead. To resume '${preferred.droneLabel}', run \`borg\` ` +
      `in that worktree. To review this machine's seats, run \`borg seats\`.\n`,
    );
    return 1;
  }

  const expectation: LaunchSeatExpectation = {
    credentialRef: selected.credentialRef,
    cubeId: selected.cubeId,
    droneId: selected.droneId,
    worktree: selected.canonicalWorktree,
    droneLabel: selected.droneLabel,
  };

  try {
    return await deps.launchBareBorg(selected.canonicalWorktree, expectation);
  } catch (error) {
    deps.stderr(`borg launch: failed to start borg in ${selected.canonicalWorktree}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function buildDefaultSeatCommandDeps(): SeatCommandDeps {
  return {
    readAllProjectIdentities,
    readAllBoundSeats,
    getActiveSeatForWorktree,
    getProjectCliPreference: getProjectCliPreferenceForPath,
    pathExists: existsSync,
    realpath: realpathSync,
    launchBareBorg: (worktree, expectation) => new Promise((resolve, reject) => {
      const child = spawn(resolveBorgPath(), [], {
        cwd: worktree,
        stdio: 'inherit',
        shell: false,
        env: withLaunchSeatExpectationEnv(process.env, expectation),
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    }),
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  };
}
