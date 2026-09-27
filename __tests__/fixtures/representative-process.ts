// Real stdio entrypoint with an IPC-controlled backend; never contacts a server.
import { runRepresentativeMcp } from '../../src/representative-cmd.js';
import { createRepresentativeStore } from '../../src/representative-store.js';
import { bindingFor, ROLE_REP } from './representative-mock-backend.js';
import type { RepresentativeBackend } from '../../src/representative-core.js';
import { DroneEvictedError } from '../../src/drone-lifecycle.js';

const worktree = process.argv[2];
const store = createRepresentativeStore(process.argv[3]);
const binding = bindingFor(worktree);
let nextId = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
process.on('message', (message: any) => {
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(message.error.code === 'DRONE_EVICTED'
    ? new DroneEvictedError() : Object.assign(new Error(message.error.message), message.error));
  else waiter.resolve(message.result);
});
const backend = Object.fromEntries(['whoami', 'roster', 'append', 'readAfter', 'unreadCursor', 'readEntry', 'ack'].map((method) => [
  method, (...args: unknown[]) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    process.send!({ id, method, args });
  }),
])) as unknown as RepresentativeBackend;
const code = await runRepresentativeMcp({ action: 'mcp', worktree }, {
  cwd: () => worktree, findProjectRoot: (dir) => dir,
  hydrateSeat: async () => ({
    cubeId: binding.cubeId, cubeName: binding.cubeName,
    droneId: binding.representativeDroneId, droneLabel: binding.representativeLabel,
    roleId: ROLE_REP, roleName: binding.representativeRoleName,
    apiUrl: binding.origin, serverTrustIdentity: binding.trustIdentity,
    sessionToken: 'isolated-fixture-token',
  }) as any,
  prepareSeat: async () => { throw new Error('preparation not part of this fixture'); },
  backendFor: () => backend, store,
  stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text),
}, { version: '0.0.0-test', heartbeatIntervalMs: process.argv[4] ? Number(process.argv[4]) : undefined });
process.disconnect?.();
process.exitCode = code;
