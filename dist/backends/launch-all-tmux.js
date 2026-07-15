// gh#556 Part 2 — tmux backend (primary, spec §4.1).
// One detached `borg-<cube>` session, one window per drone, each running
// `borg assimilate --here`. Idempotent: reuses an existing session (adds windows).
import { buildLaunchCommand } from '../launch-all-command.js';
import { writeLockMarker } from '../launch-all-locks.js';
export async function runTmuxBackend(candidates, opts, deps) {
    const { sessionName, borgPath, attachMode, launchedAtISO, launchDelayMs, sleep } = opts;
    const sessionExists = deps.runSyncExitCode('tmux', ['has-session', '-t', sessionName]) === 0;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        // Rate-limit stagger: wait BEFORE each launch after the first, so a fleet's
        // agents don't all bootstrap (assimilate + regen + roster) simultaneously and
        // trip the per-user/IP limiter. Window creation is ~instant otherwise, so
        // without this N agents start within ~100ms. 0 → no delay (first never waits).
        if (i > 0 && launchDelayMs > 0) {
            await sleep(launchDelayMs);
        }
        // CR f98b2d70: target windows by their CAPTURED id (`-P -F '#{window_id}'` prints
        // e.g. `@3`), NOT a computed 0-based index. Index-targeting hard-failed under the
        // common `set -g base-index 1` config (new-session creates window 1, not 0) and was
        // fragile to index gaps on the reuse path. Capturing the real id is base-index-proof
        // and gap-proof. new-session AND new-window both print the new window's id with -P -F.
        let windowId;
        if (i === 0 && !sessionExists) {
            windowId = deps
                .runSync('tmux', ['new-session', '-d', '-P', '-F', '#{window_id}', '-s', sessionName, '-c', c.worktreeDir])
                .trim();
        }
        else {
            windowId = deps
                .runSync('tmux', ['new-window', '-P', '-F', '#{window_id}', '-t', sessionName, '-c', c.worktreeDir])
                .trim();
        }
        // tmux-level window name (status bar). The agent's own OSC-0 may update it later.
        deps.runSync('tmux', ['rename-window', '-t', windowId, c.droneLabel]);
        const cmd = buildLaunchCommand(c.worktreeDir, borgPath, { keepOpenOnFail: true });
        deps.runSync('tmux', ['send-keys', '-t', windowId, cmd, 'Enter']);
        // Lock marker written immediately after dispatch (best-effort liveness signal).
        writeLockMarker(deps, c.cubeId, c.droneLabel, c.worktreeDir, launchedAtISO);
    }
    if (attachMode === 'switch') {
        deps.attachInteractive('tmux', ['switch-client', '-t', sessionName]);
    }
    else if (attachMode === 'attach') {
        deps.attachInteractive('tmux', ['attach-session', '-t', sessionName]);
    }
    // 'none' → caller prints the cheat-sheet instead.
}
//# sourceMappingURL=launch-all-tmux.js.map