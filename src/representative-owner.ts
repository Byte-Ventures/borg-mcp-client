/** Lifecycle adapter for the existing stream lease; no separate lock protocol. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { borgConfigRoot, borgHomeRoot } from './private-root.js';
import {
  acquireStreamLease, readOwnershipSnapshot, STREAM_OWNER_STALE_MS,
  type StreamLease, type StreamOwnerDeps, type StreamOwnershipSnapshot,
} from './stream-owner.js';
import { RepresentativeError } from './representative-core.js';
import type { RepresentativeBinding } from './representative-store.js';

export function representativeOwnerDeps(binding: RepresentativeBinding): StreamOwnerDeps {
  const authority = createHash('sha256').update(JSON.stringify([binding.origin, binding.trustIdentity])).digest('hex');
  return {
    // Separate from stream-locks, which borg_stream-status inspects. One lease
    // across all worktrees using this authority/cube/drone, never one per host.
    locksDir: join(borgConfigRoot(), 'representative-host-locks', authority),
    privateRoot: { root: borgConfigRoot(), boundary: borgHomeRoot() },
    worktree: binding.worktree, droneLabel: binding.representativeLabel, cubeName: binding.cubeName,
  };
}

export function representativeOwnership(binding: RepresentativeBinding): Promise<StreamOwnershipSnapshot> {
  return privateStorage(() => readOwnershipSnapshot(binding.cubeId, binding.representativeDroneId, representativeOwnerDeps(binding)));
}

async function privateStorage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof RepresentativeError) throw error;
    throw new RepresentativeError('REPRESENTATIVE_OWNERSHIP_REQUIRED',
      'Representative lease storage refused: ' + (error instanceof Error ? error.message : 'invalid private state'));
  }
}

export function createRepresentativeOwner(heartbeatIntervalMs = 20_000) {
  let lease: StreamLease | null = null;
  let selected: RepresentativeBinding | undefined;
  let deps: StreamOwnerDeps;
  let lost = false, closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const processNonce = randomUUID();
  // Serialize lease mutations, including heartbeats, but NOT tool execution:
  // overlapping sends still use the existing atomic request reservation.
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const result = tail.then(op);
    tail = result.catch(() => {});
    return result;
  };
  const snapshot = (binding: RepresentativeBinding) => privateStorage(() => readOwnershipSnapshot(
    binding.cubeId, binding.representativeDroneId,
    { ...representativeOwnerDeps(binding), processNonce },
  ));
  const refuse = async (binding: RepresentativeBinding): Promise<never> => {
    const owner = await snapshot(binding);
    throw new RepresentativeError(
      'REPRESENTATIVE_OWNERSHIP_REQUIRED',
      `This representative is owned by another MCP process (pid ${owner.pid ?? 'unknown'}, started ${owner.startedAt ?? 'unknown'}), ` +
      'or this process lost its lease. Use the owning host; after it exits or its lease expires, retry from the intended host. ' +
      'Restart a process that lost ownership before using it again. Status remains available.',
      { owner },
    );
  };
  const refresh = async () => {
    try {
      if (!lease || !await lease.refresh()) lost = true;
    } catch { lost = true; }
    if (lost && timer) { clearInterval(timer); timer = undefined; }
  };
  return {
    snapshot,
    ensure: (binding: RepresentativeBinding) => serial(async () => {
      if (selected && (selected.origin !== binding.origin || selected.trustIdentity !== binding.trustIdentity ||
          selected.cubeId !== binding.cubeId || selected.representativeDroneId !== binding.representativeDroneId)) lost = true;
      if (closed || lost) return refuse(binding);
      if (lease) {
        await refresh();
        if (lost) return refuse(binding);
        return;
      }
      deps = { ...representativeOwnerDeps(binding), processNonce };
      lease = await privateStorage(() => acquireStreamLease(binding.cubeId, binding.representativeDroneId, STREAM_OWNER_STALE_MS, deps));
      if (!lease) return refuse(binding);
      selected = binding;
      timer = setInterval(() => { void serial(refresh); }, heartbeatIntervalMs);
      timer.unref();
    }),
    close: () => serial(async () => {
      closed = true;
      if (timer) { clearInterval(timer); timer = undefined; }
      await lease?.release();
      lease = null;
    }),
  };
}
