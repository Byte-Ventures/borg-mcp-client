import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * client#42 — CURSOR_EXPIRED recovery.
 *
 * The server returns 410 CURSOR_EXPIRED when the stream's resume cursor points
 * at a pruned entry. The client used to handle ONLY DRONE_EVICTED on a 410 and
 * fall through to a generic reconnect that retried the SAME expired cursor
 * forever → a wedged, silently-dead wake path. The fix resets (clears) the
 * stream resume cursor and throws a distinct recoverable error so the next
 * connect re-establishes from a fresh valid point.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '22222222-2222-4222-8222-222222222222';
const EXPIRED_ID = '33333333-3333-4333-8333-333333333333';
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

const active = {
  cubeId: CUBE_ID,
  droneId: DRONE_ID,
  sessionToken: 's'.repeat(43),
  apiUrl: ORIGIN,
  serverTrustIdentity: TRUST,
} as const;

describe('client#42 410 CURSOR_EXPIRED resets the stream cursor and recovers', () => {
  it('resets the stale cursor, does not treat it as DRONE_EVICTED, and resumes from a fresh point', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-cursor-expired-'));
    fixtures.push(fixture);
    process.env.HOME = fixture;
    vi.resetModules();

    const expiredCursor = { id: EXPIRED_ID, created_at: '2026-07-14T14:00:00.000Z' };
    const watermarkBinding = {
      origin: ORIGIN,
      trustIdentity: TRUST,
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
    } as const;
    const streamBinding = { ...watermarkBinding, purpose: 'stream' } as const;

    const { streamOnce, StreamCursorExpiredError } = await import('../src/log-stream.js');
    const { DroneEvictedError } = await import('../src/drone-lifecycle.js');
    const { getLocalServerCursor, advanceLocalServerCursor } = await import(
      '../src/local-server-cursor.js'
    );

    // Seed the STREAM resume cursor with a value the server will reject as
    // expired. The unread watermark is intentionally left empty.
    await advanceLocalServerCursor(streamBinding, expiredCursor);
    expect(await getLocalServerCursor(streamBinding)).toEqual(expiredCursor);

    // ── First connect: server rejects the stale resume cursor with 410 ──
    const expiredFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ protocol_version: '1', error: { code: 'CURSOR_EXPIRED', message: 'expired' } }),
        { status: 410, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const thrown = await streamOnce(active, null, vi.fn(), {
      fetchImpl: expiredFetch as typeof fetch,
      appendLine: vi.fn(async () => {}),
      hasInboxEntryId: vi.fn(async () => false),
      abortSignal: new AbortController().signal,
    }).then(
      () => null,
      (err) => err,
    );

    // Recoverable, cause-accurate — NOT the terminal eviction path.
    expect(thrown).toBeInstanceOf(StreamCursorExpiredError);
    expect(thrown).not.toBeInstanceOf(DroneEvictedError);

    // First connect DID carry the (now-expired) resume cursor.
    expect(expiredFetch).toHaveBeenCalledTimes(1);
    expect(String(expiredFetch.mock.calls[0][0])).toContain('cursor=');

    // The stale stream cursor was reset; the unread watermark is untouched.
    expect(await getLocalServerCursor(streamBinding)).toBeNull();
    expect(await getLocalServerCursor(watermarkBinding)).toBeNull();

    // ── Second connect: proves recovery — a fresh connect no longer loops on
    // the dead cursor and resumes streaming from the current tail. ──
    const recoveredFetch = vi.fn(async () =>
      new Response(
        `event: bookmark\ndata: ${JSON.stringify({ as_of: '2026-07-14T14:00:01.000Z', replay_complete: true })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    await expect(
      streamOnce(active, null, vi.fn(), {
        fetchImpl: recoveredFetch as typeof fetch,
        appendLine: vi.fn(async () => {}),
        hasInboxEntryId: vi.fn(async () => false),
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    // The recovering connect omits the (reset) cursor — it did NOT retry the
    // stale one.
    expect(recoveredFetch).toHaveBeenCalledTimes(1);
    expect(String(recoveredFetch.mock.calls[0][0])).not.toContain('cursor=');
  });
});
