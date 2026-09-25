// Controlled local SSE transport; real command, storage, parser and lease.
const commands = await import(process.env.REPRESENTATIVE_TEST_DIST ?? '../../src/representative-cmd.js');
import { createRepresentativeStore } from '../../src/representative-store.js';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
const { DroneEvictedError } = await import(process.env.REPRESENTATIVE_TEST_DIST ? join(dirname(process.env.REPRESENTATIVE_TEST_DIST), 'drone-lifecycle.js') : '../../src/drone-lifecycle.js');
const { createPinnedServerFetch } = await import(process.env.REPRESENTATIVE_TEST_DIST ? join(dirname(process.env.REPRESENTATIVE_TEST_DIST), 'server-trust.js') : '../../src/server-trust.js');
import { bindingFor, MockCube, ROLE_REP } from './representative-mock-backend.js';
const [worktree, file, origin, action = 'listen', replayAfter] = process.argv.slice(2);
const binding = bindingFor(worktree, { origin });
const store = createRepresentativeStore(file);
const cube = new MockCube();
const deps = {
  cwd: () => worktree, findProjectRoot: (value: string) => value,
  hydrateSeat: async () => ({ cubeId: action === 'rebound' ? '99999999-9999-4999-8999-999999999999' : binding.cubeId, droneId: binding.representativeDroneId,
    apiUrl: origin, serverTrustIdentity: binding.trustIdentity, sessionToken: 'fixture-only',
    roleId: ROLE_REP, worktree, droneLabel: binding.representativeLabel }),
  backendFor: () => { const backend = cube.backend(); if (action === 'evicted') backend.whoami = async () => { throw new DroneEvictedError(); }; return backend; }, store,
  prepareSeat: async () => { throw new Error('not used'); },
  stdout: (text: string) => { process.stdout.write(text); },
  stderr: (text: string) => { process.stderr.write(text); },
};
if (action === 'status') process.exitCode = await commands.runRepresentativeStatus({ action, worktree }, deps as any);
else if (action === 'mcp') process.exitCode = await commands.runRepresentativeMcp({ action, worktree }, deps as any, { version: 'fixture' });
else {
  // Missing on the base: the RED run must fail rather than substituting an implementation.
  const run = (commands as any).runRepresentativeListen;
  if (!run) throw new Error('representative listen is not implemented');
  // Production transport when a pinned certificate is supplied; plain HTTP otherwise.
  const pinnedCert = process.env.REPRESENTATIVE_TEST_PIN_CERT;
  const fetchImpl = pinnedCert ? createPinnedServerFetch(origin, await readFile(pinnedCert, 'utf8')) : globalThis.fetch;
  process.exitCode = await run({ action: 'listen', worktree, ...(replayAfter ? { replayAfter } : {}) }, deps, {
    streamDeps: { fetchImpl, loadTrust: async () => ({
      identity: action === 'trust-changed' ? 'changed-trust' : await readFile(join(worktree, 'fixture-trust'), 'utf8').catch(() => binding.trustIdentity), fetchImpl,
    }) }, heartbeatIntervalMs: 500,
    reconnectDelay: () => 10,
  });
}
