/**
 * gh#793 — GC orphaned inbox files left by evicted/dead drones.
 *
 * The SSE cap-trim (`appendCappedInboxLine` → `trimInboxFileToRecentLines`)
 * BOUNDS a live inbox file but never DELETES it, so an evicted/dead drone's
 * `inboxes/<cube_id>/<drone_id>.log` (+ its worktree-runtime PID/heartbeat
 * state) lingers forever. This GC removes those orphan artifacts,
 * lazy-on-assimilate (no cron, no new command).
 *
 * THE INVIOLABLE RULE (CR live-safety gate): NEVER unlink an inbox with a live
 * holder. Deleting a `.log` that a live #822 monitor is tailing leaves no inode
 * to re-follow → HARD permanent deafness (a wrong delete is unrecoverable; a
 * missed orphan is a harmless stale file). So we veto on ANY live signal and
 * always err toward KEEPING.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pidfilePathFor, heartbeatPathFor, legacyPidfilePathFor, legacyHeartbeatPathFor, HEARTBEAT_STALE_MS, } from './inbox-monitor.js';
/** §8.2 staleness threshold — ≥30 days; conservative, well beyond any plausible offline period. */
export const ORPHAN_INBOX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Pure, FS-free selection (mirrors the `acquireInboxLock` dep-injection style so
 * the live-safety + staleness logic is unit-pinned without touching the FS).
 *
 * An inbox is GC-eligible ONLY when ALL hold:
 *   §2  NO live holder              — `isLive` false (the absolute gate; one live signal vetoes)
 *   §3  mtime stale past `staleMs`  — the staleness belt (always required, even for evicted)
 *   §3.2 not a current roster member — `droneState` !== 'present' (roster bonus; 'absent' by default)
 */
export function selectOrphanInboxes(args) {
    const { entries, isLive, droneState, now, staleMs } = args;
    return entries.filter((e) => {
        if (isLive(e.inboxPath))
            return false; // §2 INVIOLABLE — any live holder → KEEP
        if (now - e.mtimeMs < staleMs)
            return false; // §3 staleness belt
        return droneState(e.droneId) !== 'present'; // §3.2 never reap a current member
    });
}
/**
 * §2 live-safety check — the HARD gate. LIVE if ANY of three INDEPENDENT signals
 * fire (so a single positive vetoes the delete):
 *   1. a raw `tail` pgrep match (a wedged-but-present tail still holds the inode → KEEP)
 *   2. a heartbeat sidecar present AND fresh (within the stale threshold)
 *   3. a pidfile whose PID is alive (kill-0)
 */
export function isInboxLive(inboxPath, deps, monitorStateRoot) {
    if (deps.pgrepTailMatch(inboxPath))
        return true;
    const staleMs = deps.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
    const heartbeatPaths = [heartbeatPathFor(inboxPath, monitorStateRoot)];
    const pidfilePaths = [pidfilePathFor(inboxPath, monitorStateRoot)];
    if (monitorStateRoot) {
        // Migration safety: an old inbox-adjacent holder is still a live veto.
        heartbeatPaths.push(legacyHeartbeatPathFor(inboxPath));
        pidfilePaths.push(legacyPidfilePathFor(inboxPath));
    }
    for (const heartbeatPath of new Set(heartbeatPaths)) {
        const hbMs = deps.readHeartbeatMtimeMs(heartbeatPath);
        if (hbMs !== null && deps.now - hbMs < staleMs)
            return true;
    }
    for (const pidfilePath of new Set(pidfilePaths)) {
        const pid = deps.readPidfilePid(pidfilePath);
        if (pid !== null && deps.isAlive(pid))
            return true;
    }
    return false;
}
/**
 * Wire the GC for one cube dir: select orphans (excluding the just-assimilated
 * drone), then unlink each orphan's inbox plus its derived worktree-runtime
 * PID/heartbeat state. Legacy inbox-adjacent artifacts are intentionally left
 * for explicit operator cleanup: GC must never race an old binary that does
 * not participate in modern state serialization. Best-effort — every unlink is
 * swallowed per-file so a
 * single failure never aborts the sweep or blocks assimilate. Returns the paths
 * actually removed. Never rmdir's the cube dir (a live sibling may use it).
 */
export function gcOrphanInboxesForCube(args) {
    const { cubeInboxDir, selfDroneId, monitorStateRoot, deps } = args;
    const entries = deps.listInboxLogs(cubeInboxDir).filter((e) => e.droneId !== selfDroneId);
    const orphans = selectOrphanInboxes({
        entries,
        isLive: deps.isLive,
        droneState: deps.droneState,
        now: deps.now,
        staleMs: deps.staleMs,
    });
    const removed = [];
    for (const o of orphans) {
        const sidecars = [
            pidfilePathFor(o.inboxPath, monitorStateRoot),
            heartbeatPathFor(o.inboxPath, monitorStateRoot),
        ];
        for (const p of new Set([o.inboxPath, ...sidecars])) {
            try {
                deps.unlink(p);
                removed.push(p);
            }
            catch {
                /* best-effort: sidecar may be absent / unlink may race — never abort the sweep */
            }
        }
    }
    return removed;
}
/** Real FS/process-backed deps, reusing the #795/#822 primitives. */
export function defaultInboxLivenessDeps(now = Date.now()) {
    return {
        pgrepTailMatch: (inboxPath) => {
            try {
                // raw presence: a tail following <inboxPath> (heartbeat-independent —
                // a wedged tail still holds the inode, so its mere presence vetoes).
                const res = spawnSync('pgrep', ['-f', inboxPath], { encoding: 'utf-8', timeout: 2_000 });
                if (res.error)
                    return false; // no pgrep (other platform) → defer to heartbeat/pid signals
                return res.status === 0 && res.stdout.trim().length > 0;
            }
            catch {
                return false;
            }
        },
        readHeartbeatMtimeMs: (heartbeatPath) => {
            try {
                return statSync(heartbeatPath).mtimeMs;
            }
            catch {
                return null;
            }
        },
        readPidfilePid: (pidfilePath) => {
            try {
                const pid = Number.parseInt(readFileSync(pidfilePath, 'utf8').trim(), 10);
                return Number.isNaN(pid) ? null : pid;
            }
            catch {
                return null;
            }
        },
        isAlive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            }
            catch (err) {
                return err?.code === 'EPERM'; // exists but unsignalable → still alive
            }
        },
        now,
    };
}
/** Real directory lister: `<drone_id>.log` files only (skips `.monitor.*` sidecars). */
export function defaultListInboxLogs(cubeInboxDir) {
    let names;
    try {
        names = readdirSync(cubeInboxDir);
    }
    catch {
        return []; // cube dir absent → nothing to GC
    }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.log'))
            continue; // exclude .monitor.pid / .monitor.heartbeat
        const inboxPath = join(cubeInboxDir, name);
        try {
            out.push({ droneId: name.slice(0, -'.log'.length), inboxPath, mtimeMs: statSync(inboxPath).mtimeMs });
        }
        catch {
            /* vanished mid-scan → skip */
        }
    }
    return out;
}
//# sourceMappingURL=gc-orphan-inboxes.js.map