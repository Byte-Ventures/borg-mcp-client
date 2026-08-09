// client#400 — terminals backend (`--mode terminals`; macOS auto default).
// Opens each worktree as a new terminal window/tab. macOS: iTerm/Terminal via
// osascript. Linux: $BORG_TERMINAL / $TERMINAL / probed emulator. No shared
// session, so no post-launch attach. Hard-fails if no compatible terminal found.

import type { DroneCandidate } from '../launch-all-discovery.js';
import type { LaunchAllDeps } from '../launch-all-deps.js';
import { buildLaunchCommand } from '../launch-all-command.js';
import { writeLockMarker } from '../launch-all-locks.js';
import { composeTerminalTitle } from '../terminal-title.js';
import { shellEscape } from '../shell-escape.js';

const ITERM_APP = '/Applications/iTerm.app';
const TERMINAL_APPS = [
  '/System/Applications/Utilities/Terminal.app',
  '/Applications/Utilities/Terminal.app',
  '/Applications/Terminal.app',
] as const;

export interface TerminalsOpts {
  borgPath: string;
  platform: NodeJS.Platform;
  cubeName: string;
  launchedAtISO: string;
  /** Stagger between drone launches (ms) to avoid the rate limiter; 0 disables. */
  launchDelayMs: number;
  /** Injectable sleep (real setTimeout in prod; no-op spy in tests). */
  sleep: (ms: number) => Promise<void>;
}

/** AppleScript string-literal escaping (backslash + double-quote). */
function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

class NoTerminalError extends Error {}

export function hasMacOSTerminalApp(deps: Pick<LaunchAllDeps, 'pathExists'>): boolean {
  return deps.pathExists(ITERM_APP) || TERMINAL_APPS.some((path) => deps.pathExists(path));
}

/** macOS: open each candidate in iTerm or Terminal via osascript. */
async function launchMacOS(candidates: DroneCandidate[], opts: TerminalsOpts, deps: LaunchAllDeps): Promise<void> {
  const hasITerm = deps.pathExists(ITERM_APP);
  const hasTerminal = TERMINAL_APPS.some((path) => deps.pathExists(path));
  if (!hasITerm && !hasTerminal) {
    throw new NoTerminalError(
      'borg launch-all: --mode terminals requires a compatible terminal app.\n' +
        'Not found: iTerm.app, Terminal.app\n' +
        'Install iTerm2 (https://iterm2.com) or use --mode tmux (brew install tmux).\n'
    );
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (i > 0 && opts.launchDelayMs > 0) await opts.sleep(opts.launchDelayMs); // rate-limit stagger
    const cmd = buildLaunchCommand(c.worktreeDir, opts.borgPath);
    const title = composeTerminalTitle({ label: c.droneLabel, cubeName: opts.cubeName }, '');
    const script = hasITerm
      ? `tell application "iTerm"\n  if (count of windows) = 0 then\n    set launchedWindow to (create window with default profile command "${appleScriptEscape(cmd)}")\n    tell current session of launchedWindow to set name to "${appleScriptEscape(title)}"\n  else\n    tell current window\n      set launchedTab to (create tab with default profile command "${appleScriptEscape(cmd)}")\n      tell current session of launchedTab to set name to "${appleScriptEscape(title)}"\n    end tell\n  end if\nend tell`
      : `tell application "Terminal"\n  set launchedTab to do script "${appleScriptEscape(cmd)}"\n  set custom title of launchedTab to "${appleScriptEscape(title)}"\n  set title displays custom title of launchedTab to true\n  activate\nend tell`;
    deps.runSync('osascript', ['-e', script]);
    writeLockMarker(deps, c.cubeId, c.droneLabel, c.worktreeDir, opts.launchedAtISO);
  }
}

/** Linux: open each candidate in the first available terminal emulator. */
async function launchLinux(candidates: DroneCandidate[], opts: TerminalsOpts, deps: LaunchAllDeps): Promise<void> {
  const explicit = deps.getEnv('BORG_TERMINAL') || deps.getEnv('TERMINAL');
  const probe = ['gnome-terminal', 'konsole', 'kitty', 'wezterm', 'xterm'];
  let term: string | undefined = explicit;
  if (!term) {
    for (const name of probe) {
      if (deps.runSyncExitCode('which', [name]) === 0) {
        term = name;
        break;
      }
    }
  }
  if (!term) {
    throw new NoTerminalError(
      'borg launch-all: --mode terminals requires a terminal emulator.\n' +
        'Not found. Set $BORG_TERMINAL=<path> or use --mode tmux.\n'
    );
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (i > 0 && opts.launchDelayMs > 0) await opts.sleep(opts.launchDelayMs); // rate-limit stagger
    const title = composeTerminalTitle({ label: c.droneLabel, cubeName: opts.cubeName }, '');
    const cmd =
      `printf '\\033]0;%s\\007' ${shellEscape(title)}; ` +
      buildLaunchCommand(c.worktreeDir, opts.borgPath, { keepOpenOnFail: true });
    // `<term> -e sh -c '<cmd>'` opens a new window running the command.
    deps.runSync(term, ['-e', 'sh', '-c', cmd]);
    writeLockMarker(deps, c.cubeId, c.droneLabel, c.worktreeDir, opts.launchedAtISO);
  }
}

/**
 * Control char (incl. newline) in a worktree path. SR f94bb3fe + Coordinator
 * c6370c41 fold-in: a newline in the path breaks the macOS osascript AppleScript
 * string literal (parse error). Reject such paths up front (the user's own path;
 * pathological) — fail-loud + skip, never silently mangle. Applies to both
 * platforms defensively (the tmux primary handles control chars fine via
 * shellEscape + array-args, so this guard is terminals-backend-specific).
 */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export async function runTerminalsBackend(
  candidates: DroneCandidate[],
  opts: TerminalsOpts,
  deps: LaunchAllDeps
): Promise<void> {
  const safe = candidates.filter((c) => {
    if (CONTROL_CHAR_RE.test(c.worktreeDir)) {
      deps.stderr(
        `skipping ${c.droneLabel} (${JSON.stringify(c.worktreeDir)}): worktree path contains a control ` +
          `character — unsafe for --mode terminals; use --mode tmux instead.\n`
      );
      return false;
    }
    return true;
  });
  if (opts.platform === 'darwin') {
    await launchMacOS(safe, opts, deps);
  } else {
    await launchLinux(safe, opts, deps);
  }
}
