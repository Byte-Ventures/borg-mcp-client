import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  __setServerKeychainLockHooksForTest,
  __setServerCredentialBackendForTest,
  getOrCreatePendingServerCubeCreation,
  getOrCreatePendingServerEnrollment,
} from '../../src/config.js';
import type { TokenBackend } from '../../src/token-store.js';
import { enrollBorgServer, resumeBorgServerEnrollment } from '../../src/server-handshake.js';

const stateFile = process.env.BORG_TEST_KEYCHAIN_STATE;
const mode = process.argv[2];
if (!stateFile || !['enrollment', 'cube', 'ambiguous', 'resume'].includes(mode ?? '')) {
  throw new Error('invalid pending-concurrency child invocation');
}

const hookDirectory = process.env.BORG_TEST_LOCK_HOOK_DIR;
const hookRelease = process.env.BORG_TEST_LOCK_HOOK_RELEASE;
const hookStage = process.env.BORG_TEST_LOCK_HOOK_STAGE;
if (
  hookDirectory &&
  ['stat', 'stale', 'cleanup', 'claim-read', 'owner-crash', 'claim-crash', 'active-crash']
    .includes(hookStage ?? '')
) {
  const markReady = async () => {
    await mkdir(hookDirectory, { recursive: true });
    await writeFile(join(hookDirectory, `${hookStage}-${process.pid}`), 'ready');
  };
  const pause = async () => {
    await markReady();
    if (!hookRelease) throw new Error('lock hook release path is required');
    for (;;) {
      try {
        await access(hookRelease);
        return;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
  };
  const crash = async () => {
    await markReady();
    process.exit(0);
  };
  __setServerKeychainLockHooksForTest(hookStage === 'stat'
    ? { afterStaleStat: pause }
    : hookStage === 'stale'
      ? { afterStaleInspection: pause }
      : hookStage === 'cleanup'
        ? { beforeOwnerCleanup: pause }
        : hookStage === 'claim-read'
          ? { afterActiveClaimRead: pause }
        : hookStage === 'owner-crash'
          ? { beforeOwnerCleanup: crash }
          : hookStage === 'claim-crash'
            ? { afterReaperClaim: crash }
            : { afterActiveReaperElection: crash });
}

async function readState(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

const backend: TokenBackend = {
  name: 'keychain',
  get: async (account) => (await readState())[account] ?? null,
  set: async (account, value) => {
    // Deliberately widen the backend's get→set race. Correctness must come from
    // config.ts's cross-process authority/repository lock, not this test store.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    const state = await readState();
    state[account] = value;
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  },
  delete: async (account) => {
    const state = await readState();
    delete state[account];
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  },
};
__setServerCredentialBackendForTest(backend);

const common = {
  origin: 'https://localhost:8787',
  trustIdentity: 'sha256:server-a',
};
const enrollmentInput = {
  ...common,
  invitation: 'i'.repeat(43),
  clientName: 'operator-laptop',
};

if (mode === 'ambiguous') {
  const bodies: unknown[] = [];
  try {
    await enrollBorgServer(common.origin, common.trustIdentity, enrollmentInput.invitation, {
      clientName: enrollmentInput.clientName,
      fetchImpl: (async (_input, init) => {
        // Preflight-first: the credential-free tag GET succeeds, then the
        // enrollment POST is the ambiguous transport failure under test.
        if (init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          throw new Error('response lost');
        }
        return new Response(JSON.stringify({ protocol_version: '2' }), { status: 200 });
      }) as typeof fetch,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'response lost') throw error;
  }
  process.stdout.write(JSON.stringify({ bodies }));
  process.exit(0);
}

if (mode === 'resume') {
  const bodies: unknown[] = [];
  const resumed = await resumeBorgServerEnrollment(common.origin, common.trustIdentity, {
    fetchImpl: (async (_input, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({
          protocol_version: '2',
          request_id: 'resume-enrollment-1',
          payload: {
            purpose: 'owner',
            client_id: '22222222-2222-4222-8222-222222222222',
            server_capabilities: ['create_cube'],
          },
        }), { status: 201 });
      }
      // Credential-free tag-only preflight: bare exact tag.
      return new Response(JSON.stringify({ protocol_version: '2' }), { status: 200 });
    }) as typeof fetch,
  });
  process.stdout.write(JSON.stringify({ bodies, token: resumed?.token }));
  process.exit(0);
}

const result = mode === 'enrollment'
  ? await getOrCreatePendingServerEnrollment({
    ...common,
    invitation: enrollmentInput.invitation,
    clientName: enrollmentInput.clientName,
  })
  : await getOrCreatePendingServerCubeCreation({
    ...common,
    clientId: '11111111-1111-4111-8111-111111111111',
    projectRoot: '/work/cross-process-project',
    name: 'cross-process-project',
    template: 'default',
  });

process.stdout.write(JSON.stringify(result));
