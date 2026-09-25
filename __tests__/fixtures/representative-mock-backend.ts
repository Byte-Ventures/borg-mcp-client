/**
 * Controlled in-memory stand-in for one Borg cube, used by the human
 * representative tests. It is MOCK evidence only: it models the shared
 * protocol's `post_id` append idempotency and direct addressing, not a real
 * server. Transport failures are injected per call.
 */
import { randomUUID } from 'node:crypto';
import type { RepresentativeBackend } from '../../src/representative-core.js';
import type { RepresentativeBinding } from '../../src/representative-store.js';
import { BorgServerHttpError, BorgServerUnreachableError } from '../../src/server-errors.js';

export const CUBE_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_CUBE_ID = '99999999-9999-4999-8999-999999999999';
export const REP_ID = '22222222-2222-4222-8222-222222222222';
export const COORD_ID = '33333333-3333-4333-8333-333333333333';
export const BUILDER_ID = '44444444-4444-4444-8444-444444444444';
export const ROLE_REP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ROLE_COORD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ROLE_BUILDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export interface MockEntry {
  id: string;
  cube_id: string;
  drone_id: string;
  message: string;
  visibility: 'direct' | 'broadcast';
  created_at: string;
  drone_label: string;
  role_name: string;
  recipient_drone_ids: string[];
}

export function bindingFor(worktree: string, overrides: Partial<RepresentativeBinding> = {}): RepresentativeBinding {
  return {
    worktree,
    origin: 'https://127.0.0.1:65530',
    trustIdentity: 'sha256:mock-server',
    cubeId: CUBE_ID,
    cubeName: 'mock-cube',
    representativeDroneId: REP_ID,
    representativeLabel: 'hermes-1',
    representativeRoleName: 'hermes-representative',
    coordinatorDroneId: COORD_ID,
    coordinatorLabel: 'coordinator-1',
    coordinatorRoleName: 'Coordinator',
    boundAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export class MockCube {
  roles = [
    { id: ROLE_REP, name: 'hermes-representative', is_human_seat: false, role_class: 'worker' },
    { id: ROLE_COORD, name: 'Coordinator', is_human_seat: true, role_class: 'queen' },
    { id: ROLE_BUILDER, name: 'Builder', is_human_seat: false, role_class: 'worker' },
  ];
  drones = [
    { id: REP_ID, label: 'hermes-1', role_id: ROLE_REP },
    { id: COORD_ID, label: 'coordinator-1', role_id: ROLE_COORD },
    { id: BUILDER_ID, label: 'builder-1', role_id: ROLE_BUILDER },
  ];
  whoamiCubeId = CUBE_ID;
  entries: MockEntry[] = [];
  posts = new Map<string, { fingerprint: string; entry: MockEntry }>();
  acks: string[] = [];
  appendCalls: Array<{ postId: string; message: string; to: string[] }> = [];
  calls: string[] = [];
  /** Queue of append behaviours; default is 'ok'. */
  appendPlan: Array<'ok' | 'lost-response' | 'never-arrived' | 'rejected' | { error: unknown; stored: boolean }> = [];
  /** When set, every append waits here first, so tests can hold calls in flight. */
  appendGate: Promise<void> | null = null;
  /** Simulated latency of the live-binding check, to expose check-then-act races. */
  verifyDelayMs = 0;
  private tick = 0;

  private stamp(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }

  /** Client-owned unread cursor as an earlier (5.5.0) read left it; migration input. */
  unreadCursorValue: { id: string; created_at: string } | null = null;

  post(from: string, message: string, to: string[] | 'broadcast', createdAt?: string): MockEntry {
    const drone = this.drones.find((candidate) => candidate.id === from);
    const role = this.roles.find((candidate) => candidate.id === drone?.role_id);
    const entry: MockEntry = {
      id: randomUUID(),
      cube_id: CUBE_ID,
      drone_id: from,
      message,
      visibility: to === 'broadcast' ? 'broadcast' : 'direct',
      created_at: createdAt ?? this.stamp(),
      drone_label: drone?.label ?? 'unknown',
      role_name: role?.name ?? 'unknown',
      recipient_drone_ids: to === 'broadcast' ? [] : [...to],
    };
    this.entries.push(entry);
    return entry;
  }

  backend(): RepresentativeBackend {
    return {
      whoami: async () => {
        this.calls.push('whoami');
        if (this.verifyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.verifyDelayMs));
        const self = this.drones.find((candidate) => candidate.id === REP_ID);
        if (!self) throw new Error('Local Borg server no longer recognizes this drone');
        const role = this.roles.find((candidate) => candidate.id === self.role_id)!;
        return {
          cube_id: this.whoamiCubeId,
          cube_name: 'mock-cube',
          drone_id: self.id,
          drone_label: self.label,
          role_id: role.id,
          role_name: role.name,
        };
      },
      roster: async () => {
        this.calls.push('roster');
        return { drones: this.drones.map((d) => ({ ...d })), roles: this.roles.map((r) => ({ ...r })) };
      },
      append: async ({ postId, message, to }) => {
        this.calls.push('append');
        this.appendCalls.push({ postId, message, to: [...to] });
        if (this.appendGate) await this.appendGate;
        const plan = this.appendPlan.shift() ?? 'ok';
        if (typeof plan === 'object' && !plan.stored) throw plan.error;
        if (plan === 'never-arrived') {
          throw new BorgServerUnreachableError('Local Borg server request timed out');
        }
        if (plan === 'rejected') {
          throw new BorgServerHttpError(400, 'Borg server request failed (HTTP 400)', 'INVALID_INPUT' as never);
        }
        const fingerprint = JSON.stringify([message, to]);
        const prior = this.posts.get(postId);
        let entry: MockEntry;
        let deduplicated = false;
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            throw new BorgServerHttpError(409, 'Borg server request failed (HTTP 409)', 'POST_ID_CONFLICT' as never);
          }
          entry = prior.entry;
          deduplicated = true;
        } else {
          entry = this.post(REP_ID, message, to);
          this.posts.set(postId, { fingerprint, entry });
        }
        if (typeof plan === 'object') throw plan.error;
        if (plan === 'lost-response') {
          throw new BorgServerUnreachableError('Local Borg server request timed out');
        }
        return { entry, deduplicated };
      },
      // Stateless page strictly after an exact (created_at, id) cursor, ascending.
      readAfter: async (cursor, limit) => {
        this.calls.push('readAfter');
        const after = (e: MockEntry) => cursor === null || e.created_at > cursor.created_at ||
          (e.created_at === cursor.created_at && e.id > cursor.id);
        const ordered = [...this.entries].sort((a, b) =>
          a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const remaining = ordered.filter(after);
        const page = remaining.slice(0, limit);
        const last = page.at(-1);
        return {
          entries: page.map((e) => ({ ...e })),
          has_more: remaining.length > page.length,
          cursor: last ? { id: last.id, created_at: last.created_at } : cursor,
        };
      },
      unreadCursor: async () => {
        this.calls.push('unreadCursor');
        return this.unreadCursorValue ? { ...this.unreadCursorValue } : null;
      },
      readEntry: async (entryId) => {
        this.calls.push('readEntry');
        const entry = this.entries.find((candidate) => candidate.id === entryId);
        if (!entry) {
          throw Object.assign(new Error('Borg server request failed (HTTP 404)'), {
            name: 'BorgServerHttpError', status: 404, code: 'NOT_FOUND',
          });
        }
        return { entry: { ...entry } };
      },
      ack: async (entryId) => {
        this.calls.push('ack');
        this.acks.push(entryId);
      },
    };
  }
}
