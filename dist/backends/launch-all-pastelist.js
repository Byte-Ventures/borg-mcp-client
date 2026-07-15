// gh#556 Part 2 — pastelist backend (never-fail floor, spec §4.3).
// Prints copy-pasteable `cd <dir> && borg assimilate --here` lines.
import { buildLaunchCommand } from '../launch-all-command.js';
export function runPastelistBackend(candidates, borgPath, deps) {
    deps.stdout('# borg launch-all: open each worktree in a terminal window and run:\n\n');
    for (const c of candidates) {
        // No keep-open-on-fail: the operator owns their own shell in pastelist mode.
        deps.stdout(buildLaunchCommand(c.worktreeDir, borgPath) + '\n');
    }
}
//# sourceMappingURL=launch-all-pastelist.js.map