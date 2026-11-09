import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecoverAttachmentArgs, type RecoverAttachmentDeps } from '../src/recover-attachment-cmd.js';
import { createProtocolEnvelope } from 'borgmcp-shared';
import { reconcileBorgServerAttachment } from '../src/server-handshake.js';

const home = process.env.HOME;
let root: string | undefined;
afterEach(() => {
  process.env.HOME = home;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.resetModules();
});
const seed = { origin: 'https://server.example', trustIdentity: 'sha256:server-a',
  cubeId: '11111111-1111-4111-8111-111111111111', roleId: '44444444-4444-4444-8444-444444444444',
  operation: { projectRoot: '/work/source', kind: 'seat' as const, operationKey: 'current-worktree' }, credential: 'A'.repeat(43) };
const clientId = '55555555-5555-4555-8555-555555555555';
const uuid = '99999999-9999-4999-8999-999999999999';
async function fixture() {
  root = mkdtempSync(join(tmpdir(), 'borg-recover-'));
  process.env.HOME = root;
  vi.resetModules();
  const seats = await import('../src/seats.js');
  // Import after resetting modules so CLI and direct store observations share the same root.
  const cli = await import('../src/recover-attachment-cmd.js');
  const prepared = await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment: { clientId } });
  if (!prepared.ok) throw new Error('fixture prepare failed');
  const attempt = prepared.record.attachmentAttempt!;
  const reconcile = vi.fn(async () => ({ disposition: 'retired' as const }));
  const resume = vi.fn(async () => true);
  const context = { origin: seed.origin, trustIdentity: seed.trustIdentity, clientId, worktree: '/work/source', reconcile, resume };
  const deps: RecoverAttachmentDeps = { context: vi.fn(async () => context), prompt: vi.fn(async () => 'no'),
    isTTY: () => false, stdout: vi.fn(), stderr: vi.fn() };
  return { seats, cli, context, deps, reconcile, resume, attempt };
}

it('parses the exact command and rejects ambiguous or unsafe selection without echoing inputs', () => {
  expect(parseRecoverAttachmentArgs(['--host', 'server.example', '--attempt', uuid, '--retire', '--yes'])).toMatchObject({ ok: true, flags: { attempt: uuid, retire: true, yes: true } });
  for (const args of [[], ['--host', 'secret-input'], ['--host', 'server', '--attempt', '-1'],
    ['--host', 'server', '--attempt', uuid, '--yes'], ['--host', 'server', '--attempt', uuid, '--attempt', uuid],
    ['--host', 'server', '--attempt', '1'], ['--host', 'server', '--attempt', 'not-a-uuid'],
    ['--host', 'server', '--attempt', '9007199254740992'], ['--secret-input']]) {
    const parsed = parseRecoverAttachmentArgs(args);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('secret-input');
  }
});

it('reuses exact pending state through the same attempt without any fresh prepare or retirement', async () => {
  const { seats, cli, deps, resume, reconcile, attempt } = await fixture();
  const before = readFileSync(seats.SEATS_FILE, 'utf8');
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt }, deps)).toBe(0);
  expect(resume).toHaveBeenCalledWith(expect.objectContaining({ attempt }), expect.objectContaining({ credential: seed.credential }));
  expect(reconcile).not.toHaveBeenCalled();
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(before);
  expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('original drone and session were reused'));
});

it('requires explicit cleanup consent, then retires missing state while preserving a newer local connection', async () => {
  const { seats, cli, deps, reconcile, resume, attempt } = await fixture();
  await seats.clearSeat(seats.seatRef(seed));
  await seats.mintPendingSeat({ ...seed, credential: 'B'.repeat(43) });
  const before = JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats;
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt }, deps)).toBe(1);
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt, retire: true }, deps)).toBe(1);
  expect(reconcile).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt, retire: true, yes: true }, deps)).toBe(0);
  expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ attempt }), 'retire');
  expect(JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats).toEqual(before);
});

it('uses default-No interactive consent and refuses foreign selection without mutation', async () => {
  const { seats, cli, deps, context, reconcile, attempt } = await fixture();
  await seats.clearSeat(seats.seatRef(seed));
  deps.isTTY = () => true;
  const before = readFileSync(seats.SEATS_FILE, 'utf8');
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt, retire: true }, deps)).toBe(0);
  expect(reconcile).not.toHaveBeenCalled();
  context.clientId = '66666666-6666-4666-8666-666666666666';
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt, retire: true, yes: true }, deps)).toBe(1);
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(before);
});

it('rejects the old printed UUID without network after only the journal is lost, while surviving parent and new handle still work', async () => {
  const { seats, cli, deps, reconcile, resume, attempt: oldAttempt } = await fixture();
  const config = await import('../src/config.js');
  await config.storeServerCredential({ origin: seed.origin, trustIdentity: seed.trustIdentity, clientId, credential: 'p'.repeat(43) });
  rmSync(seats.SEATS_FILE);
  const next = await seats.prepareSeat({ expected: { kind: 'absent' }, seed: { ...seed, credential: 'B'.repeat(43) }, attachment: { clientId } });
  if (!next.ok) throw new Error('fixture prepare failed');
  expect(await config.getServerCredentialRecord(seed.origin, seed.trustIdentity)).toMatchObject({ clientId, credential: 'p'.repeat(43) });
  const before = readFileSync(seats.SEATS_FILE, 'utf8');
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt: oldAttempt }, deps)).toBe(1);
  expect(reconcile).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(before);
  expect(await cli.runRecoverAttachment({ host: seed.origin, attempt: next.record.attachmentAttempt! }, deps)).toBe(0);
  expect(resume).toHaveBeenCalledWith(expect.objectContaining({ attempt: next.record.attachmentAttempt }), expect.objectContaining({ credential: 'B'.repeat(43) }));
});

it('keeps receipt, malicious response values and unknown keys out of reconciliation diagnostics', async () => {
  const secret = 'fake-sensitive-response-value';
  const request = { receipt: 'a'.repeat(64), cube_id: seed.cubeId, role_id: seed.roleId, action: 'retire' as const };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(createProtocolEnvelope('response', {
    disposition: 'retired', [secret]: secret,
  })), { status: 200 }));
  const failure = await reconcileBorgServerAttachment(seed.origin, 'p'.repeat(43), request, fetchImpl)
    .then(() => null, error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain(secret);
  expect(String(failure)).not.toContain(request.receipt);
});

it('authenticates with the parent, validates action-bound results, and preserves static terminal codes', async () => {
  const request = { receipt: 'a'.repeat(64), cube_id: seed.cubeId, role_id: seed.roleId, action: 'retire' as const };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(createProtocolEnvelope('response', { disposition: 'retired' })), { status: 200 }));
  expect(await reconcileBorgServerAttachment(seed.origin, 'p'.repeat(43), request, fetchImpl)).toEqual({ disposition: 'retired' });
  expect(fetchImpl.mock.calls[0][0]).toBe(`${seed.origin}/api/client/attach/reconcile`);
  expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${'p'.repeat(43)}`);
  expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toMatchObject({ protocol_version: '15', payload: request });
  const accepted = vi.fn(async () => new Response(JSON.stringify(createProtocolEnvelope('response', {
    disposition: 'accepted', drone_id: '22222222-2222-4222-8222-222222222222', session_id: '33333333-3333-4333-8333-333333333333',
  })), { status: 200 }));
  await expect(reconcileBorgServerAttachment(seed.origin, 'p'.repeat(43), request, accepted)).rejects.toThrow();
  const rejected = vi.fn(async () => new Response(JSON.stringify({ protocol_version: '15', request_id: 'response',
    error: { code: 'SESSION_REVOKED', message: 'fake-secret-server-body' } }), { status: 401 }));
  const error = await reconcileBorgServerAttachment(seed.origin, 'p'.repeat(43), request, rejected).then(() => null, value => value);
  expect(error).toMatchObject({ code: 'SESSION_REVOKED' });
  expect(String(error)).not.toContain('fake-secret-server-body');
});
