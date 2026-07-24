/**
 * CR#3 process-restart E2E child. Runs against the REAL 0600 seat store (HOME points
 * at a per-test fixture, so seats.json resolves inside it and PERSISTS across the two
 * separate OS-process invocations).
 *
 *   run1: an IMPLICIT sibling mints a fresh per-invocation operationKey, prepares the
 *         PENDING record, and SENDS the attach (the fake server accepts → one seat).
 *         Then it CRASHES before the worktree bind (just exits), leaving an UNBOUND
 *         pending sibling record whose random key is now on disk but "lost" to the CLI.
 *   run2: a fresh process (same HOME) RECOVERS that in-flight attempt via
 *         findIncompleteSiblingAttempt, adopts its EXACT operation, and re-prepares.
 *         prepareSeat REUSES the extant pending record, so the IDENTICAL bearer is
 *         re-sent — the real digest-correlating server would reuse its seat (no ghost).
 *
 * Each mode prints JSON {sentBearer, operationKey, [freshSeed, reused]} to stdout so
 * the parent can prove run2 re-sent run1's exact bearer under run1's exact operationKey.
 */
import { randomBytes } from 'node:crypto';
import { findIncompleteSiblingAttempt, prepareSeat, seatRef } from '../../src/seats.js';
import { sendBorgServerAttach } from '../../src/server-handshake.js';
import { UNREPORTED_ATTACH_RUNTIME_METADATA } from './runtime-metadata.js';

const ORIGIN = 'https://server.example.com';
const TRUST = 'spki-sha256:server-a';
const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_CRED = 'p'.repeat(43);
const SRC = '/work/myrepo';

const seatInput = (operation: { projectRoot: string; kind: 'seat' | 'sibling'; operationKey: string }) => ({
  origin: ORIGIN, trustIdentity: TRUST, cubeId: CUBE_ID, roleId: ROLE_ID, operation,
});

// A fake server that always accepts an attach (created on run1, reused on run2). The
// convergence proof is at the CLIENT: run2 must re-send the IDENTICAL bearer run1 sent.
const fakeFetch = (result: 'created' | 'reused') =>
  (async () => new Response(JSON.stringify({
    protocol_version: '3', request_id: 'attach-r',
    payload: {
      result,
      cube: { id: CUBE_ID, name: 'myrepo' },
      role: { id: ROLE_ID, name: 'Drone', role_class: 'worker' },
      drone: { id: '33333333-3333-4333-8333-333333333333', label: 'one-of-one', ...UNREPORTED_ATTACH_RUNTIME_METADATA },
      session: { id: '99999999-9999-4999-8999-999999999999' },
    },
  }), { status: result === 'created' ? 201 : 200 })) as unknown as typeof fetch;

const mode = process.argv[2];

if (mode === 'run1') {
  const operationKey = `implicit-sibling:${randomBytes(8).toString('hex')}`;
  const op = { projectRoot: SRC, kind: 'sibling' as const, operationKey };
  const bearerA = randomBytes(32).toString('base64url');
  const prep = await prepareSeat({
    expected: { kind: 'absent' }, revalidate: false, seed: { ...seatInput(op), credential: bearerA },
  });
  if (!prep.ok) throw new Error('run1 prepare failed');
  await sendBorgServerAttach(
    ORIGIN, TRUST, PARENT_CRED, { cubeId: CUBE_ID, roleId: ROLE_ID, operation: op },
    prep.record.credential, { fetchImpl: fakeFetch('created') },
  );
  // CRASH before the worktree bind: exit leaving the unbound pending sibling on disk.
  process.stdout.write(JSON.stringify({ sentBearer: prep.record.credential, operationKey }));
  process.exit(0);
}

if (mode === 'run2') {
  const inflight = await findIncompleteSiblingAttempt({
    origin: ORIGIN, trustIdentity: TRUST, cubeId: CUBE_ID, projectRoot: SRC,
  });
  if (!inflight) throw new Error('run2 did not recover the in-flight attempt');
  const op = inflight.operation;
  // A fresh seed that MUST be ignored (prepareSeat reuses the extant pending bearer).
  const freshSeed = randomBytes(32).toString('base64url');
  const prep = await prepareSeat({
    expected: { kind: 'absent' }, seed: { ...seatInput(op), credential: freshSeed },
  });
  if (!prep.ok) throw new Error('run2 prepare failed');
  const prepared = await sendBorgServerAttach(
    ORIGIN, TRUST, PARENT_CRED, { cubeId: CUBE_ID, roleId: ROLE_ID, operation: op },
    prep.record.credential, { fetchImpl: fakeFetch('reused') },
  );
  process.stdout.write(JSON.stringify({
    sentBearer: prep.record.credential,
    operationKey: op.operationKey,
    freshSeed,
    reused: prepared.result === 'reused',
    ref: seatRef(seatInput(op)),
  }));
  process.exit(0);
}

throw new Error(`invalid sibling-retry-identity-child mode: ${mode}`);
