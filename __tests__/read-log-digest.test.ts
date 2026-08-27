import { describe, expect, it } from 'vitest';
import {
  buildReadLogDigest,
  DIGEST_FETCH_CAP,
  DIGEST_TAIL,
  DIGEST_THRESHOLD,
} from '../src/read-log-digest.js';

const SELF_DRONE_ID = '11111111-1111-4111-8111-111111111111';
const BUILDER_DRONE_ID = '22222222-2222-4222-8222-222222222222';
const COORDINATOR_DRONE_ID = '33333333-3333-4333-8333-333333333333';
const BUILDER_ROLE_ID = '44444444-4444-4444-8444-444444444444';
const COORDINATOR_ROLE_ID = '55555555-5555-4555-8555-555555555555';

describe('buildReadLogDigest', () => {
  it('locks the bounded replay constants', () => {
    expect(DIGEST_THRESHOLD).toBe(50);
    expect(DIGEST_TAIL).toBe(25);
    expect(DIGEST_FETCH_CAP).toBe(2000);
  });

  it('summarizes older entries, preserves directed stubs, and renders the newest tail in full', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      cube_id: '66666666-6666-4666-8666-666666666666',
      drone_id: index % 2 === 0 ? BUILDER_DRONE_ID : COORDINATOR_DRONE_ID,
      message: index % 2 === 0 ? `STARTING item ${index}` : `unclassified item ${index}`,
      visibility: index === 1 || index === 4 ? 'direct' : 'broadcast',
      recipient_drone_ids: index === 1 || index === 4 ? [SELF_DRONE_ID] : [],
      created_at: new Date(Date.UTC(2026, 7, 27, 0, index)).toISOString(),
    }));
    const droneById = new Map([
      [BUILDER_DRONE_ID, { id: BUILDER_DRONE_ID, label: 'builder-1', role_id: BUILDER_ROLE_ID }],
      [COORDINATOR_DRONE_ID, { id: COORDINATOR_DRONE_ID, label: 'coordinator-1', role_id: COORDINATOR_ROLE_ID }],
    ]);
    const roleById = new Map([
      [BUILDER_ROLE_ID, { id: BUILDER_ROLE_ID, name: 'Builder' }],
      [COORDINATOR_ROLE_ID, { id: COORDINATOR_ROLE_ID, name: 'Coordinator' }],
    ]);

    const result = buildReadLogDigest({
      entries,
      selfDroneId: SELF_DRONE_ID,
      taxonomy: [{ class: 'dispatch', prefixes: ['STARTING'] }],
      droneById,
      roleById,
      tail: DIGEST_TAIL,
      capped: 0,
    });

    expect(result.omitted).toBe(5);
    expect(result.tailEntries).toEqual(entries.slice(-DIGEST_TAIL));
    expect(result.text).toContain('Reattach digest — 30 unread entries from 2026-08-27T00:00:00.000Z to 2026-08-27T00:29:00.000Z; 5 older entries are summarized, not shown.');
    expect(result.text).toContain('builder-1 (Builder): 15');
    expect(result.text).toContain('coordinator-1 (Coordinator): 15');
    expect(result.text).toContain('dispatch: 15');
    expect(result.text).toContain('other: 15');
    expect(result.text).toContain(`[entry_id: ${entries[1].id}] coordinator-1 (Coordinator): unclassified item 1`);
    expect(result.text).toContain(`[entry_id: ${entries[4].id}] builder-1 (Builder): STARTING item 4`);
    expect(result.text).toContain(`**[2026-08-27T00:29:00.000Z]** [entry_id: ${entries[29].id}]`);
  });

  it('reports entries left beyond the fetch cap', () => {
    const entries = Array.from({ length: 51 }, (_, index) => ({
      id: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
      drone_id: BUILDER_DRONE_ID,
      message: `entry ${index}`,
      visibility: 'broadcast',
      recipient_drone_ids: [],
      created_at: new Date(Date.UTC(2026, 7, 27, 1, index)).toISOString(),
    }));

    const result = buildReadLogDigest({
      entries,
      selfDroneId: SELF_DRONE_ID,
      taxonomy: null,
      droneById: new Map([
        [BUILDER_DRONE_ID, { id: BUILDER_DRONE_ID, label: 'builder-1', role_id: BUILDER_ROLE_ID }],
      ]),
      roleById: new Map([
        [BUILDER_ROLE_ID, { id: BUILDER_ROLE_ID, name: 'Builder' }],
      ]),
      tail: DIGEST_TAIL,
      capped: 7,
    });

    expect(result.text).toContain('7 additional unread entries were not covered because the 2000-entry fetch cap was reached.');
  });
});
