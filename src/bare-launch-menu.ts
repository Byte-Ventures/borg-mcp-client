/**
 * gh#853 — bare `borg` (no-args) interactive launch menu.
 *
 * When `borg` is run with NO arguments in a TTY outside an active seat, offer
 * a small launch selector. In a repository with live sibling drones, those
 * drones come first; otherwise the existing agent choices remain unchanged.
 *
 * The option-set, the selection→action mapping, and the show/collapse decision
 * are pure functions so they're unit-testable without a real TTY. claude.ts
 * main() is thin glue: it computes the available candidates and agent choices,
 * gates on shouldShowLaunchMenu, runs the orchestrator with the real readline
 * prompt, then dispatches the returned action.
 *
 * Load-bearing safety: TTY-only + bare-args-only + no-active-seat
 * (shouldShowLaunchMenu), so scripted/programmatic invocations and direct
 * worktree resumes are untouched.
 */
import type { ActiveCube, BorgCli } from './cubes.js';
import type { DroneCandidate } from './launch-all-discovery.js';
import type { SeatStatus } from './seat-probe.js';

export type LaunchMenuAction =
  | { kind: 'launch'; cli: BorgCli }
  | { kind: 'launch-seat'; target: string }
  | { kind: 'launch-all'; cubeId?: string };

export interface LaunchMenuDroneCandidate {
  droneLabel: string;
  target: string;
  worktree: string;
}

export interface LaunchMenuOption {
  /** The keystroke that selects this option (sequential: '1', '2', …). */
  key: string;
  label: string;
  action: LaunchMenuAction;
}

export interface LaunchMenuInputs {
  /** The configured/resolved current agent (option 1). */
  defaultCli: BorgCli;
  /** All configured agents that are NOT the default, in display order. */
  otherConfiguredClis: BorgCli[];
  /** True iff the current menu context has launch-all targets. */
  hasLaunchAllTargets: boolean;
  /** Live sibling drones offered before the unattached launch choices. */
  droneCandidates?: LaunchMenuDroneCandidate[];
  /** Cube selected by the sibling-drone context for its launch-all action. */
  launchAllCubeId?: string;
}

interface LaunchMenuCandidateDeps {
  readAllProjectIdentities: () => Promise<Array<{ projectPath: string; cube: ActiveCube }>>;
  discoverDroneCandidates: (cubeId: string) => Promise<DroneCandidate[]>;
  getActiveSeatForWorktree: (
    worktree: string,
  ) => Promise<{ cubeId: string; droneId?: string } | null>;
  pathExists: (worktree: string) => boolean;
  probeSeat: (candidate: DroneCandidate) => Promise<SeatStatus>;
}

const TERMINAL_SEAT_STATUSES = new Set<SeatStatus>([
  'evicted',
  'revoked',
  'rejected',
  'credential-rejected',
  'trust-mismatch',
]);

/**
 * Find linked sibling worktrees that still own their preferred active seat.
 * Authoritative terminal probe results are omitted; transient/unknown probe
 * results stay visible, matching launch-all's constructive fail-open behavior.
 */
export async function discoverLiveLaunchMenuCandidates(
  deps: LaunchMenuCandidateDeps,
): Promise<{ candidates: LaunchMenuDroneCandidate[]; launchAllCubeId?: string }> {
  const identities = await deps.readAllProjectIdentities();
  const cubeIds = [...new Set(identities.map(({ cube }) => cube.cubeId))];
  const discovered = (
    await Promise.all(cubeIds.map((cubeId) => deps.discoverDroneCandidates(cubeId)))
  ).flat();

  const candidates: Array<LaunchMenuDroneCandidate & { cubeId: string }> = [];
  const seen = new Set<string>();
  for (const candidate of discovered) {
    if (!deps.pathExists(candidate.worktreeDir)) continue;
    const preferred = await deps.getActiveSeatForWorktree(candidate.worktreeDir);
    if (
      !preferred ||
      preferred.cubeId !== candidate.cubeId ||
      preferred.droneId !== candidate.droneId
    ) continue;

    let status: SeatStatus;
    try {
      status = await deps.probeSeat(candidate);
    } catch {
      status = 'indeterminate';
    }
    if (TERMINAL_SEAT_STATUSES.has(status)) continue;

    const key = `${candidate.cubeId}\0${candidate.droneId}\0${candidate.worktreeDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      cubeId: candidate.cubeId,
      droneLabel: candidate.droneLabel,
      target: candidate.droneId,
      worktree: candidate.worktreeDir,
    });
  }

  candidates.sort((a, b) =>
    a.droneLabel.localeCompare(b.droneLabel) || a.worktree.localeCompare(b.worktree)
  );
  const candidateCubeIds = new Set(candidates.map((candidate) => candidate.cubeId));
  const launchAllCubeId = candidateCubeIds.size === 1
    ? candidates[0].cubeId
    : undefined;
  return {
    candidates: candidates.map(({ cubeId: _cubeId, ...candidate }) => candidate),
    ...(launchAllCubeId ? { launchAllCubeId } : {}),
  };
}

/**
 * Resolve and configure the CLI that will actually launch.
 *
 * This callback deliberately runs after the one-shot menu choice. A bare
 * launch may resolve one default CLI first and then launch a different
 * configured CLI for this invocation; only the final CLI may be self-healed.
 */
export function configureSelectedLaunchCli(
  defaultCli: BorgCli,
  action: LaunchMenuAction | undefined,
  configure: (cli: BorgCli) => void,
): BorgCli {
  const cli = action?.kind === 'launch' ? action.cli : defaultCli;
  configure(cli);
  return cli;
}

const PRETTY: Record<BorgCli, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

/**
 * Gate: the menu fires ONLY for bare `borg` (no args) in a TTY without an
 * active seat. Explicit invocations, non-TTY launches, and direct worktree
 * resumes fall straight through to the existing launch path.
 */
export function shouldShowLaunchMenu(args: {
  extraArgs: string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  hasActiveSeat?: boolean;
}): boolean {
  return args.extraArgs.length === 0
    && args.stdinIsTTY
    && args.stdoutIsTTY
    && !args.hasActiveSeat;
}

export function explicitCliLaunchHint(args: {
  explicitCli: BorgCli | undefined;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  hasActiveCube: boolean;
  hasLaunchAllTargets: boolean;
}): string | null {
  if (!args.explicitCli || !args.stdinIsTTY || !args.stdoutIsTTY) return null;
  if (!args.hasActiveCube || !args.hasLaunchAllTargets) return null;
  return `borg --cli ${args.explicitCli} launches ${PRETTY[args.explicitCli]} directly; use bare borg for the launch menu or borg launch-all --cli ${args.explicitCli} for all drone worktrees.\n`;
}

export function shouldResolveExplicitCliLaunchHintTargets(args: {
  explicitCli: BorgCli | undefined;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  hasActiveCube: boolean;
}): boolean {
  return Boolean(args.explicitCli && args.stdinIsTTY && args.stdoutIsTTY && args.hasActiveCube);
}

/**
 * The context-filtered option set. Option 1 is always present; options 2/3 are
 * included only when applicable. Keys are sequential with no gaps, so a hidden
 * middle option never produces a "1) … 3) …" gap menu.
 */
export function buildLaunchMenuOptions(inputs: LaunchMenuInputs): LaunchMenuOption[] {
  if (inputs.droneCandidates && inputs.droneCandidates.length > 0) {
    const options: LaunchMenuOption[] = [...inputs.droneCandidates]
      .sort((a, b) => a.droneLabel.localeCompare(b.droneLabel) || a.worktree.localeCompare(b.worktree))
      .map((candidate, index) => ({
        key: String(index + 1),
        label: `Resume ${candidate.droneLabel} (${candidate.worktree})`,
        action: { kind: 'launch-seat' as const, target: candidate.target },
      }));
    if (inputs.hasLaunchAllTargets) {
      options.push({
        key: String(options.length + 1),
        label: "Launch all (this cube's drone worktrees)",
        action: {
          kind: 'launch-all',
          ...(inputs.launchAllCubeId ? { cubeId: inputs.launchAllCubeId } : {}),
        },
      });
    }
    options.push({
      key: String(options.length + 1),
      label: `Launch ${PRETTY[inputs.defaultCli]} here without a drone`,
      action: { kind: 'launch', cli: inputs.defaultCli },
    });
    for (const cli of inputs.otherConfiguredClis) {
      options.push({
        key: String(options.length + 1),
        label: `Launch with ${PRETTY[cli]} here without a drone (one-shot)`,
        action: { kind: 'launch', cli },
      });
    }
    return options;
  }

  const options: LaunchMenuOption[] = [
    {
      key: '1',
      label: `Launch (default · ${PRETTY[inputs.defaultCli]})`,
      action: { kind: 'launch', cli: inputs.defaultCli },
    },
  ];
  for (const cli of inputs.otherConfiguredClis) {
    options.push({
      key: String(options.length + 1),
      label: `Launch with ${PRETTY[cli]} (one-shot)`,
      action: { kind: 'launch', cli },
    });
  }
  if (inputs.hasLaunchAllTargets) {
    options.push({
      key: String(options.length + 1),
      label: "Launch all (this cube's drone worktrees)",
      action: { kind: 'launch-all' },
    });
  }
  return options;
}

/** Map a raw prompt answer to an action. Empty/Enter → option 1 (default). */
export function resolveLaunchMenuChoice(
  options: LaunchMenuOption[],
  rawInput: string
): { ok: true; action: LaunchMenuAction } | { ok: false } {
  const trimmed = rawInput.trim();
  if (trimmed === '') return { ok: true, action: options[0].action };
  const match = options.find((o) => o.key === trimmed);
  return match ? { ok: true, action: match.action } : { ok: false };
}

/** The rendered menu text (prompt suffix `[1]:` defaults to option 1 on Enter). */
export function renderLaunchMenu(options: LaunchMenuOption[]): string {
  const lines = options.map((o) => `  ${o.key}) ${o.label}`);
  return `borg — how do you want to launch?\n${lines.join('\n')}\n[1]: `;
}

/**
 * Orchestrate the menu with an injected readline-style prompt. Collapses to a
 * direct default launch (no render, no prompt) when only option 1 applies.
 * Re-prompts on invalid input up to `maxAttempts`, then falls back to the safe
 * default (option 1) so a fat-fingered session still launches.
 */
export async function runBareLaunchMenu(
  inputs: LaunchMenuInputs,
  prompt: (message: string) => Promise<string>,
  opts: { maxAttempts?: number; warn?: (message: string) => void } = {}
): Promise<LaunchMenuAction> {
  const options = buildLaunchMenuOptions(inputs);
  if (options.length === 1) return options[0].action; // collapse — never a 1-item menu

  const maxAttempts = opts.maxAttempts ?? 3;
  const menu = renderLaunchMenu(options);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await prompt(attempt === 0 ? menu : `Invalid choice.\n${menu}`);
    const res = resolveLaunchMenuChoice(options, raw);
    if (res.ok) return res.action;
    opts.warn?.(`invalid launch-menu selection: ${JSON.stringify(raw.trim())}`);
  }
  return options[0].action; // exhausted → safe default
}
