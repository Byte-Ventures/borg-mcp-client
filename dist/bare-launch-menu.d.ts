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
export type LaunchMenuAction = {
    kind: 'launch';
    cli: BorgCli;
} | {
    kind: 'launch-seat';
    target: string;
} | {
    kind: 'launch-all';
    cubeId?: string;
};
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
    readAllProjectIdentities: () => Promise<Array<{
        projectPath: string;
        cube: ActiveCube;
    }>>;
    discoverDroneCandidates: (cubeId: string) => Promise<DroneCandidate[]>;
    getActiveSeatForWorktree: (worktree: string) => Promise<{
        cubeId: string;
        droneId?: string;
    } | null>;
    pathExists: (worktree: string) => boolean;
    probeSeat: (candidate: DroneCandidate) => Promise<SeatStatus>;
}
/**
 * Find linked sibling worktrees that still own their preferred active seat.
 * Authoritative terminal probe results are omitted; transient/unknown probe
 * results stay visible, matching launch-all's constructive fail-open behavior.
 */
export declare function discoverLiveLaunchMenuCandidates(deps: LaunchMenuCandidateDeps): Promise<{
    candidates: LaunchMenuDroneCandidate[];
    launchAllCubeId?: string;
}>;
/**
 * Resolve and configure the CLI that will actually launch.
 *
 * This callback deliberately runs after the one-shot menu choice. A bare
 * launch may resolve one default CLI first and then launch a different
 * configured CLI for this invocation; only the final CLI may be self-healed.
 */
export declare function configureSelectedLaunchCli(defaultCli: BorgCli, action: LaunchMenuAction | undefined, configure: (cli: BorgCli) => void): BorgCli;
/**
 * Gate: the menu fires ONLY for bare `borg` (no args) in a TTY without an
 * active seat. Explicit invocations, non-TTY launches, and direct worktree
 * resumes fall straight through to the existing launch path.
 */
export declare function shouldShowLaunchMenu(args: {
    extraArgs: string[];
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    hasActiveSeat?: boolean;
}): boolean;
export declare function explicitCliLaunchHint(args: {
    explicitCli: BorgCli | undefined;
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    hasActiveCube: boolean;
    hasLaunchAllTargets: boolean;
}): string | null;
export declare function shouldResolveExplicitCliLaunchHintTargets(args: {
    explicitCli: BorgCli | undefined;
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    hasActiveCube: boolean;
}): boolean;
/**
 * The context-filtered option set. Option 1 is always present; options 2/3 are
 * included only when applicable. Keys are sequential with no gaps, so a hidden
 * middle option never produces a "1) … 3) …" gap menu.
 */
export declare function buildLaunchMenuOptions(inputs: LaunchMenuInputs): LaunchMenuOption[];
/** Map a raw prompt answer to an action. Empty/Enter → option 1 (default). */
export declare function resolveLaunchMenuChoice(options: LaunchMenuOption[], rawInput: string): {
    ok: true;
    action: LaunchMenuAction;
} | {
    ok: false;
};
/** The rendered menu text (prompt suffix `[1]:` defaults to option 1 on Enter). */
export declare function renderLaunchMenu(options: LaunchMenuOption[]): string;
/**
 * Orchestrate the menu with an injected readline-style prompt. Collapses to a
 * direct default launch (no render, no prompt) when only option 1 applies.
 * Re-prompts on invalid input up to `maxAttempts`, then falls back to the safe
 * default (option 1) so a fat-fingered session still launches.
 */
export declare function runBareLaunchMenu(inputs: LaunchMenuInputs, prompt: (message: string) => Promise<string>, opts?: {
    maxAttempts?: number;
    warn?: (message: string) => void;
}): Promise<LaunchMenuAction>;
export {};
//# sourceMappingURL=bare-launch-menu.d.ts.map