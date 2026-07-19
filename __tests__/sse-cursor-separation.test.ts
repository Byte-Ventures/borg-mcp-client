import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * client#41 — SSE / unread cursor separation.
 *
 * Regression guard for a silent missed wake: the live SSE stream used to
 * advance the SAME cursor that `read-log unread_only` reads/advances, so a
 * wake-triggering entry consumed by SSE delivery vanished from `unread_only`
 * before the agent could drain it. The fix gives the stream its own delivery
 * cursor (purpose:'stream') and leaves the unread watermark (purpose absent)
 * untouched by delivery — advanced only by an explicit read-log drain.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '22222222-2222-4222-8222-222222222222';
const SENDER_ID = '44444444-4444-4444-8444-444444444444';
const LOG_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST = 'spki-sha256:test-server';

const originalHome = process.env.HOME;
const fixtures: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('client#41 SSE delivery does not consume the unread watermark', () => {
  it('leaves a delivered wake entry unread until an explicit drain advances the watermark', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-sse-cursor-sep-'));
    fixtures.push(fixture);
    process.env.HOME = fixture;
    vi.resetModules();

    const cursor = { id: LOG_ID, created_at: '2026-07-14T14:00:00.000Z' };
    const watermarkBinding = {
      origin: ORIGIN,
      trustIdentity: TRUST,
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
    } as const;
    const streamBinding = { ...watermarkBinding, purpose: 'stream' } as const;

    // A broadcast entry addressed to no one in particular → wakes this drone
    // (writes the inbox line) and carries a resume cursor.
    const wire = [
      'event: log',
      `id: ${LOG_ID}`,
      `data: ${JSON.stringify({
        cursor,
        entry: {
          id: LOG_ID,
          cube_id: CUBE_ID,
          drone_id: SENDER_ID,
          message: 'wake me',
          visibility: 'broadcast',
          created_at: cursor.created_at,
          drone_label: 'peer-1',
          role_name: 'Builder',
          recipient_drone_ids: [],
        },
      })}`,
      '',
      'event: bookmark',
      `data: ${JSON.stringify({ as_of: '2026-07-14T14:00:01.000Z', replay_complete: true })}`,
      '',
    ].join('\n');

    const appendLine = vi.fn(async () => {});
    const { streamOnce } = await import('../src/log-stream.js');
    const { getLocalServerCursor, advanceLocalServerCursor } = await import(
      '../src/local-server-cursor.js'
    );

    // Precondition: both cursors start empty.
    expect(await getLocalServerCursor(watermarkBinding)).toBeNull();
    expect(await getLocalServerCursor(streamBinding)).toBeNull();

    await streamOnce(
      {
        cubeId: CUBE_ID,
        droneId: DRONE_ID,
        sessionToken: 's'.repeat(43),
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST,
      },
      null,
      vi.fn(),
      {
        fetchImpl: vi.fn(async () =>
          new Response(wire, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        ) as typeof fetch,
        appendLine,
        hasInboxEntryId: vi.fn(async () => false),
        abortSignal: new AbortController().signal,
      },
    );

    // The entry was actually delivered (the wake fired).
    expect(appendLine).toHaveBeenCalledWith(
      CUBE_ID,
      DRONE_ID,
      expect.stringContaining('wake me'),
    );

    // The stream/delivery cursor advanced past the delivered entry...
    expect(await getLocalServerCursor(streamBinding)).toEqual(cursor);

    // ...but the UNREAD WATERMARK was NOT advanced by delivery. The entry is
    // still unread — `read-log unread_only` reads from this (null) watermark.
    expect(await getLocalServerCursor(watermarkBinding)).toBeNull();

    // Only an explicit successful drain (the read-log unread_only path) moves
    // the watermark.
    await advanceLocalServerCursor(watermarkBinding, cursor);
    expect(await getLocalServerCursor(watermarkBinding)).toEqual(cursor);
  });
});
