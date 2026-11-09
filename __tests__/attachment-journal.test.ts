import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { deriveAttachmentReceipt, ErrorCode } from 'borgmcp-shared';
import { createHash } from 'node:crypto';

const home = process.env.HOME;
const roots: string[] = [];
afterEach(() => {
  process.env.HOME = home;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.restoreAllMocks();
});
async function load() {
  const root = mkdtempSync(join(tmpdir(), 'borg-attachment-'));
  roots.push(root);
  process.env.HOME = root;
  vi.resetModules();
  return import('../src/seats.js');
}
const seed = {
  origin: 'https://server.example', trustIdentity: 'sha256:server-a',
  cubeId: '11111111-1111-4111-8111-111111111111',
  roleId: '44444444-4444-4444-8444-444444444444',
  operation: { projectRoot: '/work/source', kind: 'sibling' as const, operationKey: 'implicit-sibling:first' },
  credential: 'A'.repeat(43),
};
const attachment = { clientId: '55555555-5555-4555-8555-555555555555' };
const lookup = { origin: seed.origin, trustIdentity: seed.trustIdentity, clientId: attachment.clientId, worktree: '/work/source' };
const attemptOf = (seats: typeof import('../src/seats.js')): string => Object.keys(JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).attachments)[0];
const stamp = { droneId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333' };
const activation = { ...seed, ...stamp, expectedPendingDigest: createHash('sha256').update(seed.credential).digest('hex'),
  worktree: '/work/target', name: 'cube', droneLabel: 'builder-1' };

it('commits the receipt and pending credential together and retries with the same attempt and bearer', async () => {
  const seats = await load();
  const first = await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const retry = await seats.prepareSeat({ expected: { kind: 'absent' }, seed: { ...seed, credential: 'B'.repeat(43) }, attachment });
  expect(retry).toEqual(first);
  const journal = await seats.readAttachmentAttempt({ ...lookup, attempt: first.record.attachmentAttempt! });
  expect(journal).toMatchObject({ receipt: await deriveAttachmentReceipt(seed.credential), disposition: 'unresolved', operation: seed.operation });
  const disk = JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8'));
  expect(disk.seats[seats.seatRef(seed)].attachmentAttempt).toBe(journal.attempt);
  expect(JSON.stringify(disk.attachments)).not.toContain(seed.credential);
});

it('keeps missing-generation cleanup intent and blocks a new implicit key or role without writing', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  await seats.clearSeat(seats.seatRef(seed));
  const before = readFileSync(seats.SEATS_FILE, 'utf8');
  await expect(seats.prepareSeat({ expected: { kind: 'absent' }, attachment, seed: {
    ...seed, roleId: '66666666-6666-4666-8666-666666666666', credential: 'B'.repeat(43),
    operation: { ...seed.operation, operationKey: 'implicit-sibling:new-invocation' },
  } })).rejects.toThrow(/recover-attachment/);
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(before);
  expect(await seats.readAttachmentAttempt({ ...lookup, attempt: attemptOf(seats) })).toMatchObject({ disposition: 'cleanup-only' });
  // A deliberate named sibling is a different operation, not an accidental retry.
  expect((await seats.prepareSeat({ expected: { kind: 'absent' }, attachment, seed: {
    ...seed, operation: { ...seed.operation, operationKey: 'named-sibling:other' }, credential: 'C'.repeat(43),
  } })).ok).toBe(true);
});

it('refuses foreign authority, parent, cwd and absent attempt without changing the journal', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  const before = readFileSync(seats.SEATS_FILE, 'utf8');
  for (const change of [{ origin: 'https://other.example' }, { trustIdentity: 'other' },
    { clientId: '66666666-6666-4666-8666-666666666666' }, { worktree: '/other' }, { attempt: '99999999-9999-4999-8999-999999999999' }]) {
    await expect(seats.readAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), ...change })).rejects.toThrow(/not available/);
  }
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(before);
});

it('never aliases an old printed attempt handle to a new generation after journal-file loss', async () => {
  const seats = await load();
  const first = await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  if (!first.ok) throw new Error('fixture prepare failed');
  const old = { ...lookup, attempt: first.record.attachmentAttempt! };
  rmSync(seats.SEATS_FILE);
  const later = await seats.prepareSeat({ expected: { kind: 'absent' }, seed: { ...seed, credential: 'B'.repeat(43) }, attachment });
  if (!later.ok) throw new Error('fixture prepare failed');
  const before = readFileSync(seats.SEATS_FILE, 'utf8');
  await expect(seats.readAttachmentAttempt(old)).rejects.toThrow(/not available/);
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(before);
  expect(later.record.attachmentAttempt).not.toBe(old.attempt);
  expect(await seats.readAttachmentAttempt({ ...lookup, attempt: later.record.attachmentAttempt! })).toMatchObject({ attempt: later.record.attachmentAttempt });
});

it.each(['null-journal', 'non-UUID-handle', 'mismatched-key', 'bad-receipt', 'missing-record-link'])('refuses %s without rewriting corrupt journal bytes or echoing fields', async fault => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  const data = JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8'));
  if (fault === 'null-journal') { data.attachments = null; data.seats = {}; }
  if (fault === 'non-UUID-handle') data.attachments[attemptOf(seats)].attempt = '1';
  if (fault === 'mismatched-key') {
    const original = attemptOf(seats);
    data.attachments['99999999-9999-4999-8999-999999999999'] = data.attachments[original];
    delete data.attachments[original];
  }
  if (fault === 'bad-receipt') data.attachments[attemptOf(seats)].receipt = 'fake-secret-invalid-receipt';
  if (fault === 'missing-record-link') delete data.seats[seats.seatRef(seed)].attachmentAttempt;
  const corrupt = JSON.stringify(data);
  writeFileSync(seats.SEATS_FILE, corrupt);
  const error = await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment }).then(() => null, value => value);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/malformed/);
  expect(String(error)).not.toContain('fake-secret-invalid-receipt');
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(corrupt);
});

it('records explicit in-place intent even when the existing operation namespace says implicit sibling', async () => {
  const seats = await load();
  const source = process.env.HOME!;
  const inplace = { ...seed, operation: { ...seed.operation, projectRoot: source } };
  const owner = { ...attachment, targetWorktree: source };
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed: inplace, attachment: owner });
  expect(await seats.readAttachmentAttempt({ ...lookup, worktree: source, attempt: attemptOf(seats) })).toMatchObject({ targetWorktree: source });
  await seats.clearSeat(seats.seatRef(inplace));
  await expect(seats.prepareSeat({ expected: { kind: 'absent' }, attachment: owner, seed: {
    ...inplace, credential: 'B'.repeat(43), operation: { ...inplace.operation, operationKey: 'implicit-sibling:another-here' },
  } })).rejects.toThrow(/recover-attachment/);
  expect((await seats.prepareSeat({ expected: { kind: 'absent' }, attachment, seed: {
    ...inplace, credential: 'C'.repeat(43), operation: { ...inplace.operation, operationKey: 'implicit-sibling:deliberate-worktree' },
  } })).ok).toBe(true);
});

it('preserves ACTIVE after lost ACK, retries acknowledgment without changing bearer, and reset retains cleanup intent', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  const ack = vi.fn(async () => { throw new Error('lost response'); });
  expect(await seats.activateAndBindSeat({ ...activation, acknowledge: ack })).toBe('ack-pending');
  expect(await seats.getActiveSeatForWorktree('/work/target')).toMatchObject({ state: 'active', ...stamp });
  expect(await seats.readAttachmentAttempt({ ...lookup, attempt: attemptOf(seats) })).toMatchObject({ disposition: 'ack-pending', ...stamp });
  const confirm = vi.fn(async () => {});
  expect(await seats.activateAndBindSeat({ ...activation, acknowledge: confirm })).toBe('activated');
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(await seats.activateAndBindSeat({ ...activation, acknowledge: confirm })).toBe('activated');
  expect(confirm).toHaveBeenCalledTimes(1);
  await seats.resetSeatForWorktree({ worktree: '/work/target', ref: seats.seatRef(seed), droneId: stamp.droneId,
    observation: { state: 'active', digest: activation.expectedPendingDigest, droneId: stamp.droneId } });
  expect(await seats.readAttachmentAttempt({ ...lookup, attempt: attemptOf(seats) })).toMatchObject({ disposition: 'cleanup-only' });
  expect(await seats.activateAndBindSeat({ ...activation, acknowledge: confirm })).toBe('missing');
  expect(confirm).toHaveBeenCalledTimes(1);
});

it('preserves a bound connection but propagates an authoritative terminal ACK refusal distinctly from transport ambiguity', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  const refusal = Object.assign(new Error('static terminal refusal'), { code: ErrorCode.SESSION_REVOKED });
  await expect(seats.activateAndBindSeat({ ...activation, acknowledge: async () => { throw refusal; } })).rejects.toBe(refusal);
  expect(await seats.getActiveSeatForWorktree('/work/target')).toMatchObject({ state: 'active', ...stamp });
  expect(await seats.readAttachmentAttempt({ ...lookup, attempt: attemptOf(seats) })).toMatchObject({ disposition: 'ack-pending' });
});

it('observes ACTIVE after a real rename followed by sync failure, confirms durability, and never retires it', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  const fs = await import('../src/guarded-fs.js');
  const open = fs.open;
  let failed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    if (!failed && args[0] === dirname(seats.SEATS_FILE) && args[1] === 'r') {
      failed = true;
      throw new Error('synthetic parent sync failure after rename');
    }
    return open(...args);
  });
  const ack = vi.fn(async () => {
    expect(JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats[seats.seatRef(seed)].state).toBe('active');
  });
  expect(await seats.activateAndBindSeat({ ...activation, acknowledge: ack })).toBe('activated');
  expect(failed).toBe(true);
  expect(ack).toHaveBeenCalledTimes(1);
  expect(await seats.getActiveSeatForWorktree('/work/target')).toMatchObject(stamp);
});

it('never ACKs a pre-rename failure or continuously unconfirmed post-rename durability', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  const fs = await import('../src/guarded-fs.js');
  const rename = fs.rename;
  const before = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof rename>) => {
    if (args[1] === seats.SEATS_FILE) throw new Error('synthetic pre-rename failure');
    return rename(...args);
  });
  const ack = vi.fn(async () => {});
  expect(await seats.activateAndBindSeat({ ...activation, acknowledge: ack })).toBe('indeterminate');
  expect(await seats.getActiveSeatForWorktree('/work/target')).toBeNull();
  expect(ack).not.toHaveBeenCalled();
  before.mockRestore();
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    if (args[0] === dirname(seats.SEATS_FILE) && args[1] === 'r') throw new Error('synthetic continuous sync failure');
    return open(...args);
  });
  const outcome = await seats.activateAndBindSeat({ ...activation, acknowledge: ack });
  expect(ack).not.toHaveBeenCalled();
  expect(outcome).toBe('indeterminate');
  expect(await seats.getActiveSeatForWorktree('/work/target')).toMatchObject(stamp);
});

it('retirement repeats after response loss without touching a same-ref replacement or restoring a credential', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  await seats.clearSeat(seats.seatRef(seed));
  await seats.mintPendingSeat({ ...seed, credential: 'B'.repeat(43) });
  const replacement = JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats;
  const reconcile = vi.fn(async () => { throw new Error('lost retirement response'); });
  await expect(seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: true, reconcile })).rejects.toThrow('lost retirement response');
  expect(await seats.readAttachmentAttempt({ ...lookup, attempt: attemptOf(seats) })).toMatchObject({ disposition: 'cleanup-only' });
  const retired = vi.fn(async () => ({ disposition: 'retired' as const }));
  expect(await seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: true, reconcile: retired })).toEqual({ kind: 'retired' });
  expect(JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats).toEqual(replacement);
  expect(await seats.activateAndBindSeat(activation)).toBe('replaced');
});

it.each(['reserved-before-add', 'previously-created-then-absent'])('%s target: default preserves pending state, explicit retirement scrubs only that generation', async history => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  await seats.reserveAttachmentTarget(attemptOf(seats), '/work/target');
  const before = readFileSync(seats.SEATS_FILE, 'utf8');
  const reconcile = vi.fn(async () => ({ disposition: 'retired' as const }));
  if (history === 'previously-created-then-absent') {
    expect(await seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: false,
      targetAbsent: async () => false, reconcile })).toMatchObject({ kind: 'pending', record: { credential: seed.credential } });
  }
  const defaultResult = await seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: false,
    targetAbsent: async () => true, reconcile });
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(before);
  expect(reconcile).not.toHaveBeenCalled();
  expect(defaultResult).toEqual({ kind: 'target-missing' });
  expect(await seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: true,
    expected: { observation: { state: 'pending', digest: activation.expectedPendingDigest }, targetWorktree: '/work/target' },
    targetAbsent: async () => true, reconcile })).toEqual({ kind: 'retired' });
  expect(JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats).toEqual({});
  expect(reconcile).toHaveBeenCalledTimes(1);
});

it('rechecks generation and target existence after consent; ACTIVE is never retired', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  await seats.reserveAttachmentTarget(attemptOf(seats), '/work/target');
  const reconcile = vi.fn(async () => ({ disposition: 'retired' as const }));
  const expected = { observation: { state: 'pending' as const, digest: activation.expectedPendingDigest }, targetWorktree: '/work/target' };
  await expect(seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: true, expected,
    targetAbsent: async () => false, reconcile })).rejects.toThrow(/pending connection still exists/);
  await seats.activateAndBindSeat({ ...activation, acknowledge: async () => {} });
  const active = readFileSync(seats.SEATS_FILE, 'utf8');
  await expect(seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: true, expected,
    targetAbsent: async () => true, reconcile })).rejects.toThrow(/state changed/);
  await expect(seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: true,
    targetAbsent: async () => true, reconcile })).rejects.toThrow(/active attachment/);
  expect(readFileSync(seats.SEATS_FILE, 'utf8')).toBe(active);
  expect(reconcile).not.toHaveBeenCalled();
});

it('retires only the old missing generation while a same-ref ACTIVE replacement stays unchanged', async () => {
  const seats = await load();
  await seats.prepareSeat({ expected: { kind: 'absent' }, seed, attachment });
  await seats.clearSeat(seats.seatRef(seed));
  const replacement = 'B'.repeat(43);
  await seats.mintPendingSeat({ ...seed, credential: replacement });
  expect(await seats.activateAndBindSeat({ ...activation,
    expectedPendingDigest: createHash('sha256').update(replacement).digest('hex'),
    droneId: '88888888-8888-4888-8888-888888888888', sessionId: '77777777-7777-4777-8777-777777777777',
  })).toBe('activated');
  const before = JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats;
  const reconcile = vi.fn(async () => ({ disposition: 'retired' as const }));
  expect(await seats.recoverAttachmentAttempt({ ...lookup, attempt: attemptOf(seats), retire: true, reconcile })).toEqual({ kind: 'retired' });
  const stale = await seats.activateAndBindSeat(activation);
  expect(JSON.parse(readFileSync(seats.SEATS_FILE, 'utf8')).seats).toEqual(before);
  expect(await seats.getActiveSeatForWorktree('/work/target')).toMatchObject({ state: 'active', credential: replacement });
  expect(stale).toBe('replaced');
});
