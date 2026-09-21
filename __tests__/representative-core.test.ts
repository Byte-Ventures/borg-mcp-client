/**
 * Behavioral safety properties of the Hermes / human representative core.
 * Backend evidence here is a controlled in-memory mock (see the fixture), not
 * a real Borg server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILDER_ID,
  COORD_ID,
  MockCube,
  OTHER_CUBE_ID,
  REP_ID,
  ROLE_BUILDER,
  bindingFor,
} from './fixtures/representative-mock-backend.js';
import {
  RepresentativeError,
  ackRepresentativeReply,
  assertRepresentativeRole,
  readRepresentativeReplies,
  representativeStatus,
  resolveCoordinator,
  sendRepresentativeMessage,
  type RepresentativeContext,
} from '../src/representative-core.js';
import { createRepresentativeStore } from '../src/representative-store.js';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;
let root: string;
let cube: MockCube;
let ctx: RepresentativeContext;
const WORKTREE = '/work/hermes-representative';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-core-')));
  process.env.HOME = root;
  process.env.BORG_STATE_ROOT = root;
  cube = new MockCube();
  ctx = {
    binding: bindingFor(WORKTREE),
    backend: cube.backend(),
    store: createRepresentativeStore(join(root, '.config', 'borgmcp', 'representative.json')),
  };
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  rmSync(root, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RepresentativeError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

const REQUEST_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

it('preserves document citations on a direct Coordinator reply', async () => {
  const entry = cube.post(COORD_ID, 'The requested design is attached.', [REP_ID]);
  const documents = [{ id: REQUEST_ID, title: 'Design', state: 'active' as const }];
  Object.assign(entry, { documents });
  const result = await readRepresentativeReplies(ctx, {});
  expect(result.replies[0]).toMatchObject({ entry_id: entry.id, message: entry.message, documents });
});

describe('Coordinator selection', () => {
  const roster = () => ({ drones: cube.drones, roles: cube.roles });

  it('selects exactly the named human-seat Coordinator drone', () => {
    const selected = resolveCoordinator(roster(), { label: 'coordinator-1', selfDroneId: REP_ID });
    expect(selected.drone.id).toBe(COORD_ID);
    expect(selected.role.name).toBe('Coordinator');
  });

  it('fails clearly when the named Coordinator is missing or evicted, never choosing another drone', () => {
    cube.drones = cube.drones.filter((drone) => drone.id !== COORD_ID);
    expect(() => resolveCoordinator(roster(), { label: 'coordinator-1', selfDroneId: REP_ID }))
      .toThrowError(expect.objectContaining({ code: 'COORDINATOR_NOT_FOUND' }));
  });

  it('fails on an ambiguous label', () => {
    cube.drones.push({ id: '55555555-5555-4555-8555-555555555555', label: 'coordinator-1', role_id: cube.drones[1].role_id });
    expect(() => resolveCoordinator(roster(), { label: 'coordinator-1', selfDroneId: REP_ID }))
      .toThrowError(expect.objectContaining({ code: 'COORDINATOR_AMBIGUOUS' }));
  });

  it('refuses a worker drone as the Coordinator target', () => {
    expect(() => resolveCoordinator(roster(), { label: 'builder-1', selfDroneId: REP_ID }))
      .toThrowError(expect.objectContaining({ code: 'COORDINATOR_NOT_HUMAN_SEAT' }));
  });

  it('refuses to occupy a human-seat or queen-class role as the representative', () => {
    expect(() => assertRepresentativeRole({ name: 'Coordinator', is_human_seat: true, role_class: 'queen' }))
      .toThrowError(expect.objectContaining({ code: 'REPRESENTATIVE_ROLE_NOT_PERMITTED' }));
    expect(() => assertRepresentativeRole({ name: 'Lead', is_human_seat: false, role_class: 'queen' }))
      .toThrowError(expect.objectContaining({ code: 'REPRESENTATIVE_ROLE_NOT_PERMITTED' }));
    expect(() => assertRepresentativeRole({ name: 'hermes-representative', is_human_seat: false, role_class: 'worker' }))
      .not.toThrow();
  });
});

describe('send', () => {
  it('delivers only to the bound Coordinator with automated-representation attribution', async () => {
    const result = await sendRepresentativeMessage(ctx, {
      request_id: REQUEST_ID,
      kind: 'decision',
      authorization: 'user_authorized',
      message: 'Ship option B.',
    });
    expect(result.outcome).toBe('sent');
    expect(result.request_id).toBe(REQUEST_ID);
    expect(cube.appendCalls).toHaveLength(1);
    expect(cube.appendCalls[0].to).toEqual([COORD_ID]);
    expect(cube.appendCalls[0].postId).toBe(REQUEST_ID);
    const text = cube.appendCalls[0].message;
    expect(text).toContain('HUMAN-REPRESENTATIVE');
    expect(text).toContain('automated');
    expect(text).toContain(`request_id: ${REQUEST_ID}`);
    expect(text).toContain('kind: decision');
    expect(text).toContain('authorization: user-authorized');
    expect(text).toContain('not verified by Borg');
    expect(text).toContain('Ship option B.');
  });

  it('labels model advice as not a human decision', async () => {
    await sendRepresentativeMessage(ctx, { kind: 'question', authorization: 'model_advice', message: 'Consider B?' });
    expect(cube.appendCalls[0].message).toContain('authorization: model-advice');
    expect(cube.appendCalls[0].message).toContain('NOT a human decision');
  });

  it('refuses a decision that is only model advice', async () => {
    expect(await codeOf(sendRepresentativeMessage(ctx, {
      kind: 'decision', authorization: 'model_advice', message: 'Approve everything.',
    }))).toBe('DECISION_REQUIRES_USER_AUTHORIZATION');
    expect(cube.appendCalls).toHaveLength(0);
  });

  it('rejects any caller-supplied recipient, broadcast, or unknown field', async () => {
    for (const extra of [{ to: [BUILDER_ID] }, { to: 'broadcast' }, { recipients: [BUILDER_ID] }, { class: 'DISPATCH' }]) {
      expect(await codeOf(sendRepresentativeMessage(ctx, {
        kind: 'request', authorization: 'user_authorized', message: 'Build it.', ...extra,
      } as never))).toBe('INVALID_INPUT');
    }
    expect(cube.appendCalls).toHaveLength(0);
  });

  it('does not duplicate a retried request id and refuses a changed payload under the same id', async () => {
    const input = { request_id: REQUEST_ID, kind: 'request', authorization: 'user_authorized', message: 'Do X.' } as const;
    const first = await sendRepresentativeMessage(ctx, input);
    const second = await sendRepresentativeMessage(ctx, input);
    expect(second.outcome).toBe('sent');
    expect(second.duplicate).toBe(true);
    expect(second.entry_id).toBe(first.entry_id);
    expect(cube.entries).toHaveLength(1);
    expect(cube.appendCalls).toHaveLength(1);
    expect(await codeOf(sendRepresentativeMessage(ctx, { ...input, message: 'Do Y instead.' })))
      .toBe('REQUEST_ID_CONFLICT');
    expect(cube.entries).toHaveLength(1);
  });

  it('surfaces a lost response as ambiguous without auto-resending, and an explicit same-id retry deduplicates', async () => {
    cube.appendPlan = ['lost-response'];
    const input = { request_id: REQUEST_ID, kind: 'request', authorization: 'user_authorized', message: 'Do X.' } as const;
    const ambiguous = await sendRepresentativeMessage(ctx, input);
    expect(ambiguous.outcome).toBe('ambiguous');
    expect(ambiguous.request_id).toBe(REQUEST_ID);
    expect(cube.appendCalls).toHaveLength(1); // no automatic resend
    expect(cube.entries).toHaveLength(1); // the server DID store it

    // Same content under a NEW id would duplicate the work: refused.
    expect(await codeOf(sendRepresentativeMessage(ctx, { ...input, request_id: undefined })))
      .toBe('AMBIGUOUS_SEND_UNRESOLVED');
    expect(cube.appendCalls).toHaveLength(1);

    const retried = await sendRepresentativeMessage(ctx, input);
    expect(retried.outcome).toBe('sent');
    expect(retried.deduplicated).toBe(true);
    expect(cube.entries).toHaveLength(1);
    expect((await representativeStatus(ctx)).unresolved_requests).toEqual([]);
  });

  it('keeps an ambiguous send across a reconnect (new process, same store)', async () => {
    cube.appendPlan = ['never-arrived'];
    const input = { request_id: REQUEST_ID, kind: 'request', authorization: 'user_authorized', message: 'Do X.' } as const;
    expect((await sendRepresentativeMessage(ctx, input)).outcome).toBe('ambiguous');
    const reconnected: RepresentativeContext = {
      ...ctx,
      store: createRepresentativeStore(join(root, '.config', 'borgmcp', 'representative.json')),
    };
    const status = await representativeStatus(reconnected);
    expect(status.unresolved_requests.map((r) => r.request_id)).toEqual([REQUEST_ID]);
    const retried = await sendRepresentativeMessage(reconnected, input);
    expect(retried.outcome).toBe('sent');
    expect(cube.entries).toHaveLength(1);
  });

  it('reports a definite server rejection as failed, not ambiguous', async () => {
    cube.appendPlan = ['rejected'];
    expect(await codeOf(sendRepresentativeMessage(ctx, {
      request_id: REQUEST_ID, kind: 'request', authorization: 'user_authorized', message: 'Do X.',
    }))).toBe('SEND_REJECTED');
    expect((await representativeStatus(ctx)).unresolved_requests).toEqual([]);
  });

  it('fails closed before sending when the live seat is in another cube', async () => {
    cube.whoamiCubeId = OTHER_CUBE_ID;
    expect(await codeOf(sendRepresentativeMessage(ctx, {
      kind: 'request', authorization: 'user_authorized', message: 'Do X.',
    }))).toBe('BINDING_MISMATCH');
    expect(cube.appendCalls).toHaveLength(0);
  });

  it('fails closed when the bound Coordinator was evicted, even if another human-seat drone exists', async () => {
    cube.drones = cube.drones.filter((drone) => drone.id !== COORD_ID);
    cube.drones.push({ id: '66666666-6666-4666-8666-666666666666', label: 'coordinator-2', role_id: cube.roles[1].id });
    expect(await codeOf(sendRepresentativeMessage(ctx, {
      kind: 'request', authorization: 'user_authorized', message: 'Do X.',
    }))).toBe('COORDINATOR_UNAVAILABLE');
    expect(cube.appendCalls).toHaveLength(0);
  });

  it('fails closed when the bound Coordinator drone no longer holds a human-seat role', async () => {
    cube.drones[1].role_id = ROLE_BUILDER;
    expect(await codeOf(sendRepresentativeMessage(ctx, {
      kind: 'request', authorization: 'user_authorized', message: 'Do X.',
    }))).toBe('COORDINATOR_UNAVAILABLE');
  });

  it('fails closed when the representative seat was reassigned to a human-seat role', async () => {
    cube.drones[0].role_id = cube.roles[1].id;
    expect(await codeOf(sendRepresentativeMessage(ctx, {
      kind: 'request', authorization: 'user_authorized', message: 'Do X.',
    }))).toBe('REPRESENTATIVE_ROLE_NOT_PERMITTED');
  });

  it('stores the request ledger privately and without message text', async () => {
    await sendRepresentativeMessage(ctx, {
      request_id: REQUEST_ID, kind: 'request', authorization: 'user_authorized', message: 'secret plan text',
    });
    const file = join(root, '.config', 'borgmcp', 'representative.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('secret plan text');
  });
});

describe('read and acknowledge', () => {
  it('returns only the bound Coordinator\'s entries and correlates quoted request ids', async () => {
    await sendRepresentativeMessage(ctx, {
      request_id: REQUEST_ID, kind: 'question', authorization: 'user_authorized', message: 'A or B?',
    });
    cube.post(BUILDER_ID, 'builder chatter to representative', [REP_ID]);
    cube.post(COORD_ID, 'dispatch for builder only', [BUILDER_ID]);
    const reply = cube.post(COORD_ID, `Re request_id ${REQUEST_ID}: choose B.`, [REP_ID]);
    cube.post(COORD_ID, 'cube-wide notice', 'broadcast');

    const result = await readRepresentativeReplies(ctx, {});
    expect(result.replies.map((r) => r.entry_id)).toEqual([reply.id]);
    expect(result.replies[0].in_reply_to).toBe(REQUEST_ID);
    expect(result.replies[0].from_drone_id).toBe(COORD_ID);
    expect(result.ignored_entries).toBe(4);
    expect(JSON.stringify(result)).not.toContain('builder chatter');
    expect(JSON.stringify(result)).not.toContain('dispatch for builder');
  });

  it('includes Coordinator broadcasts only on request and marks them', async () => {
    const notice = cube.post(COORD_ID, 'cube-wide notice', 'broadcast');
    const result = await readRepresentativeReplies(ctx, { include_broadcast: true });
    expect(result.replies).toEqual([expect.objectContaining({ entry_id: notice.id, addressed: 'broadcast' })]);
  });

  it('acknowledges only a Coordinator reply addressed to the representative', async () => {
    const reply = cube.post(COORD_ID, 'choose B', [REP_ID]);
    const foreign = cube.post(BUILDER_ID, 'ack me', [REP_ID]);
    const notMine = cube.post(COORD_ID, 'dispatch', [BUILDER_ID]);
    await ackRepresentativeReply(ctx, { entry_id: reply.id });
    expect(cube.acks).toEqual([reply.id]);
    expect(await codeOf(ackRepresentativeReply(ctx, { entry_id: foreign.id }))).toBe('NOT_A_COORDINATOR_REPLY');
    expect(await codeOf(ackRepresentativeReply(ctx, { entry_id: notMine.id }))).toBe('NOT_A_COORDINATOR_REPLY');
    expect(cube.acks).toEqual([reply.id]);
  });
});

describe('binding store', () => {
  it('requires explicit operator rebind to change the selected cube or Coordinator', async () => {
    expect(await ctx.store.saveBinding(bindingFor(WORKTREE), { rebind: false })).toBe('created');
    expect(await ctx.store.saveBinding(bindingFor(WORKTREE), { rebind: false })).toBe('unchanged');
    await expect(ctx.store.saveBinding(
      bindingFor(WORKTREE, { coordinatorDroneId: BUILDER_ID, coordinatorLabel: 'builder-1' }),
      { rebind: false },
    )).rejects.toMatchObject({ code: 'BINDING_CONFLICT' });
    await expect(ctx.store.saveBinding(bindingFor(WORKTREE, { cubeId: OTHER_CUBE_ID }), { rebind: false }))
      .rejects.toMatchObject({ code: 'BINDING_CONFLICT' });
    expect((await ctx.store.getBinding(WORKTREE))?.coordinatorDroneId).toBe(COORD_ID);
    expect(await ctx.store.saveBinding(
      bindingFor(WORKTREE, { coordinatorDroneId: BUILDER_ID, coordinatorLabel: 'builder-1' }),
      { rebind: true },
    )).toBe('rebound');
  });

  it('refuses a malformed store instead of treating it as unbound', async () => {
    await ctx.store.saveBinding(bindingFor(WORKTREE), { rebind: false });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, '.config', 'borgmcp', 'representative.json'), '{"version":7}', { mode: 0o600 });
    await expect(ctx.store.getBinding(WORKTREE)).rejects.toThrow(/malformed|unsupported/);
  });
});
