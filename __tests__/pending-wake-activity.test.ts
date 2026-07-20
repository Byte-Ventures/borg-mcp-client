import { describe, expect, it, vi } from 'vitest';
import { hasPendingWakeActivity } from '../src/remote-client';

const ACTIVE = {
  cubeId: '11111111-1111-4111-8111-111111111111',
  droneId: '22222222-2222-4222-8222-222222222222',
  name: 'cube',
  sessionToken: 'session',
  droneLabel: 'builder-1',
  apiUrl: 'https://localhost:8787',
  serverTrustIdentity: 'spki-sha256:test',
};

const cursor = (id: string) => ({ id, created_at: '2026-07-20T00:00:00.000Z' });

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  cube_id: ACTIVE.cubeId,
  drone_id: '44444444-4444-4444-8444-444444444444',
  message: 'real activity',
  visibility: 'broadcast',
  recipient_drone_ids: [],
  created_at: '2026-07-20T00:00:00.000Z',
  ...overrides,
});

describe('hasPendingWakeActivity', () => {
  it('returns false without advancing the unread cursor when every page is idle-only', async () => {
    const getCursor = vi.fn(async () => cursor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    const readPage = vi.fn()
      .mockResolvedValueOnce({
        entries: [
          entry({ drone_id: ACTIVE.droneId, message: 'own post' }),
          entry({
            visibility: 'direct',
            recipient_drone_ids: ['55555555-5555-4555-8555-555555555555'],
          }),
        ],
        cursor: cursor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        has_more: true,
      })
      .mockResolvedValueOnce({
        entries: [entry({ drone_id: ACTIVE.droneId, message: 'another own post' })],
        cursor: cursor('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
        has_more: false,
      });

    await expect(hasPendingWakeActivity(ACTIVE, { getCursor, readPage })).resolves.toBe(false);
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('finds missed directed work beyond skipped own and unaddressed entries', async () => {
    const readPage = vi.fn(async () => ({
      entries: [
        entry({ drone_id: ACTIVE.droneId, message: 'own post' }),
        entry({
          visibility: 'direct',
          recipient_drone_ids: ['55555555-5555-4555-8555-555555555555'],
        }),
        entry({ visibility: 'direct', recipient_drone_ids: [ACTIVE.droneId] }),
      ],
      cursor: cursor('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
      has_more: false,
    }));

    await expect(hasPendingWakeActivity(ACTIVE, {
      getCursor: async () => null,
      readPage,
    })).resolves.toBe(true);
  });
});
