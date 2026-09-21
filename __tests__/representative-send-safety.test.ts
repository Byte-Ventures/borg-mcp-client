/**
 * Send-path safety regressions for the human representative: atomic request
 * reservation under overlapping calls, and honest classification of the real
 * typed client errors. Backend evidence is the controlled mock fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, ProtocolContractError } from 'borgmcp-shared/protocol';
import { COORD_ID, MockCube, OTHER_CUBE_ID, REP_ID, bindingFor } from './fixtures/representative-mock-backend.js';
import {
  RepresentativeError,
  representativeStatus,
  sendRepresentativeMessage,
  type RepresentativeContext,
} from '../src/representative-core.js';
import { createRepresentativeStore } from '../src/representative-store.js';
import { DroneEvictedError } from '../src/drone-lifecycle.js';
import {
  BorgProtocolMismatchError,
  BorgServerError,
  BorgServerHttpError,
  BorgServerTrustError,
  BorgServerUnreachableError,
} from '../src/server-errors.js';

const originalHome = process.env.HOME;
const WORKTREE = '/work/hermes-representative';
const REQUEST_ID = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
let root: string;
let storePath: string;
let cube: MockCube;
let ctx: RepresentativeContext;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-safety-')));
  process.env.HOME = root;
  storePath = join(root, '.config', 'borgmcp', 'representative.json');
  cube = new MockCube();
  ctx = { binding: bindingFor(WORKTREE), backend: cube.backend(), store: createRepresentativeStore(storePath) };
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock('../src/remote-client.js');
});

const base = { kind: 'request', authorization: 'user_authorized', message: 'Do X.' } as const;
const ledger = () => {
  try {
    return (JSON.parse(readFileSync(storePath, 'utf8')).requests[WORKTREE] ?? []) as Array<{ requestId: string; state: string }>;
  } catch {
    return [];
  }
};

async function failure(promise: Promise<unknown>): Promise<RepresentativeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RepresentativeError) return error;
    throw error;
  }
  throw new Error('expected a RepresentativeError');
}

describe('atomic request reservation', () => {
  it('lets only one of two overlapping no-id sends of the same content reach the log', async () => {
    let open!: () => void;
    cube.appendGate = new Promise<void>((resolve) => { open = resolve; });
    cube.verifyDelayMs = 60;
    const first = sendRepresentativeMessage(ctx, base);
    const second = sendRepresentativeMessage(ctx, base);
    const settled = Promise.allSettled([first, second]);
    // Give both calls time to pass every pre-send step while the append is held.
    await new Promise((resolve) => setTimeout(resolve, 400));
    open();
    const results = await settled;

    const sent = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(sent).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: 'AMBIGUOUS_SEND_UNRESOLVED' });
    const winner = (sent[0] as PromiseFulfilledResult<any>).value;
    expect(refused[0].reason.message).toContain(winner.request_id);
    expect(cube.appendCalls).toHaveLength(1);
    expect(cube.entries).toHaveLength(1);
    expect(ledger()).toEqual([expect.objectContaining({ requestId: winner.request_id, state: 'sent' })]);
  });

  it('does not globally dedupe: a later, non-overlapping identical request is a new message', async () => {
    const one = await sendRepresentativeMessage(ctx, base);
    const two = await sendRepresentativeMessage(ctx, base);
    expect(two.request_id).not.toBe(one.request_id);
    expect(cube.entries).toHaveLength(2);
  });

  it('keeps overlapping same-id sends to one post and a consistent sent record', async () => {
    let open!: () => void;
    cube.appendGate = new Promise<void>((resolve) => { open = resolve; });
    cube.verifyDelayMs = 60;
    const input = { ...base, request_id: REQUEST_ID };
    const both = Promise.all([sendRepresentativeMessage(ctx, input), sendRepresentativeMessage(ctx, input)]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    open();
    const results = await both;
    expect(results.map((r) => r.outcome)).toEqual(['sent', 'sent']);
    expect(new Set(results.map((r) => r.entry_id)).size).toBe(1);
    expect(cube.entries).toHaveLength(1);
    expect(ledger()).toEqual([expect.objectContaining({ requestId: REQUEST_ID, state: 'sent' })]);
  });

  it('never downgrades a sent record when an overlapping same-id attempt ends ambiguous', async () => {
    let open!: () => void;
    cube.appendGate = new Promise<void>((resolve) => { open = resolve; });
    cube.verifyDelayMs = 60;
    cube.appendPlan = ['ok', 'lost-response'];
    const input = { ...base, request_id: REQUEST_ID };
    const both = Promise.all([sendRepresentativeMessage(ctx, input), sendRepresentativeMessage(ctx, input)]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    open();
    await both;
    expect(ledger()).toEqual([expect.objectContaining({ requestId: REQUEST_ID, state: 'sent' })]);
    expect((await representativeStatus(ctx)).unresolved_requests).toEqual([]);
  });

  it('refuses overlapping same-id sends with different content without a second post', async () => {
    let open!: () => void;
    cube.appendGate = new Promise<void>((resolve) => { open = resolve; });
    cube.verifyDelayMs = 60;
    const first = sendRepresentativeMessage(ctx, { ...base, request_id: REQUEST_ID });
    const second = sendRepresentativeMessage(ctx, { ...base, request_id: REQUEST_ID, message: 'Do Y instead.' });
    const settled = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    open();
    const results = await settled;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(cube.entries).toHaveLength(1);
  });

  it('releases the reservation when the live binding check fails, so nothing is poisoned', async () => {
    cube.whoamiCubeId = OTHER_CUBE_ID;
    expect((await failure(sendRepresentativeMessage(ctx, base))).code).toBe('BINDING_MISMATCH');
    expect(cube.appendCalls).toHaveLength(0);
    expect(ledger()).toEqual([]);
    cube.whoamiCubeId = bindingFor(WORKTREE).cubeId;
    expect((await sendRepresentativeMessage(ctx, base)).outcome).toBe('sent');
  });

  it('keeps the reservation when its verification fails while another same-id attempt is already appending', async () => {
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(done()).toBe(true);
    };
    let openAppend!: () => void;
    cube.appendGate = new Promise<void>((resolve) => { openAppend = resolve; });
    // A: reserves the id, then hangs in a live check that will fail.
    let failA!: () => void;
    const holdA = new Promise<void>((resolve) => { failA = resolve; });
    let aVerifying = false;
    const real = cube.backend();
    const ctxA: RepresentativeContext = {
      ...ctx,
      backend: {
        ...real,
        whoami: async () => {
          aVerifying = true;
          await holdA;
          return { ...(await real.whoami()), cube_id: OTHER_CUBE_ID };
        },
      },
    };
    const input = { ...base, request_id: REQUEST_ID };
    const a = failure(sendRepresentativeMessage(ctxA, input));
    await until(() => aVerifying);
    // B: same id, passes verification, is blocked inside the append.
    const b = sendRepresentativeMessage(ctx, input);
    await until(() => cube.appendCalls.length === 1);
    failA();
    expect((await a).code).toBe('BINDING_MISMATCH');

    // C: identical content, no id, while B's post is still in flight.
    // Raced against "C reached the append", so a regression fails fast instead of hanging on the gate.
    const c = await Promise.race([
      failure(sendRepresentativeMessage(ctx, base)).then((error) => error.code),
      until(() => cube.appendCalls.length === 2).then(() => 'C_REACHED_APPEND'),
    ]);
    expect(c).toBe('AMBIGUOUS_SEND_UNRESOLVED');
    expect(cube.appendCalls).toHaveLength(1);

    openAppend();
    expect((await b).outcome).toBe('sent');
    expect(cube.entries).toHaveLength(1);
    expect(ledger()).toEqual([expect.objectContaining({ requestId: REQUEST_ID, state: 'sent' })]);
  });

  it('keeps an earlier ambiguous record ambiguous when its retry fails the live binding check', async () => {
    cube.appendPlan = ['lost-response'];
    const input = { ...base, request_id: REQUEST_ID };
    expect((await sendRepresentativeMessage(ctx, input)).outcome).toBe('ambiguous');
    cube.whoamiCubeId = OTHER_CUBE_ID;
    expect((await failure(sendRepresentativeMessage(ctx, input))).code).toBe('BINDING_MISMATCH');
    expect(ledger()).toEqual([expect.objectContaining({ requestId: REQUEST_ID, state: 'ambiguous' })]);
  });

  it('reserves nothing for locally invalid input, including a payload the protocol would refuse', async () => {
    expect((await failure(sendRepresentativeMessage(ctx, { ...base, message: 'x'.repeat(5000) }))).code).toBe('INVALID_INPUT');
    expect((await failure(sendRepresentativeMessage(ctx, { ...base, request_id: 'nope' }))).code).toBe('INVALID_INPUT');
    expect(ledger()).toEqual([]);
    expect(cube.calls).toEqual([]);
  });
});

describe('typed error classification', () => {
  const REFUSALS: Array<[string, unknown, string, RegExp]> = [
    ['a rejected credential', new BorgServerError('CREDENTIAL_REJECTED', 'the selected Borg server rejected the credential'), 'CREDENTIAL_REJECTED', /borg representative prepare/],
    ['a revoked session', new BorgServerError('SESSION_REVOKED', 'the selected Borg server revoked this worktree session'), 'SESSION_REVOKED', /borg representative prepare/],
    ['an evicted drone', new DroneEvictedError(), 'DRONE_EVICTED', /borg representative prepare/],
    ['a rate limit', new BorgServerHttpError(429, 'Borg server request failed (HTTP 429)'), 'HTTP_429', /same request_id/],
    ['a forbidden request', new BorgServerHttpError(403, 'Borg server request failed (HTTP 403)', ErrorCode.ACCESS_DENIED), 'ACCESS_DENIED', /operator/],
  ];

  it.each(REFUSALS)('reports %s as a refusal with its cause, not as ambiguous', async (_name, error, causeCode, recovery) => {
    cube.appendPlan = [{ error, stored: false }];
    const refused = await failure(sendRepresentativeMessage(ctx, { ...base, request_id: REQUEST_ID }));
    expect(refused.code).toBe('SEND_REJECTED');
    expect(refused.details?.cause_code).toBe(causeCode);
    expect(refused.details?.recovery).toMatch(recovery);
    expect(cube.entries).toHaveLength(0);
    expect((await representativeStatus(ctx)).unresolved_requests).toEqual([]);
  });

  it('lets a refused request be retried under the same id once the cause is gone', async () => {
    cube.appendPlan = [{ error: new BorgServerHttpError(429, 'Borg server request failed (HTTP 429)'), stored: false }];
    const input = { ...base, request_id: REQUEST_ID };
    await failure(sendRepresentativeMessage(ctx, input));
    expect((await sendRepresentativeMessage(ctx, input)).outcome).toBe('sent');
    expect(cube.entries).toHaveLength(1);
  });

  const UNCERTAIN: Array<[string, unknown, string]> = [
    ['an unreachable server', new BorgServerUnreachableError('Local Borg server request timed out'), 'SERVER_UNREACHABLE'],
    ['a server error', new BorgServerHttpError(503, 'Borg server request failed (HTTP 503)'), 'HTTP_503'],
    ['an unreadable response after a possible commit', new BorgProtocolMismatchError(), 'PROTOCOL_MISMATCH'],
    ['a malformed response payload', new ProtocolContractError('bad payload'), 'PROTOCOL_CONTRACT'],
    ['a trust failure of unknown timing', new BorgServerTrustError('Borg server trust identity changed; refusing the connection'), 'SERVER_TRUST'],
    ['an unknown error', new Error(`boom ${'y'.repeat(900)}`), 'UNKNOWN'],
  ];

  it.each(UNCERTAIN)('keeps %s ambiguous but names the cause and a recovery', async (_name, error, causeCode) => {
    cube.appendPlan = [{ error, stored: true }];
    const input = { ...base, request_id: REQUEST_ID };
    const result = await sendRepresentativeMessage(ctx, input);
    expect(result.outcome).toBe('ambiguous');
    expect(result.cause?.code).toBe(causeCode);
    expect(result.cause?.message.length).toBeLessThanOrEqual(300);
    expect(result.guidance).toContain('same request_id');
    expect(result.guidance).not.toMatch(/new request_id is safe|clear the ledger/i);
    // The mock DID store it: the only safe recovery is the same-id retry.
    const retried = await sendRepresentativeMessage(ctx, input);
    expect(retried).toMatchObject({ outcome: 'sent', deduplicated: true });
    expect(cube.entries).toHaveLength(1);
  });

  it('never lets a later refusal clear an earlier attempt that may have been stored', async () => {
    cube.appendPlan = ['lost-response', { error: new BorgServerHttpError(429, 'Borg server request failed (HTTP 429)'), stored: false }];
    const input = { ...base, request_id: REQUEST_ID };
    expect((await sendRepresentativeMessage(ctx, input)).outcome).toBe('ambiguous');
    const refused = await failure(sendRepresentativeMessage(ctx, input));
    expect(refused.code).toBe('SEND_REJECTED');
    expect(refused.message).toContain('still unresolved');
    expect((await representativeStatus(ctx)).unresolved_requests.map((r) => r.request_id)).toEqual([REQUEST_ID]);
    expect((await failure(sendRepresentativeMessage(ctx, base))).code).toBe('AMBIGUOUS_SEND_UNRESOLVED');
    expect(await sendRepresentativeMessage(ctx, input)).toMatchObject({ outcome: 'sent', deduplicated: true });
    expect(cube.entries).toHaveLength(1);
  });

  it('flags a server-side post id conflict as refused and tells the operator, never suggesting a resend', async () => {
    cube.posts.set(REQUEST_ID, { fingerprint: 'something else', entry: cube.post(REP_ID, 'older', [COORD_ID]) });
    const refused = await failure(sendRepresentativeMessage(ctx, { ...base, request_id: REQUEST_ID }));
    expect(refused.code).toBe('SEND_REJECTED');
    expect(refused.details?.cause_code).toBe('POST_ID_CONFLICT');
    expect(refused.details?.recovery).toMatch(/operator/);
  });
});

describe('real seat backend wiring', () => {
  it('appends with the request id as post id and a single transport attempt', async () => {
    const appendLog = vi.fn(async () => ({ entry: { id: 'e' }, deduplicated: false }));
    vi.doMock('../src/remote-client.js', () => ({ appendLog }));
    const { createSeatBackend } = await import('../src/representative-core.js');
    const backend = await createSeatBackend({
      cubeId: bindingFor(WORKTREE).cubeId, droneId: REP_ID, name: 'c', droneLabel: 'hermes-1',
      sessionToken: 'bearer', apiUrl: 'https://127.0.0.1:65530', serverTrustIdentity: 'sha256:mock-server',
    });
    await backend.append({ postId: REQUEST_ID, message: 'm', to: [COORD_ID] });
    expect(appendLog).toHaveBeenCalledWith('bearer', 'https://127.0.0.1:65530', 'm', {
      to: [COORD_ID], postId: REQUEST_ID, transportRetry: false, serverTrustIdentity: 'sha256:mock-server',
    });
  });
});
