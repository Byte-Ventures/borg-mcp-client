import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createProtocolEnvelope } from 'borgmcp-shared';
import { UNREPORTED_ATTACH_RUNTIME_METADATA } from './fixtures/runtime-metadata.js';

const home = process.env.HOME;
let root: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../dist/server-trust.js');
  vi.doUnmock('../dist/config.js');
  vi.doUnmock('../dist/repository-identity.js');
  vi.resetModules();
  process.env.HOME = home;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
const origin = 'https://server.example';
const identity = 'sha256:server-a';
const clientId = '55555555-5555-4555-8555-555555555555';
const cubeId = '11111111-1111-4111-8111-111111111111';
const roleId = '44444444-4444-4444-8444-444444444444';
const droneId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const bearer = 'A'.repeat(43);
const parent = 'p'.repeat(43);
const unknown = '99999999-9999-4999-8999-999999999999';

async function fixture(tag: '14' | '15', mode: 'resume' | 'finalize' | 'retire' = 'resume') {
  root = mkdtempSync(join(tmpdir(), 'borg-recovery-preflight-'));
  process.env.HOME = root;
  vi.resetModules();
  const state = { identity, clientId, worktree: root };
  const response = (payload: unknown, status = 200) => new Response(JSON.stringify(createProtocolEnvelope('response', payload)), { status });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/protocol') return new Response(JSON.stringify({ protocol_version: tag }));
    if (tag === '14') return new Response(JSON.stringify({ protocol_version: '15', request_id: 'response',
      error: { code: 'UNSUPPORTED_PROTOCOL_VERSION', message: 'Unsupported protocol' } }), { status: 409 });
    if (url.pathname === '/api/client/attach') return response({ result: 'created', initial_log_cursor: null, cube: { id: cubeId, name: 'cube' },
      role: { id: roleId, name: 'Builder', is_human_seat: false, role_class: 'worker' },
      drone: { id: droneId, label: 'builder-1', ...UNREPORTED_ATTACH_RUNTIME_METADATA }, session: { id: sessionId } }, 201);
    if (url.pathname === '/api/client/attach/reconcile') {
      const action = JSON.parse(String(init?.body)).payload.action;
      return response(action === 'retire' ? { disposition: 'retired' } : { disposition: 'finalized', drone_id: droneId, session_id: sessionId });
    }
    throw new Error('Unexpected synthetic HTTP request');
  });
  vi.doMock('../dist/server-trust.js', () => ({ loadBorgServerTrust: async () => ({ identity: state.identity, fetchImpl }) }));
  vi.doMock('../dist/config.js', async importOriginal => ({ ...await importOriginal<object>(),
    getServerCredentialRecord: async () => ({ clientId: state.clientId, credential: parent }) }));
  vi.doMock('../dist/repository-identity.js', async importOriginal => ({ ...await importOriginal<object>(),
    resolveGitRepositoryContext: async () => ({ root: state.worktree, commonDir: join(state.worktree, '.git'), publicRepository: null }) }));
  // Exercise the committed built command's DEFAULT context and real HTTP helpers.
  const seats = await import('../dist/seats.js');
  const cli = await import('../dist/recover-attachment-cmd.js');
  const seed = { origin, trustIdentity: identity, cubeId, roleId,
    operation: { projectRoot: root, kind: 'seat' as const, operationKey: 'current-worktree' }, credential: bearer };
  const prepared = await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment: { clientId } });
  if (!prepared.ok) throw new Error('Fixture PREPARE failed');
  const attempt = prepared.record.attachmentAttempt!;
  if (mode === 'retire') await seats.clearSeat(seats.seatRef(seed));
  if (mode === 'finalize') expect(await seats.activateAndBindSeat({ ...seed, droneId, sessionId,
    expectedPendingDigest: createHash('sha256').update(bearer).digest('hex'), worktree: root,
    name: 'cube', droneLabel: 'builder-1' })).toBe('ack-pending');
  const deps = { ...cli.buildDefaultRecoverAttachmentDeps(), stdout: vi.fn(), stderr: vi.fn() };
  const run = (selected = attempt) => cli.runRecoverAttachment({ host: origin, attempt: selected,
    ...(mode === 'retire' ? { retire: true, yes: true } : {}) }, deps);
  return { seats, seed, attempt, state, fetchImpl, run };
}

it.each(['resume', 'finalize', 'retire'] as const)('refuses tag14 before any bearer or mutation through default built %s recovery', async mode => {
  const f = await fixture('14', mode);
  const before = readFileSync(f.seats.SEATS_FILE, 'utf8');
  expect(await f.run()).toBe(1);
  expect(f.fetchImpl.mock.calls.map(([input, init]) => ({ path: new URL(String(input)).pathname, method: init?.method,
    authenticated: new Headers(init?.headers).has('Authorization') })))
    .toEqual([{ path: '/api/protocol', method: 'GET', authenticated: false }]);
  const [input, request] = f.fetchImpl.mock.calls[0];
  expect(new URL(String(input)).search).toBe('');
  expect(new Headers(request?.headers).has('Authorization')).toBe(false);
  expect(new Headers(request?.headers).has('Cookie')).toBe(false);
  expect(request?.body).toBeUndefined();
  expect(request?.redirect).toBe('error');
  expect(readFileSync(f.seats.SEATS_FILE, 'utf8') === before).toBe(true);
});

it.each(['resume', 'finalize', 'retire'] as const)('preflights tag15 before the exact authenticated %s request', async mode => {
  const f = await fixture('15', mode);
  expect(await f.run()).toBe(0);
  const requests = f.fetchImpl.mock.calls;
  expect(requests.map(([input]) => new URL(String(input)).pathname)).toEqual(mode === 'resume'
    ? ['/api/protocol', '/api/client/attach', '/api/client/attach/reconcile'] : ['/api/protocol', '/api/client/attach/reconcile']);
  expect(new Headers(requests[0][1]?.headers).has('Authorization')).toBe(false);
  const request = requests[1][1]!;
  expect(new Headers(request.headers).get('Authorization') === `Bearer ${parent}`).toBe(true);
  const payload = JSON.parse(String(request.body)).payload;
  expect(payload).toMatchObject({ cube_id: cubeId, role_id: roleId });
  if (mode === 'resume') {
    expect(payload.session_credential === bearer).toBe(true);
    expect(await f.seats.getActiveSeatForWorktree(f.state.worktree)).toMatchObject({ droneId, sessionId, attachmentAttempt: f.attempt });
  } else {
    const entry = await f.seats.readAttachmentAttempt({ attempt: f.attempt, origin, trustIdentity: identity, clientId, worktree: f.state.worktree });
    expect(payload).toMatchObject({ receipt: entry.receipt, action: mode });
  }
});

it.each((['resume', 'finalize', 'retire'] as const).flatMap(mode =>
  (['unknown', 'foreign-source', 'foreign-authority', 'foreign-parent', 'stale-lock', 'durability'] as const)
    .map(refusal => [mode, refusal] as const)))(
  'makes zero HTTP requests before default %s recovery local %s refusal', async (mode, refusal) => {
    const f = await fixture('15', mode);
    if (refusal === 'foreign-source') f.state.worktree = join(root!, 'other');
    if (refusal === 'foreign-authority') f.state.identity = 'sha256:other';
    if (refusal === 'foreign-parent') f.state.clientId = unknown;
    if (refusal === 'stale-lock') writeFileSync(`${f.seats.SEATS_FILE}.lock`, 'invalid owner', { mode: 0o600 });
    if (refusal === 'durability') {
      const fs = await import('../dist/guarded-fs.js');
      const open = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
        if (args[0] === dirname(f.seats.SEATS_FILE) && args[1] === 'r') throw new Error('Continuous durability fault');
        return open(...args);
      });
    }
    const before = readFileSync(f.seats.SEATS_FILE, 'utf8');
    expect(await f.run(refusal === 'unknown' ? unknown : undefined)).toBe(1);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(f.seats.SEATS_FILE, 'utf8') === before).toBe(true);
  });
