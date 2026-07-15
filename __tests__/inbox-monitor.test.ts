/**
 * Tests for the gh#8 borg-inbox-monitor pretty-printer.
 *
 * Pure-function tests on `formatEventLine`: valid entry shapes, drop
 * cases (continuation lines, malformed prefixes), and the ~80-char
 * summary truncation. No tail spawning here — that path runs only
 * when the script is invoked as a bin entry.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireInboxLock,
  claimModernMonitorSafely,
  defaultInboxLockDeps,
  ensureInboxDir,
  ensureMonitorStateDir,
  evaluateInboxTailStall,
  formatEventLine,
  formatFreshEventLine,
  heartbeatPathFor,
  isEntryInvocation,
  legacyMonitorArtifactState,
  legacyPidfilePathFor,
  monitorStateRootForWorktree,
  parsePidfileContent,
  parseMonitorInvocation,
  pidfilePathFor,
  readHeartbeatSidecar,
  RecentLineDeduper,
  seedDeduperFromInboxTail,
  tailArgsFor,
  writeHeartbeat,
  type InboxLockDeps,
  type TailStallState,
} from '../src/inbox-monitor';

describe('ensureInboxDir — first-drone-in-new-cube arm race (2026-07-02 incident)', () => {
  // Regression: the kickoff Monitor arms `borg-inbox-monitor <inbox>` at session
  // start, but for the FIRST drone of a brand-new cube the per-cube inbox
  // directory (~/.config/borgmcp/inboxes/<cubeId>/) does not exist yet — the MCP
  // server child creates it only when the SSE stream first writes. The monitor's
  // first fs act (pidfile claim writeFileSync) then threw an uncaught ENOENT →
  // exit 1 → the wake path died at arm time. ensureInboxDir creates the parent
  // chain up front so arming is order-independent with the stream owner.
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the missing parent directory chain (arm before stream owner)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'inbox-ensure-'));
    const inboxPath = path.join(dir, 'cube-uuid', 'drone-uuid.log');
    expect(existsSync(path.dirname(inboxPath))).toBe(false);
    ensureInboxDir(inboxPath);
    expect(existsSync(path.dirname(inboxPath))).toBe(true);
    // The inbox FILE itself is the stream owner's to create; tail -F retries on
    // a missing file, so ensureInboxDir must NOT create it.
    expect(existsSync(inboxPath)).toBe(false);
  });

  it('is idempotent when the directory already exists (every non-first arm)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'inbox-ensure-'));
    const inboxPath = path.join(dir, 'drone-uuid.log');
    writeFileSync(inboxPath, 'existing\n');
    expect(() => ensureInboxDir(inboxPath)).not.toThrow();
    expect(existsSync(inboxPath)).toBe(true);
  });

  it('unblocks a real-fs pidfile claim that ENOENT-crashed pre-fix', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'inbox-ensure-'));
    const inboxPath = path.join(dir, 'cube-uuid', 'drone-uuid.log');
    // Pre-fix shape: writing the pidfile temp into the missing dir throws ENOENT.
    const pidfile = pidfilePathFor(inboxPath);
    expect(() => writeFileSync(`${pidfile}.tmp.probe`, '1:x')).toThrow(/ENOENT/);
    ensureInboxDir(inboxPath);
    expect(() => writeFileSync(`${pidfile}.tmp.probe`, '1:x')).not.toThrow();
  });
});

describe('gh#979 worktree-local monitor runtime state', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('derives one durable root per worktree while keeping re-minted inbox locks distinct', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-worktree-state-'));
    const root = monitorStateRootForWorktree(dir);
    expect(monitorStateRootForWorktree(dir)).toBe(root);
    expect(root).toBe(path.join(dir, '.borgmcp', 'inbox-monitor'));

    const firstInbox = '/home/test/.config/borgmcp/inboxes/cube/first-remint.log';
    const secondInbox = '/home/test/.config/borgmcp/inboxes/cube/second-remint.log';
    expect(pidfilePathFor(firstInbox, root)).toBe(pidfilePathFor(firstInbox, root));
    expect(pidfilePathFor(firstInbox, root)).not.toBe(pidfilePathFor(secondInbox, root));
    expect(path.dirname(pidfilePathFor(firstInbox, root))).toBe(root);
  });

  it('keeps private 0700/0600 runtime state out of git status', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-worktree-git-'));
    execFileSync('git', ['init', '-q', dir]);
    const root = monitorStateRootForWorktree(dir);
    const inbox = '/home/test/.config/borgmcp/inboxes/cube/drone.log';
    ensureMonitorStateDir(root);

    const pidfile = pidfilePathFor(inbox, root);
    const heartbeat = heartbeatPathFor(inbox, root);
    expect(acquireInboxLock(pidfile, process.pid, defaultInboxLockDeps(), 1, 'testnonce')).toBe(true);
    writeHeartbeat(heartbeat, 'testnonce');
    expect(acquireInboxLock(pidfile, process.pid, defaultInboxLockDeps(), 1, 'second-launch')).toBe(false);

    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(pidfile).mode & 0o777).toBe(0o600);
    expect(statSync(heartbeat).mode & 0o777).toBe(0o600);
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: dir,
      encoding: 'utf8',
    })).toBe('');
  });

  it('places state in the writable worktree root when the config inbox is present but unwritable', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-readonly-inbox-'));
    const inboxDir = path.join(dir, 'config-inboxes');
    const inbox = path.join(inboxDir, 'drone.log');
    const worktree = path.join(dir, 'worktree');
    mkdirSync(worktree);
    const root = monitorStateRootForWorktree(worktree);
    ensureInboxDir(inbox);
    writeFileSync(inbox, '');
    chmodSync(inboxDir, 0o500);

    try {
      let adjacentWriteCode: string | undefined;
      try {
        writeFileSync(`${legacyPidfilePathFor(inbox)}.probe`, 'blocked');
      } catch (err: any) {
        adjacentWriteCode = err?.code;
      }
      // Root can bypass POSIX mode bits in a few CI containers; every normal
      // workspace-only process must see an access error here.
      if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
        expect(['EACCES', 'EPERM']).toContain(adjacentWriteCode);
      }

      ensureMonitorStateDir(root);
      const pidfile = pidfilePathFor(inbox, root);
      expect(path.dirname(pidfile)).toBe(root);
      expect(path.dirname(pidfile)).not.toBe(inboxDir);
      expect(acquireInboxLock(pidfile, process.pid, defaultInboxLockDeps(), 1, 'readonly')).toBe(true);
      writeHeartbeat(heartbeatPathFor(inbox, root), 'readonly');
      expect(existsSync(pidfile)).toBe(true);
    } finally {
      chmodSync(inboxDir, 0o700);
    }
  });

  it('reclaims a nonce-matched wedged holder from the worktree root', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-wedged-root-'));
    const root = monitorStateRootForWorktree(dir);
    const inbox = '/home/test/.config/borgmcp/inboxes/cube/drone.log';
    ensureMonitorStateDir(root);
    const pidfile = pidfilePathFor(inbox, root);
    const heartbeat = heartbeatPathFor(inbox, root);
    writeFileSync(pidfile, `${process.pid}:wedged`, { mode: 0o600 });
    writeHeartbeat(heartbeat, 'wedged');
    const oldSeconds = (Date.now() - 10_000) / 1000;
    utimesSync(heartbeat, oldSeconds, oldSeconds);

    expect(acquireInboxLock(
      pidfile,
      process.pid,
      { ...defaultInboxLockDeps(), heartbeatStaleMs: 1_000 },
      3,
      'replacement'
    )).toBe(true);
  });

  it('rejects a symlinked .borgmcp ancestor before any external runtime write', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-symlink-root-'));
    const worktree = path.join(dir, 'worktree');
    const external = path.join(dir, 'external');
    mkdirSync(worktree);
    mkdirSync(external);
    symlinkSync(external, path.join(worktree, '.borgmcp'));

    expect(() => ensureMonitorStateDir(monitorStateRootForWorktree(worktree))).toThrow(/unsafe monitor state ancestor/i);
    expect(existsSync(path.join(external, 'inbox-monitor'))).toBe(false);
  });

  it('rejects a symlinked inbox-monitor root before any external runtime write', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-symlink-final-root-'));
    const worktree = path.join(dir, 'worktree');
    const external = path.join(dir, 'external');
    mkdirSync(worktree);
    mkdirSync(external);
    mkdirSync(path.join(worktree, '.borgmcp'));
    symlinkSync(external, path.join(worktree, '.borgmcp', 'inbox-monitor'));

    expect(() => ensureMonitorStateDir(monitorStateRootForWorktree(worktree))).toThrow(/unsafe monitor state ancestor/i);
    expect(existsSync(path.join(external, '.gitignore'))).toBe(false);
  });

  it('fails without changing a tracked non-Borg ignore file or creating runtime sidecars', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-tracked-ignore-'));
    execFileSync('git', ['init', '-q', dir]);
    const root = monitorStateRootForWorktree(dir);
    const ignorePath = path.join(root, '.gitignore');
    const inbox = '/home/test/.config/borgmcp/inboxes/cube/drone.log';
    mkdirSync(root, { recursive: true });
    writeFileSync(ignorePath, 'project-owned-ignore\n');
    chmodSync(ignorePath, 0o644);
    const rootModeBefore = statSync(root).mode & 0o777;
    execFileSync('git', ['-C', dir, 'add', '.borgmcp/inbox-monitor/.gitignore']);
    execFileSync('git', [
      '-C', dir,
      '-c', 'user.email=monitor-test@example.invalid',
      '-c', 'user.name=Monitor Test',
      'commit', '-qm', 'tracked monitor fixture',
    ]);

    expect(() => ensureMonitorStateDir(root)).toThrow(/not Borg-owned/i);
    expect(readFileSync(ignorePath, 'utf8')).toBe('project-owned-ignore\n');
    expect(statSync(ignorePath).mode & 0o777).toBe(0o644);
    expect(statSync(root).mode & 0o777).toBe(rootModeBefore);
    expect(existsSync(pidfilePathFor(inbox, root))).toBe(false);
    expect(existsSync(heartbeatPathFor(inbox, root))).toBe(false);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['-C', dir, 'diff', '--', '.borgmcp/inbox-monitor/.gitignore'], { encoding: 'utf8' })).toBe('');
  });

  it('rejects a tracked exact-content ignore collision with a foreign mode', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-ignore-mode-collision-'));
    execFileSync('git', ['init', '-q', dir]);
    const root = monitorStateRootForWorktree(dir);
    const ignorePath = path.join(root, '.gitignore');
    const inbox = '/home/test/.config/borgmcp/inboxes/cube/drone.log';
    mkdirSync(root, { recursive: true });
    writeFileSync(ignorePath, '*\n');
    chmodSync(ignorePath, 0o644);
    const rootModeBefore = statSync(root).mode & 0o777;
    execFileSync('git', ['-C', dir, 'add', '-f', '.borgmcp/inbox-monitor/.gitignore']);
    execFileSync('git', [
      '-C', dir,
      '-c', 'user.email=monitor-test@example.invalid',
      '-c', 'user.name=Monitor Test',
      'commit', '-qm', 'tracked monitor collision fixture',
    ]);

    expect(() => ensureMonitorStateDir(root)).toThrow(/unexpected mode/i);
    expect(readFileSync(ignorePath, 'utf8')).toBe('*\n');
    expect(statSync(ignorePath).mode & 0o777).toBe(0o644);
    expect(statSync(root).mode & 0o777).toBe(rootModeBefore);
    expect(existsSync(pidfilePathFor(inbox, root))).toBe(false);
    expect(existsSync(heartbeatPathFor(inbox, root))).toBe(false);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['-C', dir, 'diff', '--', '.borgmcp/inbox-monitor/.gitignore'], { encoding: 'utf8' })).toBe('');
  });

  it('refuses a pre-existing unmarked runtime root without changing its mode', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-unmarked-root-'));
    const root = monitorStateRootForWorktree(dir);
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);

    expect(() => ensureMonitorStateDir(root)).toThrow(/missing Borg ownership marker/i);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  it('accepts an exact Borg-owned ignore file idempotently', () => {
    dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'monitor-owned-ignore-'));
    const root = monitorStateRootForWorktree(dir);
    const ignorePath = path.join(root, '.gitignore');
    mkdirSync(root, { recursive: true });
    writeFileSync(ignorePath, '*\n');
    chmodSync(ignorePath, 0o600);

    expect(ensureMonitorStateDir(root)).toBe(root);
    expect(ensureMonitorStateDir(root)).toBe(root);
    expect(readFileSync(ignorePath, 'utf8')).toBe('*\n');
    expect(statSync(ignorePath).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('parses the explicit-root launch command without a TMPDIR/XDG fallback', () => {
    expect(parseMonitorInvocation([
      '--state-root',
      '/work/repo/.borgmcp/inbox-monitor',
      '/home/test/.config/borgmcp/inboxes/cube/drone.log',
    ])).toEqual({
      stateRoot: '/work/repo/.borgmcp/inbox-monitor',
      inboxPath: '/home/test/.config/borgmcp/inboxes/cube/drone.log',
    });
    expect(parseMonitorInvocation(['/home/test/.config/borgmcp/inboxes/cube/drone.log'])?.stateRoot).toBeNull();
    expect(parseMonitorInvocation(['--state-root', '/work/repo/.borgmcp/inbox-monitor'])).toBeNull();
  });
});

describe('acquireInboxLock — single-instance-per-inbox self-dedup (gh#795)', () => {
  // Models a single pidfile slot with atomic claim + compare-and-delete.
  function fakeLock(opts: { existing?: string | null; alivePids?: number[] } = {}) {
    let stored: string | null = opts.existing ?? null;
    const alive = new Set(opts.alivePids ?? []);
    const calls = { claim: 0, removeIfContent: 0, isAlive: [] as number[] };
    const deps: InboxLockDeps = {
      claim: (_p, content) => {
        calls.claim++;
        if (stored !== null) return false; // atomic create-iff-absent
        stored = content;
        return true;
      },
      read: () => stored,
      removeIfContent: (_p, expected) => {
        calls.removeIfContent++;
        if (stored === expected) stored = null; // compare-and-delete
      },
      isAlive: (pid) => {
        calls.isAlive.push(pid);
        return alive.has(pid);
      },
    };
    return { deps, calls, current: () => stored };
  }

  it('claims when no pidfile exists', () => {
    const lk = fakeLock({ existing: null });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps)).toBe(true);
    expect(lk.current()).toBe('100');
    expect(lk.calls.removeIfContent).toBe(0);
  });

  it('YIELDS to a live holder and NEVER touches it (the live one survives)', () => {
    const lk = fakeLock({ existing: '50', alivePids: [50] });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps)).toBe(false); // we yield
    expect(lk.calls.isAlive).toContain(50); // proved liveness
    expect(lk.calls.removeIfContent).toBe(0); // never reaped/killed the live holder
    expect(lk.current()).toBe('50'); // survivor IS the live holder, unchanged
  });

  it('reaps a provably-dead (ESRCH) pidfile and takes over', () => {
    const lk = fakeLock({ existing: '50', alivePids: [] }); // PID 50 not alive
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps)).toBe(true);
    expect(lk.calls.removeIfContent).toBe(1); // stale pidfile reaped
    expect(lk.current()).toBe('100'); // new owner claimed
  });

  it('treats an unparseable pidfile as stale → reap + claim', () => {
    const lk = fakeLock({ existing: 'not-a-pid', alivePids: [] });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps)).toBe(true);
    expect(lk.calls.removeIfContent).toBe(1);
    expect(lk.current()).toBe('100');
  });

  it('reaps a stray EMPTY pidfile (compare-and-delete) and claims', () => {
    const lk = fakeLock({ existing: '   ', alivePids: [] }); // whitespace-only
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps)).toBe(true);
    expect(lk.current()).toBe('100');
  });

  it('yields (safe default) under a persistent claim race rather than double-tail', () => {
    // claim always loses (a racer keeps re-creating); squatter PID is dead so we
    // keep retrying, but never win → yield after maxAttempts (never tail).
    const racey: InboxLockDeps = {
      claim: () => false,
      read: () => '999',
      removeIfContent: () => {},
      isAlive: () => false,
    };
    expect(acquireInboxLock('/inbox.pid', 1, racey, 3)).toBe(false);
  });

  it('reap-reclaim TOCTOU: a stale-premise reap never deletes the LIVE reclaimer pidfile', () => {
    // A reads dead PID 50; a racer B reclaims the pidfile LIVE (77) right after
    // A's read. A's compare-and-delete(expected='50') must NOT delete B's '77'.
    let stored: string | null = '50';
    const alive = new Set<number>(); // 50 dead
    let firstRead = true;
    const deps: InboxLockDeps = {
      claim: (_p, c) => {
        if (stored !== null) return false;
        stored = c;
        return true;
      },
      read: () => {
        const v = stored;
        if (firstRead) {
          firstRead = false; // simulate B reclaiming live between A's read + reap
          stored = '77';
          alive.add(77);
        }
        return v;
      },
      removeIfContent: (_p, expected) => {
        if (stored === expected) stored = null; // compare-and-delete
      },
      isAlive: (pid) => alive.has(pid),
    };
    expect(acquireInboxLock('/inbox.pid', 100, deps)).toBe(false); // A yields
    expect(stored).toBe('77'); // B's LIVE pidfile preserved — not stale-deleted
  });

  it('compare-and-delete release never deletes a successor live pidfile (double-release)', () => {
    // Our exit-handler release runs after a successor reclaimed the inbox.
    let stored: string | null = 'successor-77';
    const removeIfContent = (_p: string, expected: string) => {
      if (stored === expected) stored = null;
    };
    removeIfContent('/inbox.pid', '100'); // our PID, but pidfile now holds the successor
    expect(stored).toBe('successor-77'); // successor's live pidfile untouched
  });

  it('derives a per-inbox pidfile path', () => {
    expect(pidfilePathFor('/cfg/inboxes/cube/drone.log')).toBe(
      '/cfg/inboxes/cube/drone.log.monitor.pid'
    );
  });
});

describe('gh#979 legacy lock migration gate', () => {
  function legacyDeps(files: Map<string, string>, alivePids: number[] = []) {
    const alive = new Set(alivePids);
    return {
      exists: (path: string) => files.has(path),
      read: (path: string) => files.get(path) ?? null,
      isAlive: (pid) => alive.has(pid),
    };
  }

  it('yields to a live inbox-adjacent legacy holder before claiming new state', () => {
    const inbox = '/config/drone.log';
    const files = new Map([[legacyPidfilePathFor(inbox), '456:oldnonce']]);
    expect(legacyMonitorArtifactState(inbox, legacyDeps(files, [456]))).toBe('live');
    expect(files.get(legacyPidfilePathFor(inbox))).toBe('456:oldnonce');
  });

  it('treats a dead or malformed legacy artifact as blocked and leaves it untouched', () => {
    const inbox = '/config/drone.log';
    const pidfile = legacyPidfilePathFor(inbox);
    const heartbeat = `${inbox}.monitor.heartbeat`;
    const files = new Map([[pidfile, '456:oldnonce'], [heartbeat, 'oldnonce']]);
    expect(legacyMonitorArtifactState(inbox, legacyDeps(files))).toBe('blocked');
    expect(files.get(pidfile)).toBe('456:oldnonce');
    expect(files.get(heartbeat)).toBe('oldnonce');
  });

  it('preserves an old-successor legacy claim injected at the former read→claim gap', () => {
    let legacy: 'absent' | 'live' | 'blocked' = 'absent';
    let modernClaimed = false;
    let modernReleased = false;
    const result = claimModernMonitorSafely({
      claimMutation: () => true,
      releaseMutation: () => {},
      legacyState: () => legacy,
      claimModern: () => {
        // An old binary claims its inbox-adjacent pidfile after modern startup
        // has begun. Final revalidation must preserve it and yield.
        legacy = 'live';
        modernClaimed = true;
        return true;
      },
      releaseModern: () => {
        modernClaimed = false;
        modernReleased = true;
      },
    });
    expect(result).toBe('legacy-live');
    expect(modernClaimed).toBe(false);
    expect(modernReleased).toBe(true);
    expect(legacy).toBe('live');
  });

  it('yields on an occupied modern mutation lock before reading legacy state', () => {
    let inspectedLegacy = false;
    const result = claimModernMonitorSafely({
      claimMutation: () => false,
      releaseMutation: () => { throw new Error('must not release an unclaimed mutation lock'); },
      legacyState: () => {
        inspectedLegacy = true;
        return 'absent';
      },
      claimModern: () => { throw new Error('must not mutate without the mutation lock'); },
      releaseModern: () => { throw new Error('must not release without a modern claim'); },
    });
    expect(result).toBe('mutation-busy');
    expect(inspectedLegacy).toBe(false);
  });
});

describe('formatEventLine — valid entries', () => {
  it('extracts label + role + body for a short message', () => {
    const line =
      '2026-05-17T13:34:32.823Z drone-1 (Coordinator): SHIPPED: gh#74 + gh#55';
    expect(formatEventLine(line)).toBe(
      'drone-1 (Coordinator): SHIPPED: gh#74 + gh#55'
    );
  });

  it('extracts roles that contain spaces', () => {
    const line =
      '2026-05-17T13:36:14.520Z drone-3 (QA Tester): ACK: drone-1 dispatch';
    expect(formatEventLine(line)).toBe(
      'drone-3 (QA Tester): ACK: drone-1 dispatch'
    );
  });

  it('extracts labels with hyphens and numbers', () => {
    const line =
      '2026-05-17T13:34:32.823Z drone-12 (Builder): STARTING: feat/x';
    expect(formatEventLine(line)).toBe(
      'drone-12 (Builder): STARTING: feat/x'
    );
  });

  it('preserves entry_id prefixes for borg_ack use', () => {
    const line =
      '2026-05-17T13:34:32.823Z drone-12 (Builder): [entry_id: entry-123] DISPATCH: feat/x';
    expect(formatEventLine(line)).toBe(
      'drone-12 (Builder): [entry_id: entry-123] DISPATCH: feat/x'
    );
  });
});

describe('formatEventLine — pass-through (no truncation)', () => {
  // Claude Code does not impose a hard cap on task-notification title
  // length. The 200-char MAX_SUMMARY_LEN cap (and its 80-char
  // predecessor) were borg-mcp conventions built on a misunderstanding
  // of the renderer's limits. formatEventLine now passes the body
  // through verbatim regardless of length.
  it('passes bodies longer than 200 chars through without truncation', () => {
    const longBody = 'A'.repeat(400);
    const line = `2026-05-17T13:34:32.823Z drone-1 (Coordinator): ${longBody}`;
    const out = formatEventLine(line)!;
    expect(out).toBe(`drone-1 (Coordinator): ${longBody}`);
    expect(out).not.toContain('…');
  });

  it('passes exactly-200-char bodies through unchanged', () => {
    const exactBody = 'B'.repeat(200);
    const line = `2026-05-17T13:34:32.823Z drone-1 (Coordinator): ${exactBody}`;
    expect(formatEventLine(line)).toBe(
      `drone-1 (Coordinator): ${exactBody}`
    );
  });

  it('passes mid-length (150-char) bodies through unchanged', () => {
    const midBody = 'C'.repeat(150);
    const line = `2026-05-17T13:34:32.823Z drone-1 (Coordinator): ${midBody}`;
    expect(formatEventLine(line)).toBe(
      `drone-1 (Coordinator): ${midBody}`
    );
  });

  it('trims leading/trailing whitespace on the body', () => {
    const line =
      '2026-05-17T13:34:32.823Z drone-1 (Coordinator):    hello world   ';
    expect(formatEventLine(line)).toBe('drone-1 (Coordinator): hello world');
  });
});

describe('formatEventLine — drop cases', () => {
  it('returns null for continuation lines (no ISO timestamp)', () => {
    expect(formatEventLine('  - drone-2 CR primary')).toBeNull();
    expect(formatEventLine('## Verification')).toBeNull();
    expect(formatEventLine('')).toBeNull();
  });

  it('returns null for lines that look like entries but lack the parenthetical role', () => {
    expect(
      formatEventLine('2026-05-17T13:34:32.823Z drone-1: bare colon, no role')
    ).toBeNull();
  });

  it('returns null for lines with a non-ISO timestamp prefix', () => {
    expect(
      formatEventLine('2026/05/17 drone-1 (Coordinator): wrong date format')
    ).toBeNull();
  });
});

describe('formatEventLine — multi-line entry handling', () => {
  it('surfaces the first line of a multi-line entry and drops continuations', () => {
    // Simulate a multi-line message that the inbox writes as one
    // appendFile call with embedded \n — tail -F splits it into 3
    // physical lines, and our formatter should surface only the first.
    const lines = [
      '2026-05-17T13:34:32.823Z drone-1 (Coordinator): REVIEW-READY: feat/x',
      '',
      '## Verification on commit abc123:',
      '- foo',
      '- bar',
    ];
    const emitted = lines
      .map(formatEventLine)
      .filter((x): x is string => x !== null);
    expect(emitted).toEqual(['drone-1 (Coordinator): REVIEW-READY: feat/x']);
  });
});

describe('formatFreshEventLine — tail -F re-read dedup (gh#643)', () => {
  it('suppresses raw-line duplicates emitted when tail -F re-reads a rotated inbox', () => {
    const deduper = new RecentLineDeduper();
    const line =
      '2026-05-17T13:34:32.823Z drone-1 (Coordinator): [entry_id: e_1] DISPATCH: feat/x';

    expect(formatFreshEventLine(line, deduper)).toBe(
      'drone-1 (Coordinator): [entry_id: e_1] DISPATCH: feat/x'
    );
    expect(formatFreshEventLine(line, deduper)).toBeNull();
  });

  it('evicts old raw lines after the configured recent window', () => {
    const deduper = new RecentLineDeduper(2);
    const first =
      '2026-05-17T13:34:32.823Z drone-1 (Coordinator): first';
    const second =
      '2026-05-17T13:34:33.823Z drone-1 (Coordinator): second';
    const third =
      '2026-05-17T13:34:34.823Z drone-1 (Coordinator): third';

    expect(formatFreshEventLine(first, deduper)).not.toBeNull();
    expect(formatFreshEventLine(second, deduper)).not.toBeNull();
    expect(formatFreshEventLine(third, deduper)).not.toBeNull();
    expect(formatFreshEventLine(first, deduper)).not.toBeNull();
    expect(formatFreshEventLine(second, deduper)).not.toBeNull();
    expect(formatFreshEventLine(third, deduper)).not.toBeNull();
  });
});

describe('seedDeduperFromInboxTail — cold-start trim burst guard (gh#643)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('seeds recent valid inbox lines without emitting them', () => {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'inbox-monitor-seed-'));
    tmpDirs.push(dir);
    const inboxFile = path.join(dir, 'inbox.log');
    const older =
      '2026-05-17T13:34:30.823Z drone-1 (Coordinator): older';
    const keptA =
      '2026-05-17T13:34:31.823Z drone-1 (Coordinator): kept-a';
    const keptB =
      '2026-05-17T13:34:32.823Z drone-1 (Coordinator): kept-b';
    writeFileSync(inboxFile, [older, keptA, keptB].join('\n') + '\n');

    const deduper = new RecentLineDeduper();
    seedDeduperFromInboxTail(inboxFile, deduper, 2);

    expect(formatFreshEventLine(keptA, deduper)).toBeNull();
    expect(formatFreshEventLine(keptB, deduper)).toBeNull();
    expect(formatFreshEventLine(older, deduper)).not.toBeNull();
  });

  it('does not seed malformed lines that the monitor would not emit', () => {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'inbox-monitor-seed-'));
    tmpDirs.push(dir);
    const inboxFile = path.join(dir, 'inbox.log');
    const valid =
      '2026-05-17T13:34:32.823Z drone-1 (Coordinator): valid';
    const malformed = 'continuation without timestamp';
    writeFileSync(inboxFile, [malformed, valid].join('\n') + '\n');

    const deduper = new RecentLineDeduper();
    seedDeduperFromInboxTail(inboxFile, deduper, 2);

    expect(formatFreshEventLine(valid, deduper)).toBeNull();
    expect(formatFreshEventLine(malformed, deduper)).toBeNull();
  });

  it('tolerates a missing inbox file on first monitor start', () => {
    const deduper = new RecentLineDeduper();
    expect(() =>
      seedDeduperFromInboxTail('/tmp/borg-inbox-monitor-missing-file', deduper)
    ).not.toThrow();
  });
});

/**
 * gh#114: the bin entry guard previously compared argv[1] (npm-bin
 * symlink path) directly to fileURLToPath(import.meta.url) (realpath
 * of the installed module). Under `npm install`, the two diverge and
 * the equality fails → main() never runs → drones go deaf. These
 * tests pin the realpath-aware comparison.
 */
describe('isEntryInvocation — symlink vs realpath (gh#114)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // ESM module loading realpaths import.meta.url at load time. On
  // macOS, /tmp is itself a symlink to /private/tmp, so the test
  // fixture must mirror that resolution to match production semantics.
  const realTmp = realpathSync(tmpdir());

  it('returns true when argv[1] is a symlink resolving to the same file', () => {
    const dir = mkdtempSync(path.join(realTmp, 'inbox-monitor-test-'));
    tmpDirs.push(dir);
    const realFile = path.join(dir, 'inbox-monitor.js');
    writeFileSync(realFile, '// stub\n');
    const linkPath = path.join(dir, 'borg-inbox-monitor-link');
    symlinkSync(realFile, linkPath);
    const importMetaUrl = pathToFileURL(realFile).href;
    expect(isEntryInvocation(linkPath, importMetaUrl)).toBe(true);
  });

  it('returns true when argv[1] equals the realpath (no symlink)', () => {
    const dir = mkdtempSync(path.join(realTmp, 'inbox-monitor-test-'));
    tmpDirs.push(dir);
    const realFile = path.join(dir, 'inbox-monitor.js');
    writeFileSync(realFile, '// stub\n');
    const importMetaUrl = pathToFileURL(realFile).href;
    expect(isEntryInvocation(realFile, importMetaUrl)).toBe(true);
  });

  it('returns false when argv[1] resolves to a different file', () => {
    const dir = mkdtempSync(path.join(realTmp, 'inbox-monitor-test-'));
    tmpDirs.push(dir);
    const fileA = path.join(dir, 'a.js');
    const fileB = path.join(dir, 'b.js');
    writeFileSync(fileA, '// a\n');
    writeFileSync(fileB, '// b\n');
    const importMetaUrl = pathToFileURL(fileB).href;
    expect(isEntryInvocation(fileA, importMetaUrl)).toBe(false);
  });

  it('returns false when argv[1] does not exist (realpath throws)', () => {
    const importMetaUrl = pathToFileURL('/tmp/nonexistent.js').href;
    expect(isEntryInvocation('/tmp/this-path-does-not-exist-xyz', importMetaUrl)).toBe(false);
  });
});

/**
 * gh#114 end-to-end: spawn the actual built bin via a symlink (the
 * `npm install` shim shape) and verify `main()` ran — i.e. the tail
 * subprocess started instead of the binary silently exiting.
 *
 * Per drone-2 CR-axis gate (Sprint 11 PR D): unit tests on the
 * extracted helper aren't enough; the canonical bug surface is the
 * compiled dist invoked through a bin symlink. Skipped (not failed)
 * when `client/dist/inbox-monitor.js` is absent so test runs in
 * pre-build sandboxes don't false-fail.
 */
const __dirname_self = path.dirname(fileURLToPath(import.meta.url));
const DIST_BIN = path.join(__dirname_self, '..', 'dist', 'inbox-monitor.js');
const distExists = existsSync(DIST_BIN);
const distDescribe = distExists ? describe : describe.skip;

distDescribe('borg-inbox-monitor — end-to-end symlink spawn (gh#114)', () => {
  const tmpDirs: string[] = [];
  beforeAll(() => {
    // dist/ is intentionally untracked. Review worktrees can have a stale
    // client/dist/inbox-monitor.js from a prior build, so rebuild before this
    // dist-bin E2E or it may test old code instead of the checked-out source.
    execFileSync('npm', ['run', 'build'], {
      cwd: path.join(__dirname_self, '..'),
      stdio: 'ignore',
    });
  });

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps running (tail subprocess alive) when invoked via a symlinked bin shim', async () => {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'inbox-monitor-e2e-'));
    tmpDirs.push(dir);
    const inboxFile = path.join(dir, 'inbox.log');
    writeFileSync(inboxFile, '');
    const shim = path.join(dir, 'borg-inbox-monitor-shim');
    symlinkSync(DIST_BIN, shim);

    const proc = spawn(process.execPath, [shim, inboxFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Pre-fix: the bin exits ~0 within a few ms (silent no-op).
    // Post-fix: tail -F keeps the process alive until killed.
    const exitedEarly = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 600);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });

    const exitedAfterKill = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1000);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    proc.kill('SIGTERM');

    expect(await exitedAfterKill).toBe(true);
    expect(exitedEarly).toBe(false);
    if (process.platform !== 'win32') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      let processList = '';
      try {
        processList = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' });
      } catch (err: any) {
        if (err?.code === 'EPERM') return;
        throw err;
      }
      expect(processList).not.toContain(inboxFile);
    }
  });

  it('keeps running from an explicit worktree state root when the config inbox is read-only', async () => {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'inbox-monitor-e2e-state-root-'));
    tmpDirs.push(dir);
    const inboxDir = path.join(dir, 'read-only-config-inboxes');
    const inboxFile = path.join(inboxDir, 'inbox.log');
    const worktree = path.join(dir, 'worktree');
    mkdirSync(worktree);
    const stateRoot = monitorStateRootForWorktree(worktree);
    ensureInboxDir(inboxFile);
    writeFileSync(inboxFile, '');
    chmodSync(inboxDir, 0o500);

    const proc = spawn(process.execPath, [
      DIST_BIN,
      '--state-root',
      stateRoot,
      inboxFile,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const exitedEarly = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 600);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    const exitedAfterKill = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1000);
      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    const stateClaimedBeforeShutdown = existsSync(pidfilePathFor(inboxFile, stateRoot));
    const heartbeatClaimedBeforeShutdown = existsSync(heartbeatPathFor(inboxFile, stateRoot));
    const legacyClaimedBeforeShutdown = existsSync(legacyPidfilePathFor(inboxFile));
    proc.kill('SIGTERM');

    try {
      expect(exitedEarly, stderr).toBe(false);
      expect(await exitedAfterKill).toBe(true);
      expect(stateClaimedBeforeShutdown).toBe(true);
      expect(heartbeatClaimedBeforeShutdown).toBe(true);
      expect(legacyClaimedBeforeShutdown).toBe(false);
      expect(stderr).toBe('');
    } finally {
      chmodSync(inboxDir, 0o700);
    }
  });

  it('fails loud and preserves a stale legacy artifact instead of racing a cross-version handoff', async () => {
    const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'inbox-monitor-e2e-legacy-veto-'));
    tmpDirs.push(dir);
    const inboxDir = path.join(dir, 'config-inboxes');
    const inboxFile = path.join(inboxDir, 'inbox.log');
    const worktree = path.join(dir, 'worktree');
    mkdirSync(worktree);
    const stateRoot = monitorStateRootForWorktree(worktree);
    ensureInboxDir(inboxFile);
    writeFileSync(inboxFile, '');
    writeFileSync(legacyPidfilePathFor(inboxFile), '99999999:stale');

    const proc = spawn(process.execPath, [DIST_BIN, '--state-root', stateRoot, inboxFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('legacy monitor artifact remains');
    expect(existsSync(legacyPidfilePathFor(inboxFile))).toBe(true);
    expect(existsSync(pidfilePathFor(inboxFile, stateRoot))).toBe(false);
  });
});

describe('evaluateInboxTailStall — gh#822 subclass B (false-reap-safe stall detect)', () => {
  const THRESH = 150_000; // ≥5× a 30s tick — conservative/GC-safe
  const st = (lastEmittedOffset: number, grewSince: number | null = null): TailStallState => ({
    lastEmittedOffset,
    grewSince,
  });

  it('INIT (CR item 1): size == offset (holder seeded to EOF at arm) → ok, NO respawn', () => {
    // A fresh holder seeds lastEmittedOffset to the file size at arm — so a
    // non-empty inbox does NOT look like un-emitted growth on the first tick.
    const v = evaluateInboxTailStall(4096, st(4096), 1_000_000, THRESH);
    expect(v.kind).toBe('ok');
    expect(v.state.grewSince).toBeNull();
  });

  it('QUIET cube: no growth → ok, clears any streak (a silent cube can never trip a respawn)', () => {
    const v = evaluateInboxTailStall(4096, st(4096, 500_000), 1_000_000, THRESH);
    expect(v.kind).toBe('ok');
    expect(v.state.grewSince).toBeNull();
  });

  it('ROTATION (CR item 2): size < offset → rotation, re-anchor to NEW size, NOT negative growth / NOT respawn', () => {
    const v = evaluateInboxTailStall(120, st(4096, 800_000), 1_000_000, THRESH);
    expect(v.kind).toBe('rotation');
    expect(v.state.lastEmittedOffset).toBe(120); // re-anchored to the new (smaller) size
    expect(v.state.grewSince).toBeNull(); // streak cleared — the rotation is the fix point
  });

  it('SLOW grow (not sustained) → ok, NOT respawn — starts the streak but holds', () => {
    const v = evaluateInboxTailStall(5000, st(4096), 1_000_000, THRESH);
    expect(v.kind).toBe('ok');
    expect(v.state.grewSince).toBe(1_000_000); // streak begins now
  });

  it('SLOW grow continuing under threshold → still ok (streak carried, not yet past threshold)', () => {
    const v = evaluateInboxTailStall(5000, st(4096, 1_000_000), 1_000_000 + THRESH - 1, THRESH);
    expect(v.kind).toBe('ok');
    expect(v.state.grewSince).toBe(1_000_000); // same streak
  });

  it('SUSTAINED un-emitted growth past threshold → respawn (the stall is real)', () => {
    const v = evaluateInboxTailStall(5000, st(4096, 1_000_000), 1_000_000 + THRESH, THRESH);
    expect(v.kind).toBe('respawn');
  });

  it('growth then caught-up (tail delivered, offset re-anchored) → ok, streak cleared before it could fire', () => {
    // tick N: grew (streak starts)
    let v = evaluateInboxTailStall(5000, st(4096), 1_000_000, THRESH);
    expect(v.kind).toBe('ok');
    // tail delivers → the holder re-anchors lastEmittedOffset to 5000 (caller's job);
    // tick N+1: size == offset → streak cleared, no respawn despite earlier growth.
    v = evaluateInboxTailStall(5000, st(5000, v.state.grewSince), 1_000_000 + THRESH, THRESH);
    expect(v.kind).toBe('ok');
    expect(v.state.grewSince).toBeNull();
  });

  it('rotation DURING an active streak → rotation wins (re-anchor + clear), never a respawn', () => {
    const v = evaluateInboxTailStall(80, st(4096, 1_000_000), 1_000_000 + THRESH + 1, THRESH);
    expect(v.kind).toBe('rotation'); // shrink takes precedence over the stale streak
    expect(v.state.grewSince).toBeNull();
  });
});

describe('tailArgsFor — gh#822 arm vs recovery byte-seek (CR item 3)', () => {
  it('ARM (fromByteOffset null) → tail -F -n 0 (skip history)', () => {
    expect(tailArgsFor('/inbox.log', null)).toEqual(['-F', '-n', '0', '/inbox.log']);
  });

  it('RECOVERY → byte-seek `-c +<N+1>` from the last delivered offset, NOT -n 0', () => {
    // The un-emitted bytes a stalled tail dropped are [offset .. EOF]; re-read
    // them FORWARD via -c +<offset+1>. -n 0 would start at the new EOF and skip
    // exactly those bytes (silent data loss = the recovery that drops entries).
    expect(tailArgsFor('/inbox.log', 4096)).toEqual(['-F', '-c', '+4097', '/inbox.log']);
    expect(tailArgsFor('/inbox.log', 0)).toEqual(['-F', '-c', '+1', '/inbox.log']); // whole file
    expect(tailArgsFor('/inbox.log', 4096)).not.toContain('-n'); // never -n 0 on recovery
  });
});

describe('shared deduper across respawn — gh#822 no double-emit (CR item 3)', () => {
  it('a re-read already-emitted line is suppressed by the SHARED deduper', () => {
    // On self-heal respawn the holder reuses the SAME deduper, so a line the
    // byte-seek happens to re-read (already emitted by the stalled tail) is
    // deduped, while genuinely-new un-emitted lines still pass.
    const deduper = new RecentLineDeduper();
    const emitted = '2026-05-17T13:34:32.823Z drone-1 (Builder): STARTING: feat/x';
    const fresh = '2026-05-17T13:35:00.000Z drone-2 (Coordinator): DISPATCH: feat/y';

    expect(formatFreshEventLine(emitted, deduper)).not.toBeNull(); // first emit
    // respawn re-reads the same line → suppressed (no double wake):
    expect(formatFreshEventLine(emitted, deduper)).toBeNull();
    // a genuinely-new un-emitted line still flows (the recovery's whole point):
    expect(formatFreshEventLine(fresh, deduper)).not.toBeNull();
  });
});

describe('gh#840 node-wedge cross-instance reap (acquireInboxLock)', () => {
  const STALE = 1000;
  // a fake pidfile slot + injected heartbeat/clock for the wedge path
  function fakeWedgeLock(opts: {
    existing: string;
    alivePids: number[];
    heartbeat: { mtimeMs: number; nonce: string } | null;
    now: number;
    staleMs?: number;
  }) {
    let stored: string | null = opts.existing;
    const alive = new Set(opts.alivePids);
    const calls = { removeIfContent: 0 };
    const deps: InboxLockDeps = {
      claim: (_p, content) => {
        if (stored !== null) return false;
        stored = content;
        return true;
      },
      read: () => stored,
      removeIfContent: (_p, expected) => {
        calls.removeIfContent++;
        if (stored === expected) stored = null;
      },
      isAlive: (pid) => alive.has(pid),
      readHeartbeat: () => opts.heartbeat,
      now: () => opts.now,
      heartbeatStaleMs: opts.staleMs ?? STALE,
    };
    return { deps, calls, current: () => stored };
  }

  it('REAPS a wedged holder: kill-0 ALIVE + heartbeat STALE + nonce MATCHES', () => {
    const lk = fakeWedgeLock({
      existing: '50:nonceA',
      alivePids: [50],
      heartbeat: { mtimeMs: 0, nonce: 'nonceA' },
      now: STALE + 1, // age STALE+1 ≥ STALE → stale
    });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps, 3, 'nonceNew')).toBe(true);
    expect(lk.calls.removeIfContent).toBe(1); // wedged pidfile compare-and-deleted
    expect(lk.current()).toBe('100:nonceNew'); // reaper claimed with its own identity
  });

  it('NEVER reaps a healthy holder: kill-0 ALIVE + heartbeat FRESH', () => {
    const lk = fakeWedgeLock({
      existing: '50:nonceA',
      alivePids: [50],
      heartbeat: { mtimeMs: STALE, nonce: 'nonceA' },
      now: STALE + 1, // age 1 < STALE → fresh
    });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps, 3, 'nonceNew')).toBe(false);
    expect(lk.calls.removeIfContent).toBe(0);
    expect(lk.current()).toBe('50:nonceA'); // survivor untouched
  });

  it('PID-REUSE pin: heartbeat STALE + kill-0 ALIVE but nonce MISMATCH → NOT reaped', () => {
    const lk = fakeWedgeLock({
      existing: '50:nonceA', // pidfile holder identity A
      alivePids: [50], // PID 50 alive (recycled/foreign or young reclaimer)
      heartbeat: { mtimeMs: 0, nonce: 'nonceB' }, // stale heartbeat from a DIFFERENT identity B
      now: STALE + 1,
    });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps, 3, 'nonceNew')).toBe(false);
    expect(lk.calls.removeIfContent).toBe(0); // identity ambiguous → NEVER reap
    expect(lk.current()).toBe('50:nonceA');
  });

  it('a legacy no-nonce LIVE holder is never wedge-reaped (back-compat)', () => {
    const lk = fakeWedgeLock({
      existing: '50', // legacy pidfile, no nonce
      alivePids: [50],
      heartbeat: { mtimeMs: 0, nonce: 'anything' },
      now: STALE + 1,
    });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps, 3, 'nonceNew')).toBe(false);
    expect(lk.calls.removeIfContent).toBe(0);
  });

  it('no heartbeat sidecar → never wedge-reap (err toward keeping)', () => {
    const lk = fakeWedgeLock({
      existing: '50:nonceA',
      alivePids: [50],
      heartbeat: null,
      now: STALE + 1,
    });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps, 3, 'nonceNew')).toBe(false);
    expect(lk.calls.removeIfContent).toBe(0);
  });

  it('a DEAD holder is still reaped regardless of heartbeat (existing #795 path intact)', () => {
    const lk = fakeWedgeLock({
      existing: '50:nonceA',
      alivePids: [], // PID 50 dead
      heartbeat: { mtimeMs: STALE, nonce: 'nonceA' }, // even a fresh heartbeat
      now: STALE + 1,
    });
    expect(acquireInboxLock('/inbox.pid', 100, lk.deps, 3, 'nonceNew')).toBe(true);
    expect(lk.calls.removeIfContent).toBe(1);
  });
});

describe('gh#840 parsePidfileContent', () => {
  it('legacy bare pid → { pid, nonce: null }', () => {
    expect(parsePidfileContent('1234')).toEqual({ pid: 1234, nonce: null });
  });
  it('pid:nonce → { pid, nonce }', () => {
    expect(parsePidfileContent('1234:deadbeefcafe')).toEqual({ pid: 1234, nonce: 'deadbeefcafe' });
  });
});

describe('gh#840 writeHeartbeat / readHeartbeatSidecar round-trip', () => {
  it('writes the nonce to the heartbeat sidecar and reads { mtimeMs, nonce } back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'borg-hb-'));
    try {
      const inboxPath = path.join(dir, 'd.log');
      writeHeartbeat(heartbeatPathFor(inboxPath), 'nonceXYZ');
      const hb = readHeartbeatSidecar(pidfilePathFor(inboxPath));
      expect(hb).not.toBeNull();
      expect(hb!.nonce).toBe('nonceXYZ');
      expect(typeof hb!.mtimeMs).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the heartbeat sidecar is absent', () => {
    expect(readHeartbeatSidecar('/no/such/inbox.log.monitor.pid')).toBeNull();
  });
});
