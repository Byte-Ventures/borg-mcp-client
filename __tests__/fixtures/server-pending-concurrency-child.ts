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
if (hookDirectory && hookRelease && ['stale', 'cleanup'].includes(hookStage ?? '')) {
  const pause = async () => {
    await mkdir(hookDirectory, { recursive: true });
    await writeFile(join(hookDirectory, `${hookStage}-${process.pid}`), 'ready');
    for (;;) {
      try {
        await access(hookRelease);
        return;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
  };
  __setServerKeychainLockHooksForTest(hookStage === 'stale'
    ? { afterStaleInspection: pause }
    : { beforeOwnerCleanup: pause });
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
        bodies.push(JSON.parse(String(init?.body)));
        throw new Error('response lost');
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
  const protocolInfo = {
    protocol_version: '1',
    package: { name: 'borgmcp-shared', version: '0.3.0' },
    capabilities: [
      'coordination.core',
      'auth.bearer',
      'auth.revocation',
      'auth.retry-safe-enrollment',
      'scope.cube-isolation',
      'transport.tls',
      'authority.no-cloud-fallback',
    ],
    limits: {
      max_request_bytes: 65_536,
      max_log_message_bytes: 10_240,
      max_read_page_size: 500,
      max_replay_page_size: 200,
    },
  };
  const resumed = await resumeBorgServerEnrollment(common.origin, common.trustIdentity, {
    fetchImpl: (async (_input, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({
          protocol_version: '1',
          request_id: 'resume-enrollment-1',
          payload: {
            purpose: 'owner',
            client_id: '22222222-2222-4222-8222-222222222222',
            server_capabilities: ['create_cube'],
          },
        }), { status: 201 });
      }
      return new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'resume-protocol-1',
        payload: protocolInfo,
      }), { status: 200 });
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
