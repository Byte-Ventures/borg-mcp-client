// gh#556 Part 2 — `borg launch-all [cube]` orchestrator (spec §3, §6, §7).
//
// runLaunchAll: resolve target cube → sweep stale locks → discover candidates →
// live-skip → (dry-run / >6 confirm) → select backend → dispatch → reconcile
// roster → summary. Returns 0 on success, 1 on hard failure.

import type { LaunchAllArgs } from './parse-launch-all-args.js';
import type { LaunchAllDeps } from './launch-all-deps.js';
import { discoverDroneCandidates, type DroneCandidate } from './launch-all-discovery.js';
import type { SeatStatus } from './seat-probe.js';
import { resolveBorgPath } from './launch-all-command.js';
import { sweepStaleLocks, isLockLive } from './launch-all-locks.js';
import { runTmuxBackend } from './backends/launch-all-tmux.js';
import { runWindowsBackend } from './backends/launch-all-windows.js';
import { runPastelistBackend } from './backends/launch-all-pastelist.js';

type Backend = 'tmux' | 'windows' | 'pastelist';

const TMUX_INSTALL_HINT =
  'borg launch-all: tmux not found.\n' +
  '  macOS:  brew install tmux\n' +
  '  Debian: sudo apt install tmux\n' +
  '  Fedora: sudo dnf install tmux\n';

function checkTmuxAvailable(deps: LaunchAllDeps): boolean {
  try {
    deps.runSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

function isWSL(deps: LaunchAllDeps): boolean {
  try {
    return /microsoft|wsl/i.test(deps.runSync('uname', ['-r']));
  } catch {
    return false;
  }
}

/** /^drone-\d+$/ → a drone label, not a role name (governs --only tier-2 note). */
function looksLikeDroneLabel(only: string): boolean {
  return /^drone-\d+$/i.test(only) || only.toLowerCase() === 'drone';
}

/** Resolve the target cubeId + display name (spec §3.1). */
async function resolveTargetCube(
  args: LaunchAllArgs,
  deps: LaunchAllDeps
): Promise<{ cubeId: string; name: string } | { error: string }> {
  if (args.cubeName !== undefined) {
    const identities = await deps.readAllProjectIdentities();
    const matches = identities.filter((e) => e.cube.name === args.cubeName);
    if (matches.length === 0) {
      return { error: `no cube named '${args.cubeName}' found among this machine's saved seats — has any drone assimilated into it?` };
    }
    // gh#850: distinct cubes can share a name (same name across accounts/
    // environments, or a stale seat). Silently taking matches[0] could launch
    // the wrong fleet, so when the name is ambiguous, surface each match's
    // cubeId + the project that holds the seat and refuse to guess.
    if (matches.length > 1) {
      const list = matches
        .map((m) => `  ${m.cube.cubeId}  (seat in ${m.projectPath})`)
        .join('\n');
      return {
        error:
          `'${args.cubeName}' is ambiguous — ${matches.length} saved seats on this machine share that name:\n${list}\n` +
          'cd into the intended project and re-run without --cube-name (resolves the active cube), ' +
          'or clear the stale seat(s) by running `borg reset-local-seat` from the worktree that holds each.',
      };
    }
    return { cubeId: matches[0].cube.cubeId, name: args.cubeName };
  }
  const active = await deps.getActiveCube();
  if (!active) {
    return {
      error:
        'no active cube in this directory; run `borg assimilate` first, or pass a cube name explicitly',
    };
  }
  return { cubeId: active.cubeId, name: active.name };
}

/** Backend selection (spec §4.1): native-Windows / explicit / tmux-preflight / auto. */
function selectBackend(args: LaunchAllArgs, deps: LaunchAllDeps): { backend: Backend } | { hardFail: string } {
  const explicit = args.flags.mode;
  const nativeWindows = deps.platform() === 'win32' && !isWSL(deps);
  if (nativeWindows) {
    deps.stderr(
      'native Windows is not supported for interactive launch; using pastelist mode instead ' +
        '(WSL + tmux is the recommended Windows path)\n'
    );
    return { backend: 'pastelist' };
  }
  if (explicit === 'windows') return { backend: 'windows' };
  if (explicit === 'pastelist') return { backend: 'pastelist' };

  const tmuxAvail = checkTmuxAvailable(deps);
  if (explicit === 'tmux') {
    return tmuxAvail ? { backend: 'tmux' } : { hardFail: TMUX_INSTALL_HINT };
  }
  // auto (no explicit mode)
  if (tmuxAvail) return { backend: 'tmux' };
  deps.stderr(TMUX_INSTALL_HINT + 'Falling back to pastelist mode (paste the commands below).\n');
  return { backend: 'pastelist' };
}

/** attach mode for tmux (spec §4.1 attach behavior). */
function resolveAttachMode(args: LaunchAllArgs, deps: LaunchAllDeps): 'attach' | 'switch' | 'none' {
  if (args.flags.noAttach) return 'none';
  if (!deps.isTTY()) return 'none';
  if (deps.getEnv('TMUX')) return 'switch';
  return 'attach';
}

function printCheatSheet(sessionName: string, deps: LaunchAllDeps): void {
  deps.stdout(`  tmux attach -t ${sessionName}          # re-attach later\n`);
  deps.stdout(`  tmux list-windows -t ${sessionName}    # list all drone windows\n`);
  deps.stdout(`  tmux kill-session -t ${sessionName}    # stop all drones\n`);
}

function sanitizeSessionName(cubeName: string): string {
  return `borg-${cubeName.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Roster reconciliation (spec §7.2). Returns droneId → 'verified'|'unconfirmed'. */
async function reconcileRoster(
  deps: LaunchAllDeps,
  token: string,
  apiUrl: string,
  serverTrustIdentity: string | undefined,
  launchStartISO: string,
  launchedDroneIds: string[],
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<Map<string, 'verified' | 'unconfirmed'>> {
  const result = new Map<string, 'verified' | 'unconfirmed'>();
  for (const id of launchedDroneIds) result.set(id, 'unconfirmed');
  const deadline = now() + 10_000;
  // Bounded: 20 polls max (10s / 500ms), AND the time deadline — whichever first.
  // The poll cap guarantees termination even if a (test-)injected clock is static.
  for (let i = 0; i < 20; i++) {
    if (now() >= deadline) break;
    let roster: { drones: Array<{ id: string; seen_since?: boolean }> };
    try {
      roster = await deps.getRoster(
        token,
        apiUrl,
        launchStartISO,
        serverTrustIdentity,
      );
    } catch (err) {
      // gh#850: the roster-reconcile token can rotate mid-launch — authedFetch
      // throws "Authentication required" on a terminal 401. A bare `break` left
      // the operator staring at all-'unconfirmed' with no reason. Surface WHY
      // confirmation stopped (token rotation is the common cause) so they know
      // the launches likely succeeded even though we couldn't confirm them.
      const reason = err instanceof Error ? err.message : String(err);
      const tokenRotated = /Authentication required/i.test(reason);
      deps.stderr(
        `roster confirmation skipped (${tokenRotated ? 'token rotated mid-launch' : reason}); ` +
          'launched drones may still be live — re-check with `borg_roster`.\n'
      );
      break;
    }
    for (const drone of roster.drones) {
      if (result.get(drone.id) === 'unconfirmed' && drone.seen_since === true) {
        result.set(drone.id, 'verified');
      }
    }
    if ([...result.values()].every((v) => v === 'verified')) break;
    await sleep(500);
  }
  return result;
}

/**
 * Default ms to wait BETWEEN each drone launch, so a fleet's agents don't all
 * bootstrap at once and trip the per-user/IP rate limiter. Override per-run with
 * `--launch-delay <ms>` or persistently with `$BORG_LAUNCH_DELAY_MS`; 0 disables.
 */
export const DEFAULT_LAUNCH_DELAY_MS = 2000;

/** Resolve the inter-launch stagger: flag > env > default (each must be a non-negative integer to win). */
export function resolveLaunchDelayMs(flag: number | undefined, env: string | undefined): number {
  if (flag !== undefined && Number.isInteger(flag) && flag >= 0) return flag;
  // Trim BEFORE the empty check: `Number('   ')` is 0, which would otherwise pass
  // validation and SILENTLY DISABLE the stagger — defeating the rate-limit
  // protection this feature exists to provide. Whitespace-only → fall to default.
  const trimmed = env === undefined ? '' : env.trim();
  const n = trimmed === '' ? NaN : Number(trimmed);
  if (Number.isInteger(n) && n >= 0) return n;
  return DEFAULT_LAUNCH_DELAY_MS;
}

export interface RunLaunchAllOptions {
  /** Injectable clock/sleep for deterministic reconciliation tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  nowISO?: () => string;
  borgPath?: string;
}

export async function runLaunchAll(
  args: LaunchAllArgs,
  deps: LaunchAllDeps,
  opts: RunLaunchAllOptions = {}
): Promise<number> {
  const now = opts.now ?? Date.now;
  const nowISO = opts.nowISO ?? (() => new Date().toISOString());
  const borgPath = opts.borgPath ?? resolveBorgPath();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const launchDelayMs = resolveLaunchDelayMs(args.flags.launchDelayMs, deps.getEnv('BORG_LAUNCH_DELAY_MS'));

  // 1. resolve target cube
  const resolved = await resolveTargetCube(args, deps);
  if ('error' in resolved) {
    deps.stderr(`borg launch-all: ${resolved.error}\n`);
    return 1;
  }
  const { cubeId, name: cubeName } = resolved;

  // 2. sweep stale locks before discovery
  sweepStaleLocks(deps, cubeId, now());

  // 3. discover candidates
  const discovered = await discoverDroneCandidates({ targetCubeId: cubeId, only: args.flags.only }, deps);
  if (discovered.length === 0) {
    if (args.flags.only !== undefined) {
      deps.stdout(`No worktrees matched --only '${args.flags.only}' for cube '${cubeName}'\n`);
      if (!looksLikeDroneLabel(args.flags.only)) {
        deps.stderr(
          `note: --only '${args.flags.only}' is matched best-effort by drone label; role-name matching ` +
            `needs a drone session and is not available here.\n`
        );
      }
    } else {
      deps.stdout(
        `No worktrees found for cube '${cubeName}' — have you run \`borg assimilate --worktree\` to create any drone seats?\n`
      );
    }
    return 0;
  }

  // 4. live-drone skip (lock-file), unless --force
  const lockLaunchable: DroneCandidate[] = [];
  for (const c of discovered) {
    const lock = isLockLive(deps, cubeId, c.worktreeDir, now());
    if (lock.live && !args.flags.force) {
      deps.stderr(`skipping ${c.droneLabel} (${c.worktreeDir}): appears live. Use --force to re-launch.\n`);
      continue;
    }
    if (lock.live && args.flags.force) {
      deps.stderr(`--force: re-launching ${c.droneLabel} (${c.worktreeDir}); the running session's token will be displaced.\n`);
    }
    lockLaunchable.push(c);
  }
  if (lockLaunchable.length === 0) {
    deps.stdout(`All ${discovered.length} drone(s) for cube '${cubeName}' appear live; nothing to launch (use --force to re-launch).\n`);
    return 0;
  }

  // 4b. server-liveness skip — drop seats the server reports EVICTED (gone).
  //     Reuses the gh#882 per-seat probe (each seat's OWN token → 410
  //     DRONE_EVICTED). Relaunching an evicted seat silently re-mints a fresh
  //     drone (the resurrection bug). So SKIP evicted; LAUNCH 'live' +
  //     'indeterminate'.
  //
  //     Launch-vs-delete asymmetry (vs `borg cleanup`, which fails SAFE): a
  //     LAUNCH is constructive — a transient probe failure must NOT silently
  //     omit a real seat (that is a new silent-stall class), so 'indeterminate'
  //     fails OPEN (launch anyway, with a note). Only an AUTHORITATIVE 410
  //     skips. --force does NOT override this skip: an evicted seat is
  //     server-authoritative gone, whereas --force only re-launches a
  //     LOCK-live (seemingly-running) session.
  const launchable: DroneCandidate[] = [];
  let evictedCount = 0;
  let revokedCount = 0;
  let rejectedCount = 0;
  let trustMismatchCount = 0;
  let credentialRejectedCount = 0;
  for (const c of lockLaunchable) {
    let status: SeatStatus;
    try {
      status = await deps.probeSeat(c.sessionToken, c.apiUrl, c.serverTrustIdentity);
    } catch {
      status = 'indeterminate';
    }
    if (status === 'evicted') {
      evictedCount += 1;
      deps.stderr(
        `skipping ${c.droneLabel} (${c.worktreeDir}): seat no longer in cube (evicted) — ` +
          `run \`borg cleanup --prune\` to remove the worktree, or \`borg assimilate\` to re-seat fresh.\n`
      );
      continue;
    }
    if (status === 'revoked') {
      revokedCount += 1;
      deps.stderr(
        `Local session was revoked.\n` +
          `Next: run borg reset-local-seat, then borg assimilate --host ${c.apiUrl} --enroll.\n`
      );
      continue;
    }
    if (status === 'rejected') {
      rejectedCount += 1;
      deps.stderr(
        `Local session was superseded by a newer enrollment.\n` +
          `Next: run borg reset-local-seat, then borg assimilate --host ${c.apiUrl} --enroll.\n`
      );
      continue;
    }
    // SR-seven (b): trust-mismatch is TERMINAL — a pinned-identity change is not
    // fixed by launching a doomed drone, so SKIP (never fail-open).
    if (status === 'trust-mismatch') {
      trustMismatchCount += 1;
      deps.stderr(
        `skipping ${c.droneLabel} (${c.worktreeDir}): could not verify the server identity ` +
          `(pinned trust changed) — this is terminal. Confirm ${c.apiUrl} is the expected server; ` +
          'if it was re-initialized, restore the expected identity before relaunching.\n'
      );
      continue;
    }
    // SR-seven (b): credential-rejected is a cause-accurate SKIP (not a fail-open
    // launch) — the saved credential no longer authenticates; re-enroll first.
    if (status === 'credential-rejected') {
      credentialRejectedCount += 1;
      deps.stderr(
        `skipping ${c.droneLabel} (${c.worktreeDir}): saved credential was rejected (not a takeover) — ` +
          `re-enroll from that worktree with \`borg assimilate --host ${c.apiUrl} --enroll\`.\n`
      );
      continue;
    }
    // CR5: every non-authoritative cause fails OPEN (launch anyway) with a
    // cause-accurate note. Only the authoritative/terminal causes above skip.
    if (status === 'unreachable') {
      deps.stderr(
        `note: could not reach ${c.droneLabel}'s server to confirm its seat (network/timeout) — launching anyway.\n`
      );
    } else if (status === 'endpoint-mismatch') {
      deps.stderr(
        `note: ${c.droneLabel}'s server did not recognize the drone endpoint (possible client/server version mismatch) — launching anyway.\n`
      );
    } else if (status === 'server-failure') {
      deps.stderr(
        `note: ${c.droneLabel}'s server returned an error while confirming its seat (transient) — launching anyway.\n`
      );
    } else if (status === 'indeterminate') {
      deps.stderr(
        `note: could not confirm ${c.droneLabel}'s seat is live (network/transient) — launching anyway.\n`
      );
    }
    launchable.push(c);
  }
  if (launchable.length === 0) {
    // Accurate cause counts — an all-rejected sweep must NOT claim "evicted"
    // (and vice-versa). Only name a cause when at least one seat hit it.
    const causes: string[] = [];
    if (evictedCount > 0) {
      causes.push(`${evictedCount} evicted`);
    }
    if (revokedCount > 0) {
      causes.push(`${revokedCount} revoked`);
    }
    if (rejectedCount > 0) {
      causes.push(`${rejectedCount} superseded`);
    }
    if (trustMismatchCount > 0) {
      causes.push(`${trustMismatchCount} with a changed (terminal) server identity`);
    }
    if (credentialRejectedCount > 0) {
      causes.push(`${credentialRejectedCount} with a rejected saved credential`);
    }
    const causeText = causes.length > 0 ? ` (${causes.join(', ')})` : '';
    deps.stdout(
      `All ${lockLaunchable.length} discovered drone(s) for cube '${cubeName}' are not launchable` +
        `${causeText}; nothing to launch.\n`
    );
    return 0;
  }

  // 5. --dry-run
  if (args.flags.dryRun) {
    deps.stdout(`borg launch-all (dry-run): would launch ${launchable.length} drone(s) for cube '${cubeName}':\n`);
    for (const c of launchable) deps.stdout(`  ${c.droneLabel}  ${c.worktreeDir}\n`);
    return 0;
  }

  // 6. >6 confirmation
  if (launchable.length > 6 && !args.flags.yes) {
    const ans = await deps.prompt(`About to launch ${launchable.length} drones for cube '${cubeName}'. Continue? [y/N]: `);
    if (ans.trim().toLowerCase() !== 'y') {
      deps.stdout('Aborted.\n');
      return 0;
    }
  }

  // 7. backend selection
  const sel = selectBackend(args, deps);
  if ('hardFail' in sel) {
    deps.stderr(sel.hardFail);
    return 1;
  }
  const sessionName = sanitizeSessionName(cubeName);
  const launchStartISO = nowISO();

  // 8. dispatch
  try {
    if (sel.backend === 'tmux') {
      const attachMode = resolveAttachMode(args, deps);
      await runTmuxBackend(launchable, { sessionName, borgPath, attachMode, launchedAtISO: launchStartISO, launchDelayMs, sleep }, deps);
      if (attachMode === 'none') {
        if (!deps.isTTY()) {
          deps.stderr(`Launching in detached mode — stdout is non-TTY. Attach manually with: tmux attach -t ${sessionName}\n`);
        }
        printCheatSheet(sessionName, deps);
      }
    } else if (sel.backend === 'windows') {
      await runWindowsBackend(launchable, { borgPath, platform: deps.platform(), launchedAtISO: launchStartISO, launchDelayMs, sleep }, deps);
    } else {
      runPastelistBackend(launchable, borgPath, deps);
      return 0; // pastelist: nothing to reconcile (operator pastes manually)
    }
  } catch (e) {
    deps.stderr(`borg launch-all: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // 9. roster reconciliation (best-effort; uses the OLD saved token from the first candidate)
  const reconToken = launchable[0].sessionToken;
  const reconApiUrl = launchable[0].apiUrl;
  const reconServerTrustIdentity = launchable[0].serverTrustIdentity;
  let statuses: Map<string, 'verified' | 'unconfirmed'> | null = null;
  if (reconToken && reconApiUrl) {
    statuses = await reconcileRoster(
      deps,
      reconToken,
      reconApiUrl,
      reconServerTrustIdentity,
      launchStartISO,
      launchable.map((c) => c.droneId),
      opts.now,
      opts.sleep
    );
  } else {
    deps.stderr('roster reconciliation skipped — no session token available\n');
  }

  // 10. summary
  deps.stdout(`\nborg launch-all: launched ${launchable.length} drones for cube '${cubeName}'\n\n`);
  for (const c of launchable) {
    const status = statuses ? (statuses.get(c.droneId) === 'verified' ? 'VERIFIED' : 'unconfirmed (may still be joining)') : 'launched';
    deps.stdout(`  ${c.droneLabel}  ${c.worktreeDir}  ${status}\n`);
  }
  deps.stdout(`\nAttach: tmux attach -t ${sessionName}\n`);
  return 0;
}
