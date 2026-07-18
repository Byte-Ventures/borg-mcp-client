/**
 * Cross-process serialization child (Queen rescope). Runs against the REAL 0600
 * credential file store (HOME points at a per-test fixture, so config resolves
 * ~/.config/borgmcp/credentials.json inside it). No hooks, no injected backend —
 * correctness comes from the single store flock alone.
 */
import {
  getOrCreatePendingServerCubeCreation,
  getOrCreatePendingServerEnrollment,
} from '../../src/config.js';
import { enrollBorgServer, resumeBorgServerEnrollment } from '../../src/server-handshake.js';

const mode = process.argv[2];
if (!['enrollment', 'cube', 'ambiguous', 'resume'].includes(mode ?? '')) {
  throw new Error('invalid pending-concurrency child invocation');
}

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
