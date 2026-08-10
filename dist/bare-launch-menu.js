/**
 * gh#853 — bare `borg` (no-args) interactive launch menu.
 *
 * When `borg` is run with NO arguments in a TTY from a repository's main
 * worktree, offer a small launch selector. A linked worktree still resumes its
 * own drone directly, so selecting a sibling from the menu cannot recurse.
 *
 * The option-set, the selection→action mapping, and the show/collapse decision
 * are pure functions so they're unit-testable without a real TTY. claude.ts
 * main() is thin glue: it computes the available candidates and agent choices,
 * gates on shouldShowLaunchMenu, runs the orchestrator with the real readline
 * prompt, then dispatches the returned action.
 *
 * Load-bearing safety: TTY-only + bare-args-only + main-worktree-only
 * (shouldShowLaunchMenu), so scripted/programmatic invocations and direct
 * linked-worktree resumes are untouched.
 */
import { isAbsolute } from 'node:path';
const TERMINAL_SEAT_STATUSES = new Set([
    'evicted',
    'revoked',
    'rejected',
    'credential-rejected',
    'trust-mismatch',
]);
export function isTerminalLaunchMenuSeatStatus(status) {
    return TERMINAL_SEAT_STATUSES.has(status);
}
export function terminalLaunchMenuSeatNotice(status) {
    const reason = {
        evicted: 'the server reports that it was evicted',
        revoked: 'its local session was revoked',
        rejected: 'its local session was superseded by a newer enrollment',
        'credential-rejected': 'its saved credential was rejected',
        'trust-mismatch': 'the saved server identity no longer matches',
    };
    const recovery = status === 'trust-mismatch'
        ? 'Verify that this is the expected server; if it was re-initialized, restore the expected identity before relaunching.\n'
        : 'Run `borg reset-local-connection`, then `borg assimilate` to start a replacement managed-worktree drone.\n';
    return (`This worktree's saved drone cannot be resumed because ${reason[status]}. ` +
        `It is not offered in the menu below. ${recovery}`);
}
/**
 * Find linked sibling worktrees that still own their preferred active seat.
 * Authoritative terminal probe results are omitted; transient/unknown probe
 * results stay visible, matching launch-all's constructive fail-open behavior.
 */
export async function discoverLiveLaunchMenuCandidates(deps) {
    const identities = await deps.readAllProjectIdentities();
    const cubeIds = [...new Set(identities.map(({ cube }) => cube.cubeId))];
    const discovered = (await Promise.all(cubeIds.map((cubeId) => deps.discoverDroneCandidates(cubeId)))).flat();
    const candidates = [];
    const seen = new Set();
    for (const candidate of discovered) {
        if (!deps.pathExists(candidate.worktreeDir))
            continue;
        const preferred = await deps.getActiveSeatForWorktree(candidate.worktreeDir);
        if (!preferred ||
            preferred.cubeId !== candidate.cubeId ||
            preferred.droneId !== candidate.droneId)
            continue;
        let status;
        try {
            status = await deps.probeSeat(candidate);
        }
        catch {
            status = 'indeterminate';
        }
        if (isTerminalLaunchMenuSeatStatus(status))
            continue;
        const key = `${candidate.cubeId}\0${candidate.droneId}\0${candidate.worktreeDir}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        candidates.push({
            cubeId: candidate.cubeId,
            droneLabel: candidate.droneLabel,
            target: candidate.droneId,
            worktree: candidate.worktreeDir,
        });
    }
    candidates.sort((a, b) => a.droneLabel.localeCompare(b.droneLabel) || a.worktree.localeCompare(b.worktree));
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
export function configureSelectedLaunchCli(defaultCli, action, configure) {
    const cli = action?.kind === 'launch' ? action.cli : defaultCli;
    configure(cli);
    return cli;
}
const PRETTY = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
/**
 * Git reports the main worktree with identical absolute git-dir/common-dir
 * paths. Linked worktrees instead use <common>/worktrees/<name> as git-dir.
 * Fail closed when either probe is absent or malformed.
 */
export function isMainGitWorktree(readGitPath) {
    try {
        const gitDir = readGitPath(['rev-parse', '--path-format=absolute', '--git-dir']).trim();
        const commonDir = readGitPath(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
        return isAbsolute(gitDir) && isAbsolute(commonDir) && gitDir === commonDir;
    }
    catch {
        return false;
    }
}
/**
 * Gate: the menu fires ONLY for bare `borg` (no args) in a TTY from the main
 * repository worktree. Explicit invocations, non-TTY launches, and linked
 * worktree resumes fall straight through to the existing launch path.
 */
export function shouldShowLaunchMenu(args) {
    return args.extraArgs.length === 0
        && args.stdinIsTTY
        && args.stdoutIsTTY
        && args.isMainWorktree;
}
/**
 * The context-filtered option set. Option 1 is always present; options 2/3 are
 * included only when applicable. Keys are sequential with no gaps, so a hidden
 * middle option never produces a "1) … 3) …" gap menu.
 */
export function buildLaunchMenuOptions(inputs) {
    const currentDrone = inputs.currentDrone && !isTerminalLaunchMenuSeatStatus(inputs.currentDrone.status)
        ? inputs.currentDrone
        : undefined;
    if (currentDrone || (inputs.droneCandidates && inputs.droneCandidates.length > 0)) {
        const options = [];
        if (currentDrone) {
            options.push({
                key: '1',
                label: `Resume ${currentDrone.droneLabel} (${currentDrone.worktree})`,
                action: { kind: 'launch', cli: inputs.defaultCli },
            });
        }
        options.push(...[...(inputs.droneCandidates ?? [])]
            .sort((a, b) => a.droneLabel.localeCompare(b.droneLabel) || a.worktree.localeCompare(b.worktree))
            .map((candidate, index) => ({
            key: String(options.length + index + 1),
            label: `Resume ${candidate.droneLabel} (${candidate.worktree})`,
            action: { kind: 'launch-seat', target: candidate.target },
        })));
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
        if (!currentDrone) {
            options.push({
                key: String(options.length + 1),
                label: `Launch ${PRETTY[inputs.defaultCli]} here without a drone`,
                action: { kind: 'launch', cli: inputs.defaultCli },
            });
        }
        for (const cli of inputs.otherConfiguredClis) {
            options.push({
                key: String(options.length + 1),
                label: currentDrone
                    ? `Resume ${currentDrone.droneLabel} with ${PRETTY[cli]} (one-shot)`
                    : `Launch with ${PRETTY[cli]} here without a drone (one-shot)`,
                action: { kind: 'launch', cli },
            });
        }
        return options;
    }
    const options = [
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
export function resolveLaunchMenuChoice(options, rawInput) {
    const trimmed = rawInput.trim();
    if (trimmed === '')
        return { ok: true, action: options[0].action };
    const match = options.find((o) => o.key === trimmed);
    return match ? { ok: true, action: match.action } : { ok: false };
}
/** The rendered menu text (prompt suffix `[1]:` defaults to option 1 on Enter). */
export function renderLaunchMenu(options) {
    const lines = options.map((o) => `  ${o.key}) ${o.label}`);
    return `borg — how do you want to launch?\n${lines.join('\n')}\n[1]: `;
}
/**
 * Orchestrate the menu with an injected readline-style prompt. The caller has
 * already established that this is a bare interactive main-worktree launch,
 * so even a one-item selector is rendered. Re-prompts on invalid input up to
 * `maxAttempts`, then falls back to the safe default (option 1).
 */
export async function runBareLaunchMenu(inputs, prompt, opts = {}) {
    const options = buildLaunchMenuOptions(inputs);
    const maxAttempts = opts.maxAttempts ?? 3;
    const menu = renderLaunchMenu(options);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const raw = await prompt(attempt === 0 ? menu : `Invalid choice.\n${menu}`);
        const res = resolveLaunchMenuChoice(options, raw);
        if (res.ok)
            return res.action;
        opts.warn?.(`invalid launch-menu selection: ${JSON.stringify(raw.trim())}`);
    }
    return options[0].action; // exhausted → safe default
}
//# sourceMappingURL=bare-launch-menu.js.map