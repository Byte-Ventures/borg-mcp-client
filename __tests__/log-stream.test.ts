/**
 * Tests for the SSE log-stream consumer.
 *
 * Focus per drone-3's QA-PRE-APPROVED PR-2 ask: the trigger-path test
 * for §(5) heartbeat-hwm divergence — synthesize a heartbeat with
 * `hwm: X` against a cursor `lastPersistedEventId: Y` and assert the
 * grace path permits the matching live event before reconnecting.
 *
 * Other tests cover: parseSSE round-trip, happy log-event path,
 * recent-ids dedup advancing the cursor without re-appending, and
 * the first-heartbeat absorb on a fresh-connect (no Last-Event-ID).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  streamOnce,
  streamOnceIfOwner,
  parseSSE,
  getStreamStatus,
  __resetStreamStateForTest,
  formatInboxLine,
  inboxRawHasEntry,
  appendCappedInboxLine,
  trimInboxFileToRecentLines,
  type StreamDeps,
  startLogStream,
  ensureCodexHeartbeatStarted,
  stopCodexHeartbeat,
  __resetCodexHeartbeatForTest,
  type EnrichedEntry,
} from '../src/log-stream';

// The only stream transport is the verified local (self-hosted) server; every
// cube fixture carries a trust identity + local endpoint. The injected fetchImpl
// bypasses the real pinned-TLS trust load. The transport-agnostic SSE logic
// (parse, dedup, hwm divergence, own-post filter, ack fan-out) is exercised
// through this local path.
const ACTIVE_CUBE = {
  cubeId: '11111111-1111-4111-8111-111111111111',
  droneId: '22222222-2222-4222-8222-222222222222',
  sessionToken: 'token-1',
  apiUrl: 'https://127.0.0.1:8443',
  serverTrustIdentity: 'trust-1',
};

const UUID_ACTIVE_CUBE = ACTIVE_CUBE;

// Local SSE cursor is disk-backed; stub it so the stream logic runs without
// touching ~/.config and without a persisted cursor.
vi.mock('../src/local-server-cursor.js', () => ({
  getLocalServerCursor: vi.fn(async () => null),
  advanceLocalServerCursor: vi.fn(async () => {}),
  encodeLocalServerCursor: vi.fn(() => ''),
}));

/**
 * Build a Response whose body emits the given SSE event blocks then
 * closes — mimics the local server stream.
 */
function makeSSEResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeOpenSSEResponse(blocks: string[]): {
  response: Response;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      close = () => controller.close();
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    close,
  };
}

function makeAbortableOpenSSEResponse(
  blocks: string[],
  signal: AbortSignal
): Response {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      signal.addEventListener(
        'abort',
        () => {
          controllerRef?.close();
        },
        { once: true }
      );
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('timed out waiting for condition');
}

function stopChild(proc: ChildProcessWithoutNullStreams): void {
  if (!proc.killed) proc.kill();
}

function makeDeps(fetchImpl: typeof fetch, appendLine?: any): StreamDeps {
  return {
    fetchImpl,
    appendLine: appendLine ?? vi.fn().mockResolvedValue(undefined),
    wakeCodex: vi.fn(),
    // Tight watchdog so any timer-based path doesn't hang the test.
    heartbeatTimeoutMs: 500,
    hwmDivergenceGraceMs: 10,
  };
}

// ---------------- formatInboxLine ----------------

describe('formatInboxLine — newline join', () => {
  const baseEntry: EnrichedEntry = {
    created_at: '2026-05-26T12:00:00.000Z',
    drone_label: 'drone-1',
    role_name: 'Coordinator',
    message: '',
  };

  it('passes single-line messages through unchanged', () => {
    const line = formatInboxLine({ ...baseEntry, message: 'REVIEW-READY: feat/x' });
    expect(line).toBe(
      '2026-05-26T12:00:00.000Z drone-1 (Coordinator): REVIEW-READY: feat/x'
    );
  });

  it('prefixes messages with the activity log entry_id when present', () => {
    const line = formatInboxLine({
      ...baseEntry,
      id: 'entry-123',
      message: 'DISPATCH: drone-2 — review branch',
    });
    expect(line).toBe(
      '2026-05-26T12:00:00.000Z drone-1 (Coordinator): [entry_id: entry-123] DISPATCH: drone-2 — review branch'
    );
  });

  it('prefixes messages with entry_id when the payload carries the legacy field name', () => {
    const line = formatInboxLine({
      ...baseEntry,
      entry_id: 'entry-123',
      message: 'DISPATCH: drone-2 — review branch',
    });
    expect(line).toBe(
      '2026-05-26T12:00:00.000Z drone-1 (Coordinator): [entry_id: entry-123] DISPATCH: drone-2 — review branch'
    );
  });

  it('replaces each \\n with " ⏎ " so the entry fits on one physical line', () => {
    const line = formatInboxLine({
      ...baseEntry,
      message: 'REVIEW-READY: feat/x\n## Verification\n- foo',
    });
    expect(line).toBe(
      '2026-05-26T12:00:00.000Z drone-1 (Coordinator): REVIEW-READY: feat/x ⏎ ## Verification ⏎ - foo'
    );
  });

  it('normalizes CRLF and bare CR to the same separator', () => {
    const line = formatInboxLine({
      ...baseEntry,
      message: 'a\r\nb\rc\nd',
    });
    expect(line).toBe(
      '2026-05-26T12:00:00.000Z drone-1 (Coordinator): a ⏎ b ⏎ c ⏎ d'
    );
  });

  it('preserves consecutive newlines as consecutive separators', () => {
    const line = formatInboxLine({
      ...baseEntry,
      message: 'paragraph one\n\nparagraph two',
    });
    expect(line).toBe(
      '2026-05-26T12:00:00.000Z drone-1 (Coordinator): paragraph one ⏎  ⏎ paragraph two'
    );
  });
});

// ---------------- parseSSE ----------------

describe('parseSSE', () => {
  it('parses log + heartbeat + bookmark in order', async () => {
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: log\nid: e1\ndata: {"id":"e1","message":"hi"}\n\n',
      'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:01Z","hwm":{"id":"e1","created_at":"2026-05-11T12:00:01Z"}}\n\n',
    ];
    const resp = makeSSEResponse(blocks);
    const events: any[] = [];
    for await (const e of parseSSE(resp.body!)) events.push(e);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: 'bookmark',
      as_of: '2026-05-11T12:00:00Z',
    });
    expect(events[1]).toMatchObject({
      type: 'log',
      id: 'e1',
      data: { id: 'e1', message: 'hi' },
    });
    expect(events[2]).toEqual({
      type: 'heartbeat',
      ts: '2026-05-11T12:00:01Z',
      hwm: { id: 'e1', created_at: '2026-05-11T12:00:01Z' },
    });
  });

  it('handles partial reads across chunk boundaries', async () => {
    // Split one event across two chunks to verify buffering.
    const blocks = [
      'event: log\nid: e1\ndata: {"id":"e1",',
      '"message":"hi"}\n\n',
    ];
    const resp = makeSSEResponse(blocks);
    const events: any[] = [];
    for await (const e of parseSSE(resp.body!)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'log', id: 'e1' });
  });

  // gh#877 Path-A: terminal eviction control frame.
  it('parses an eviction event into a typed eviction ParsedEvent', async () => {
    const blocks = [
      'event: eviction\ndata: {"cube_id":"cube-1","reason":"evicted from cube"}\n\n',
    ];
    const resp = makeSSEResponse(blocks);
    const events: any[] = [];
    for await (const e of parseSSE(resp.body!)) events.push(e);
    expect(events).toEqual([
      { type: 'eviction', cube_id: 'cube-1', reason: 'evicted from cube' },
    ]);
  });

  // SEC R5: an UNKNOWN/forged event type must still no-op (default-ignore).
  it('parses a forged/unknown event type as unknown (default-ignore preserved)', async () => {
    const blocks = ['event: totally-made-up\ndata: {"x":1}\n\n'];
    const resp = makeSSEResponse(blocks);
    const events: any[] = [];
    for await (const e of parseSSE(resp.body!)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unknown');
  });
});

// ---------------- streamOnce ----------------

describe('streamOnce', () => {
  it.each([
    ['cube_id', { cubeId: '../protocol' }],
    ['drone_id', { droneId: 'not-a-uuid' }],
  ])('rejects a malformed persisted %s before trust, cursor, or network access', async (label, invalid) => {
    const networkFetch = vi.fn();
    const loadTrust = vi.fn(async () => ({
      identity: UUID_ACTIVE_CUBE.serverTrustIdentity,
      fetchImpl: networkFetch as typeof fetch,
    }));
    const getCursor = vi.fn();

    await expect(streamOnce(
      { ...UUID_ACTIVE_CUBE, ...invalid },
      null,
      vi.fn(),
      { loadTrust, getCursor },
    )).rejects.toThrow(new RegExp(`${label} .* not a UUID`));

    expect(loadTrust).not.toHaveBeenCalled();
    expect(getCursor).not.toHaveBeenCalled();
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it('treats obsolete AUTH_EXPIRED as a terminal credential rejection', async () => {
    const expired = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '3',
      error: { code: 'AUTH_EXPIRED', message: 'Authentication failed.' },
    }), { status: 401 }));
    await expect(streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(expired as typeof fetch)))
      .rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });

    const stale = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '3',
      error: { code: 'SESSION_REJECTED', message: 'Authentication failed.' },
    }), { status: 401 }));
    await expect(streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(stale as typeof fetch)))
      .rejects.toMatchObject({ code: 'SESSION_REJECTED' });
  });

  it('duplicate-process boundary: only stream owner fetches and appends', async () => {
    const locksDir = await mkdtemp(path.join(tmpdir(), 'borg-stream-owner-boundary-'));
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const { response, close } = makeOpenSSEResponse([
      'event: log\nid: e1\ndata: {"id":"e1","drone_label":"drone-2","role_name":"Reviewer","message":"hello","created_at":"2026-05-11T12:00:01Z"}\n\n',
    ]);
    const ownerFetch = vi.fn().mockResolvedValue(response);
    const skippedFetch = vi.fn().mockResolvedValue(makeSSEResponse([]));

    const first = streamOnceIfOwner(
      UUID_ACTIVE_CUBE,
      null,
      vi.fn(),
      {
        ...makeDeps(ownerFetch, appendLine),
        ownerDeps: {
          locksDir,
          pid: 1001,
          processNonce: 'owner',
          cwd: '/work/owner',
        },
      }
    );
    await vi.waitFor(() => expect(appendLine).toHaveBeenCalledTimes(1));

    const second = await streamOnceIfOwner(
      UUID_ACTIVE_CUBE,
      null,
      vi.fn(),
      {
        ...makeDeps(skippedFetch, appendLine),
        ownerDeps: {
          locksDir,
          pid: 1002,
          processNonce: 'non-owner',
          cwd: '/work/non-owner',
        },
      }
    );

    expect(second).toBe('skipped');
    expect(ownerFetch).toHaveBeenCalledTimes(1);
    expect(skippedFetch).not.toHaveBeenCalled();
    expect(appendLine).toHaveBeenCalledTimes(1);

    close();
    await expect(first).resolves.toBe('streamed');
  });

  // gh#877 Path-A: an eviction frame writes the wake SENTINEL to the inbox and
  // closes the session (streamOnce returns). The sentinel is a WAKE HINT — the
  // agent confirms via an authed 410 before tearing down (tested via the funnel
  // elsewhere); streamOnce's job is just to deliver the wake + close cleanly.
  it('writes the [CUBE-EVICTED] wake sentinel and closes the session on an eviction frame', async () => {
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: eviction\ndata: {"cube_id":"cube-1","reason":"evicted from cube"}\n\n',
      // A trailing log entry must NOT be written — the loop broke on eviction.
      'event: log\nid: e_after\ndata: {"id":"e_after","message":"should not append","created_at":"2026-05-11T12:00:02Z"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));

    await streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(fetchImpl, appendLine));

    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('[CUBE-EVICTED]')
    );
    // The post-eviction log entry was never appended (session closed first).
    expect(appendLine).not.toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('should not append')
    );
  });

  it('TRIGGER-PATH: heartbeat hwm divergence waits for matching live event before reconnect', async () => {
    // Setup: cursor is "Y", server's heartbeat carries "X" (different
    // from Y), but the live broadcast for X is already queued behind
    // the heartbeat. This is the gh#402 false-positive churn class.
    //
    // Sequence:
    //   1. log e_Y arrives → recentIds = {e_Y}, lastPersistedEventId = e_Y
    //   2. heartbeat hwm=e_X arrives → divergence suspicion starts
    //   3. log e_X arrives before grace expires → suspicion clears
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: log\nid: e_Y\ndata: {"id":"e_Y","message":"applied","created_at":"2026-05-11T12:00:01Z"}\n\n',
      'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:02Z","hwm":{"id":"e_X","created_at":"2026-05-11T12:00:02Z"}}\n\n',
      'event: log\nid: e_X\ndata: {"id":"e_X","message":"arrived during grace","created_at":"2026-05-11T12:00:02Z"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    expect(appendLine).toHaveBeenCalledTimes(2);
    expect(appendLine).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('applied')
    );
    expect(appendLine).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('arrived during grace')
    );
    expect(onEventId).toHaveBeenLastCalledWith('e_X');
  });

  it('TRIGGER-PATH: heartbeat hwm divergence reconnects after grace when unresolved', async () => {
    vi.useFakeTimers();
    try {
      const blocks = [
        'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
        'event: log\nid: e_Y\ndata: {"id":"e_Y","message":"applied","created_at":"2026-05-11T12:00:01Z"}\n\n',
        'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:02Z","hwm":{"id":"e_X","created_at":"2026-05-11T12:00:02Z"}}\n\n',
      ];
      const appendLine = vi.fn().mockResolvedValue(undefined);
      let requestSignal: AbortSignal | null = null;
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init!.signal as AbortSignal;
        return Promise.resolve(
          makeAbortableOpenSSEResponse(blocks, requestSignal)
        );
      });
      const onEventId = vi.fn();

      const result = streamOnce(
        ACTIVE_CUBE,
        null,
        onEventId,
        makeDeps(fetchImpl as typeof fetch, appendLine)
      );

      await vi.waitFor(() => expect(appendLine).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(getStreamStatus().lastHeartbeatAt).not.toBeNull()
      );
      await vi.advanceTimersByTimeAsync(11);

      expect(requestSignal?.aborted).toBe(true);
      expect(
        String(requestSignal?.reason?.message ?? requestSignal?.reason)
      ).toContain('hwm divergence');
      await expect(result).resolves.toBeUndefined();
      expect(onEventId).toHaveBeenLastCalledWith('e_Y');
      expect(onEventId).not.toHaveBeenCalledWith('e_X');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TRIGGER-PATH: direct recipient cursor past broadcast HWM does not reconnect', async () => {
    vi.useFakeTimers();
    try {
      const blocks = [
        'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
        'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:01Z","hwm":{"id":"e_broadcast","created_at":"2026-05-11T12:00:01Z"}}\n\n',
        `event: log\nid: e_direct\ndata: {"id":"e_direct","visibility":"direct","recipient_drone_ids":["${ACTIVE_CUBE.droneId}"],"drone_id":"drone-2","message":"secret","created_at":"2026-05-11T12:00:02Z"}\n\n`,
        'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:03Z","hwm":{"id":"e_broadcast","created_at":"2026-05-11T12:00:01Z"}}\n\n',
      ];
      let requestSignal: AbortSignal | null = null;
      const appendLine = vi.fn().mockResolvedValue(undefined);
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init!.signal as AbortSignal;
        return Promise.resolve(makeAbortableOpenSSEResponse(blocks, requestSignal));
      });

      const result = streamOnce(
        ACTIVE_CUBE,
        null,
        vi.fn(),
        makeDeps(fetchImpl as typeof fetch, appendLine)
      );

      await vi.waitFor(() => expect(appendLine).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(getStreamStatus().lastHeartbeatAt).not.toBeNull()
      );
      await vi.advanceTimersByTimeAsync(11);

      expect(requestSignal?.aborted).toBe(false);
      requestSignal?.dispatchEvent(new Event('abort'));
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('happy path: log event appends to disk and advances cursor', async () => {
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: log\nid: e1\ndata: {"id":"e1","drone_label":"drone-2","role_name":"Reviewer","message":"hello","created_at":"2026-05-11T12:00:01Z"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    expect(appendLine).toHaveBeenCalledTimes(1);
    const [, , line] = appendLine.mock.calls[0];
    expect(line).toContain('drone-2');
    expect(line).toContain('Reviewer');
    expect(line).toContain('[entry_id: e1]');
    expect(line).toContain('hello');
    expect(onEventId).toHaveBeenCalledWith('e1');
  });

  // gh#29 quality-stream (#5): ack-fan-out path coverage — pins the
  // author-gate divergence that the shared writeInboxLine/recordSeen helpers
  // now carry (the regular-log path is covered by the happy-path test above).
  it('ack fan-out: the acked-entry author writes the ack line and advances the cursor', async () => {
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      `event: log\nid: e_ack\ndata: {"kind":"ack","author_drone_id":"${ACTIVE_CUBE.droneId}","id":"e_ack","drone_label":"drone-2","role_name":"Reviewer","message":"[ACK] REVIEW-READY","created_at":"2026-05-11T12:00:01Z"}\n\n`,
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(ACTIVE_CUBE, null, onEventId, makeDeps(fetchImpl, appendLine));

    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine.mock.calls[0][2]).toContain('[entry_id: e_ack]');
    expect(onEventId).toHaveBeenCalledWith('e_ack');
  });

  it('ack fan-out: a non-author advances the cursor but does NOT write the ack line', async () => {
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: log\nid: e_ack\ndata: {"kind":"ack","author_drone_id":"someone-else","id":"e_ack","message":"[ACK] x","created_at":"2026-05-11T12:00:01Z"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(ACTIVE_CUBE, null, onEventId, makeDeps(fetchImpl, appendLine));

    expect(appendLine).not.toHaveBeenCalled();
    expect(onEventId).toHaveBeenCalledWith('e_ack');
  });

  it('uses the SSE event id for the inbox entry_id when the JSON payload omits id', async () => {
    const blocks = [
      'event: log\nid: e1\ndata: {"drone_label":"drone-2","role_name":"Reviewer","message":"hello","created_at":"2026-05-11T12:00:01Z"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));

    await streamOnce(
      ACTIVE_CUBE,
      null,
      vi.fn(),
      makeDeps(fetchImpl, appendLine)
    );

    expect(appendLine).toHaveBeenCalledTimes(1);
    const [, , line] = appendLine.mock.calls[0];
    expect(line).toBe(
      '2026-05-11T12:00:01.000Z drone-2 (Reviewer): [entry_id: e1] hello'
    );
  });

  it('Codex wake sink fires for entries written to the inbox', async () => {
    const blocks = [
      'event: log\nid: e1\ndata: {"id":"e1","drone_id":"drone-other","drone_label":"drone-other","role_name":"Builder","message":"hello"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const wakeCodex = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));

    await streamOnce(
      ACTIVE_CUBE,
      null,
      vi.fn(),
      { ...makeDeps(fetchImpl, appendLine), wakeCodex }
    );

    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(wakeCodex).toHaveBeenCalledTimes(1);
    expect(wakeCodex).toHaveBeenCalledWith(expect.stringContaining('New Borg cube-log activity arrived'));
    expect(wakeCodex).not.toHaveBeenCalledWith(expect.stringContaining('borg_regen'));
    expect(wakeCodex).toHaveBeenCalledWith(expect.stringContaining('drone-other'));
    expect(wakeCodex).toHaveBeenCalledWith(expect.stringContaining('hello'));
  });

  it('Codex wake sink does not fire for ordinary own-drone filtered entries', async () => {
    const blocks = [
      `event: log\nid: e_own\ndata: {"id":"e_own","drone_id":"${ACTIVE_CUBE.droneId}","message":"my post"}\n\n`,
    ];
    const wakeCodex = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));

    await streamOnce(
      ACTIVE_CUBE,
      null,
      vi.fn(),
      { ...makeDeps(fetchImpl), wakeCodex }
    );

    expect(wakeCodex).not.toHaveBeenCalled();
  });

  it('dedup: replayed entry advances cursor without re-appending', async () => {
    // Reconnect-after-out-of-order scenario: we already have e_A on
    // disk from a prior receive (modeled here by feeding e_A twice in
    // one session). The second receive should:
    //   - NOT call appendLine
    //   - advance the cursor to e_A (so heartbeat-hwm comparison
    //     converges; spec §(3) round-5 fix)
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: log\nid: e_A\ndata: {"id":"e_A","message":"first"}\n\n',
      // Same id repeated — dedup branch.
      'event: log\nid: e_A\ndata: {"id":"e_A","message":"first"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    // appendLine ONCE for the first receive, not the dedup'd second.
    expect(appendLine).toHaveBeenCalledTimes(1);
    // onEventId called twice — once per receive — both with e_A.
    // The second call's cursor advance is what keeps the heartbeat-hwm
    // comparison consistent.
    expect(onEventId).toHaveBeenCalledTimes(2);
    expect(onEventId.mock.calls[0][0]).toBe('e_A');
    expect(onEventId.mock.calls[1][0]).toBe('e_A');
  });

  it('dedups reconnect catchup entries already present in the inbox file', async () => {
    const storedLines: string[] = [];
    const appendLine = vi.fn().mockImplementation(
      async (_cubeId: string, _droneId: string, line: string) => {
        storedLines.push(line);
      }
    );
    const hasInboxEntryId = vi.fn().mockImplementation(
      async (_cubeId: string, _droneId: string, entryId: string) =>
        storedLines.some((line) => line.includes(`[entry_id: ${entryId}]`))
    );
    const liveFetch = vi.fn().mockResolvedValue(makeSSEResponse([
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: log\nid: e_A\ndata: {"id":"e_A","drone_label":"drone-2","role_name":"Reviewer","message":"first","created_at":"2026-05-11T12:00:01Z"}\n\n',
    ]));
    const catchupFetch = vi.fn().mockResolvedValue(makeSSEResponse([
      'event: log\nid: e_A\ndata: {"id":"e_A","drone_label":"drone-2","role_name":"Reviewer","message":"first","created_at":"2026-05-11T12:00:01Z"}\n\n',
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:02Z"}\n\n',
    ]));
    const wakeCodex = vi.fn();
    const firstCursor = vi.fn();
    const secondCursor = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      firstCursor,
      { ...makeDeps(liveFetch, appendLine), hasInboxEntryId, wakeCodex }
    );
    await streamOnce(
      ACTIVE_CUBE,
      'e_before',
      secondCursor,
      { ...makeDeps(catchupFetch, appendLine), hasInboxEntryId, wakeCodex }
    );

    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(storedLines).toEqual([
      '2026-05-11T12:00:01.000Z drone-2 (Reviewer): [entry_id: e_A] first',
    ]);
    expect(wakeCodex).toHaveBeenCalledTimes(1);
    expect(secondCursor).toHaveBeenCalledWith('e_A');
  });

  it('uses the persisted stream cursor to dedup catchup after process restart', async () => {
    const cursor = {
      id: '11111111-1111-4111-8111-111111111111',
      created_at: '2026-05-11T12:00:00.000Z',
    };
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const hasInboxEntryId = vi.fn().mockResolvedValue(true);
    const wakeCodex = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse([
      'event: log\nid: e_A\ndata: {"id":"e_A","drone_label":"drone-2","role_name":"Reviewer","message":"first","created_at":"2026-05-11T12:00:01Z"}\n\n',
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:02Z"}\n\n',
    ]));

    await streamOnce(ACTIVE_CUBE, null, vi.fn(), {
      ...makeDeps(fetchImpl, appendLine),
      getCursor: vi.fn(async () => cursor),
      hasInboxEntryId,
      wakeCodex,
    });

    expect(hasInboxEntryId).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      'e_A',
      expect.stringContaining('[entry_id: e_A]'),
    );
    expect(appendLine).not.toHaveBeenCalled();
    expect(wakeCodex).not.toHaveBeenCalled();
  });

  it('writes reconnect catchup entries that are not already in the inbox file', async () => {
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const hasInboxEntryId = vi.fn().mockResolvedValue(false);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse([
      'event: log\nid: e_missed\ndata: {"id":"e_missed","drone_label":"drone-2","role_name":"Reviewer","message":"missed","created_at":"2026-05-11T12:00:01Z"}\n\n',
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:02Z"}\n\n',
    ]));

    await streamOnce(
      ACTIVE_CUBE,
      'e_before',
      vi.fn(),
      { ...makeDeps(fetchImpl, appendLine), hasInboxEntryId }
    );

    expect(hasInboxEntryId).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      'e_missed',
      expect.stringContaining('[entry_id: e_missed]')
    );
    expect(appendLine).toHaveBeenCalledTimes(1);
  });

  // gh#441 — catchup dedup must be robust to LEGACY (pre-0.9.39, no
  // [entry_id:] prefix) inbox lines. Without this, a worker DEPLOY (evicts
  // the LogBroadcaster DO → fleet-wide reconnect → catchup) re-appends every
  // legacy line → tail -F replay flood. The fix matches legacy lines by an
  // EXACT, line-anchored comparison against the id-prefix-stripped rendering.
  describe('inboxRawHasEntry — catchup dedup robust to legacy lines (gh#441)', () => {
    // The modern (0.9.39+) rendered line for entry e_L.
    const modernLine =
      '2026-05-11T12:00:01.000Z drone-2 (Reviewer): [entry_id: e_L] hello';
    // What an OLD client (pre-0.9.39) wrote for the SAME entry — no prefix.
    const legacyLine = '2026-05-11T12:00:01.000Z drone-2 (Reviewer): hello';

    it('matches a legacy (no-entry_id-prefix) line for the same entry', () => {
      expect(inboxRawHasEntry(legacyLine + '\n', 'e_L', modernLine)).toBe(true);
    });

    it('matches a new-format line by entry_id marker (preserves #412)', () => {
      expect(inboxRawHasEntry(modernLine + '\n', 'e_L', modernLine)).toBe(true);
    });

    it('returns false for a genuinely new entry not on disk (no false-drop)', () => {
      const raw =
        '2026-05-11T12:00:01.000Z drone-2 (Reviewer): [entry_id: e_OTHER] different\n';
      expect(inboxRawHasEntry(raw, 'e_L', modernLine)).toBe(false);
    });

    it('returns false on an empty inbox', () => {
      expect(inboxRawHasEntry('', 'e_L', modernLine)).toBe(false);
    });

    it('does NOT false-match a legacy form that is a substring of a longer line', () => {
      // CRITICAL (dispatch constraint #2): a substring match would drop a
      // genuinely-new entry whose message merely EXTENDS an existing line.
      // legacyForm for e_L is "...: hello" — must NOT match "...: hello world".
      const raw = '2026-05-11T12:00:01.000Z drone-2 (Reviewer): hello world\n';
      expect(inboxRawHasEntry(raw, 'e_L', modernLine)).toBe(false);
    });
  });

  describe('inbox tail cap (gh#643)', () => {
    it('caps the inbox file to the most recent N lines on append', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'borg-inbox-cap-'));
      const inboxPath = path.join(dir, 'inbox.log');

      try {
        for (let i = 1; i <= 6; i += 1) {
          await appendCappedInboxLine(inboxPath, `line-${i}`, 3);
        }
        await expect(readFile(inboxPath, 'utf-8')).resolves.toBe(
          'line-1\nline-2\nline-3\nline-4\nline-5\nline-6\n'
        );

        await appendCappedInboxLine(inboxPath, 'line-7', 3);

        await expect(readFile(inboxPath, 'utf-8')).resolves.toBe(
          'line-5\nline-6\nline-7\n'
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps catchup dedup working for recent entries after trim', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'borg-inbox-dedup-'));
      const inboxPath = path.join(dir, 'inbox.log');
      const oldLine =
        '2026-05-11T12:00:01.000Z drone-2 (Reviewer): [entry_id: e_old] old';
      const recentLine =
        '2026-05-11T12:00:03.000Z drone-2 (Reviewer): [entry_id: e_recent] recent';

      try {
        await writeFile(
          inboxPath,
          [
            oldLine,
            '2026-05-11T12:00:02.000Z drone-2 (Reviewer): [entry_id: e_mid] mid',
            recentLine,
          ].join('\n') + '\n',
          'utf-8'
        );

        await trimInboxFileToRecentLines(inboxPath, 2);
        const raw = await readFile(inboxPath, 'utf-8');

        expect(inboxRawHasEntry(raw, 'e_recent', recentLine)).toBe(true);
        expect(inboxRawHasEntry(raw, 'e_old', oldLine)).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('preserves a tail -F follower across rename-based trim', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'borg-inbox-tail-'));
      const inboxPath = path.join(dir, 'inbox.log');
      await writeFile(inboxPath, 'seed-1\nseed-2\nseed-3\n', 'utf-8');
      const tail = spawn('tail', ['-n', '0', '-F', inboxPath]);
      let stdout = '';
      tail.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf-8');
      });

      try {
        await delay(150);
        await appendCappedInboxLine(inboxPath, 'before-trim', 10);
        await waitFor(() => stdout.includes('before-trim'));

        await trimInboxFileToRecentLines(inboxPath, 2);
        await delay(1_500);
        await appendCappedInboxLine(inboxPath, 'after-trim', 10);

        await waitFor(() => stdout.includes('after-trim'));
      } finally {
        stopChild(tail);
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('gh#441 integration: catchup does NOT re-append an entry on disk as a LEGACY line', async () => {
    // Pre-seed: a legacy (no entry_id prefix) line for e_L is already on disk.
    const storedLines: string[] = [
      '2026-05-11T12:00:01.000Z drone-2 (Reviewer): legacy-body',
    ];
    const appendLine = vi.fn().mockImplementation(
      async (_c: string, _d: string, line: string) => {
        storedLines.push(line);
      }
    );
    // Real dedup logic over the in-memory store — proves the caller threads
    // the rendered line through so legacy matching can work.
    const hasInboxEntryId = vi.fn().mockImplementation(
      async (_c: string, _d: string, entryId: string, renderedLine: string) =>
        inboxRawHasEntry(storedLines.join('\n') + '\n', entryId, renderedLine)
    );
    const catchupFetch = vi.fn().mockResolvedValue(makeSSEResponse([
      'event: log\nid: e_L\ndata: {"id":"e_L","drone_label":"drone-2","role_name":"Reviewer","message":"legacy-body","created_at":"2026-05-11T12:00:01Z"}\n\n',
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:02Z"}\n\n',
    ]));

    await streamOnce(
      ACTIVE_CUBE,
      'e_before', // non-null → isCatchingUp = true
      vi.fn(),
      { ...makeDeps(catchupFetch, appendLine), hasInboxEntryId }
    );

    // The legacy line was recognized → NO re-append (storm averted).
    expect(appendLine).not.toHaveBeenCalled();
  });

  it('gh#441 integration: catchup DOES append a genuinely new entry', async () => {
    const storedLines: string[] = [
      '2026-05-11T12:00:01.000Z drone-2 (Reviewer): legacy-body',
    ];
    const appendLine = vi.fn().mockImplementation(
      async (_c: string, _d: string, line: string) => {
        storedLines.push(line);
      }
    );
    const hasInboxEntryId = vi.fn().mockImplementation(
      async (_c: string, _d: string, entryId: string, renderedLine: string) =>
        inboxRawHasEntry(storedLines.join('\n') + '\n', entryId, renderedLine)
    );
    const catchupFetch = vi.fn().mockResolvedValue(makeSSEResponse([
      'event: log\nid: e_NEW\ndata: {"id":"e_NEW","drone_label":"drone-2","role_name":"Reviewer","message":"brand new","created_at":"2026-05-11T12:00:05Z"}\n\n',
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:06Z"}\n\n',
    ]));

    await streamOnce(
      ACTIVE_CUBE,
      'e_before',
      vi.fn(),
      { ...makeDeps(catchupFetch, appendLine), hasInboxEntryId }
    );

    // Not on disk in any format → written exactly once (no missed wake).
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('brand new')
    );
  });

  it('own-drone filter HEARTBEAT-PING carve-out (gh#71): self-authored heartbeat-pings DO write to inbox', async () => {
    // gh#71 wake-asymmetry bug fix. The gh#39 cron watchdog authors
    // heartbeat-pings with the silent target's drone_id (so each ping
    // is attributed to the drone it intends to wake). Without the
    // carve-out, the own-drone filter would silently skip the target's
    // own ping → inbox file never written → Monitor never fires →
    // platform-level wake guarantee broken for the cube-wide-silent
    // class gh#39 was designed to prevent. Carve-out verifies:
    //   - drone_id === active.droneId AND message starts with
    //     [HEARTBEAT-PING] → appendLine FIRES (Monitor will wake)
    //   - cursor advances normally (same as the standard write path)
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      // Self-authored heartbeat-ping — should NOT be filtered.
      `event: log\nid: e_ping\ndata: {"id":"e_ping","drone_id":"${ACTIVE_CUBE.droneId}","message":"[HEARTBEAT-PING] drone-1: server-side wake — cube silence-detection 99m. Respond if awake."}\n\n`,
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    // appendLine MUST fire for the self-authored heartbeat-ping.
    // This is the load-bearing assertion: pre-fix, this would be 0.
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('[HEARTBEAT-PING]')
    );
    // Cursor advances normally — same shape as the non-filtered path.
    expect(onEventId).toHaveBeenCalledTimes(1);
    expect(onEventId.mock.calls[0][0]).toBe('e_ping');
  });

  it('own-drone filter: ordinary self-authored entries STILL skip (no regression on silent-self)', async () => {
    // Negative test for the gh#71 carve-out: only [HEARTBEAT-PING]
    // entries get through. An ordinary self-authored entry must
    // continue to be filtered (silent-self property preserved). This
    // pins the carve-out's narrow scope so a future refactor can't
    // accidentally widen it.
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      // Self-authored ordinary post — should be FILTERED, not appended.
      `event: log\nid: e_own_ordinary\ndata: {"id":"e_own_ordinary","drone_id":"${ACTIVE_CUBE.droneId}","message":"REVIEW-READY: feat/whatever"}\n\n`,
      // Self-authored where message happens to CONTAIN but not START
      // WITH [HEARTBEAT-PING] — also filtered (strict prefix match).
      `event: log\nid: e_own_substring\ndata: {"id":"e_own_substring","drone_id":"${ACTIVE_CUBE.droneId}","message":"discussing [HEARTBEAT-PING] semantics inline"}\n\n`,
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    // Neither self-authored entry should appendLine — silent-self
    // property holds for everything except the [HEARTBEAT-PING] prefix.
    expect(appendLine).not.toHaveBeenCalled();
    // Cursor advances for both (existing skip-write-advance-cursor
    // shape preserved).
    expect(onEventId).toHaveBeenCalledTimes(2);
    expect(onEventId.mock.calls[0][0]).toBe('e_own_ordinary');
    expect(onEventId.mock.calls[1][0]).toBe('e_own_substring');
  });

  it('own-drone filter: skip inbox write but advance cursor (silent-self property)', async () => {
    // Pre-cutover inbox.ts:87-88 filtered out own-drone broadcasts so
    // the posting drone didn't wake itself on its own log entries. The
    // SSE consumer ported the dedup + cursor logic but not this filter
    // (drone-5 regression finding from 0.5.1 rollout). Verify:
    //   - log event with drone_id === active.droneId → NO appendLine
    //   - cursor still advances (entry IS in the DB; hwm reflects it)
    //   - recentIds still updated (so the bounded set stays accurate)
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      // event.data.drone_id matches ACTIVE_CUBE.droneId ("drone-1") — own broadcast
      `event: log\nid: e_own\ndata: {"id":"e_own","drone_id":"${ACTIVE_CUBE.droneId}","message":"my post"}\n\n`,
      // event.data.drone_id is a different drone — should be appended normally
      'event: log\nid: e_other\ndata: {"id":"e_other","drone_id":"drone-other","message":"their post"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    // appendLine fired ONCE — for e_other only. e_own was skipped.
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('their post')
    );
    // Cursor advanced for BOTH events (e_own and e_other) — the own-
    // drone filter advances state even though it skips disk write.
    expect(onEventId).toHaveBeenCalledTimes(2);
    expect(onEventId.mock.calls[0][0]).toBe('e_own');
    expect(onEventId.mock.calls[1][0]).toBe('e_other');
  });

  it('first-heartbeat absorb on fresh connect (no Last-Event-ID)', async () => {
    // Edge case: fresh session, no cursor. Server's first heartbeat
    // carries hwm against a cube with entries. Without the absorb,
    // strict equality would diverge immediately and loop forever.
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:01Z","hwm":{"id":"e_existing","created_at":"2026-05-11T12:00:00Z"}}\n\n',
      // Then a normal log entry to confirm the stream continues.
      'event: log\nid: e_new\ndata: {"id":"e_new","message":"new"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    // No abort. The log event after the heartbeat should still
    // append normally.
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine).toHaveBeenCalledWith(
      ACTIVE_CUBE.cubeId,
      ACTIVE_CUBE.droneId,
      expect.stringContaining('new')
    );
    // onEventId called twice: once with the absorbed hwm, once with
    // the new log id.
    expect(onEventId).toHaveBeenNthCalledWith(1, 'e_existing');
    expect(onEventId).toHaveBeenNthCalledWith(2, 'e_new');
  });

  // gh#402 replay-storm COMPLETE FIX (dispatch 5832af9b) — the two
  // regression tests for the trigger (PART A) and the amplifier (PART B).
  it('PART A: own broadcast post advances broadcast cursor → heartbeat hwm=own-post does NOT reconnect', async () => {
    // The storm TRIGGER (583aed7e): the DO echoes the author's own
    // broadcast back over SSE. The server's broadcast HWM counts that
    // own post, so the very next heartbeat carries hwm=own-post. If the
    // own-post receive does NOT advance the client's broadcast cursor,
    // the heartbeat reads server-hwm > client-cursor and fires a
    // spurious §(5) divergence-reconnect — on EVERY own broadcast. The
    // fix: recordSeen advances the broadcast cursor for own posts too
    // (broadcastHwmFromLogEvent gates direct/ack to null), so cursor ==
    // server hwm and no divergence is suspected.
    //
    // A prior (other-drone) broadcast is seeded FIRST so lastBroadcastHwm
    // is non-null when the heartbeat lands — otherwise the heartbeat hits
    // the first-baseline-absorb branch, which masks divergence and would
    // make this test pass for the wrong reason.
    __resetStreamStateForTest();
    vi.useFakeTimers();
    try {
      const blocks = [
        'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
        // Seed: another drone's broadcast → lastBroadcastHwm = e_seed.
        'event: log\nid: e_seed\ndata: {"id":"e_seed","drone_id":"drone-2","message":"seed","created_at":"2026-05-11T12:00:01Z"}\n\n',
        // Own broadcast (drone_id === active.droneId), created_at AFTER
        // the seed. The fix advances the broadcast cursor past e_seed.
        `event: log\nid: e_own\ndata: {"id":"e_own","drone_id":"${ACTIVE_CUBE.droneId}","message":"my broadcast","created_at":"2026-05-11T12:00:02Z"}\n\n`,
        // Server HWM now reflects the own post (ahead of the seed).
        'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:03Z","hwm":{"id":"e_own","created_at":"2026-05-11T12:00:02Z"}}\n\n',
      ];
      const appendLine = vi.fn().mockResolvedValue(undefined);
      let requestSignal: AbortSignal | null = null;
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init!.signal as AbortSignal;
        return Promise.resolve(
          makeAbortableOpenSSEResponse(blocks, requestSignal)
        );
      });
      const onEventId = vi.fn();

      const result = streamOnce(
        ACTIVE_CUBE,
        null,
        onEventId,
        makeDeps(fetchImpl as typeof fetch, appendLine)
      );

      // Seed appends (other drone); own post does NOT (silent-self).
      await vi.waitFor(() => expect(appendLine).toHaveBeenCalledTimes(1));
      // Gate on the heartbeat actually being processed before advancing
      // the grace clock — state was reset above so this is test-local.
      await vi.waitFor(() =>
        expect(getStreamStatus().lastHeartbeatAt).not.toBeNull()
      );
      await vi.advanceTimersByTimeAsync(11);

      // No spurious reconnect: own post advanced the broadcast cursor to
      // e_own, so heartbeat hwm == cursor and divergence is not suspected.
      expect(requestSignal?.aborted).toBe(false);
      // Own post never echoes to the inbox file (only the seed appended).
      expect(appendLine).toHaveBeenCalledTimes(1);
      requestSignal?.dispatchEvent(new Event('abort'));
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('PART B: out-of-order older broadcast does NOT regress the resume cursor', async () => {
    // The storm AMPLIFIER (c80b1aaa): a later reconnect+catchup (or an
    // out-of-order DO broadcast) can deliver an OLDER entry after the
    // cursor has already advanced past it. A non-monotonic cursor would
    // regress to the older id, widening the next reconnect's catchup
    // window and re-replaying entries (the tail -F storm). The monotonic
    // guard keeps lastPersistedEventId at the newest (created_at,id) —
    // the older entry is still durably written to disk, it just doesn't
    // move (regress) the resume cursor.
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
      // Newer broadcast arrives first → cursor advances to e_new.
      'event: log\nid: e_new\ndata: {"id":"e_new","drone_id":"drone-2","message":"newer","created_at":"2026-05-11T12:00:05Z"}\n\n',
      // Then an OLDER broadcast arrives out-of-order.
      'event: log\nid: e_old\ndata: {"id":"e_old","drone_id":"drone-2","message":"older","created_at":"2026-05-11T12:00:01Z"}\n\n',
    ];
    const appendLine = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    const onEventId = vi.fn();

    await streamOnce(
      ACTIVE_CUBE,
      null,
      onEventId,
      makeDeps(fetchImpl, appendLine)
    );

    // Both entries are durably written — durability is independent of the
    // resume cursor (disk write happens BEFORE the cursor advances).
    expect(appendLine).toHaveBeenCalledTimes(2);
    // The cursor advanced to e_new and did NOT regress to the older e_old.
    expect(onEventId).toHaveBeenCalledWith('e_new');
    expect(onEventId).not.toHaveBeenCalledWith('e_old');
    expect(onEventId).toHaveBeenLastCalledWith('e_new');
  });

  it('keeps an ambiguous 401 terminal instead of reconnecting or renewing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    );
    await expect(
      streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(fetchImpl))
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });
});

// ---------------- T1.2: content-vs-wire freshness split ----------------

describe('streamState content-vs-wire freshness split (T1.2)', () => {
  beforeEach(() => {
    __resetStreamStateForTest();
  });

  it('log events bump BOTH lastWireActivityAt and lastContentEventAt', async () => {
    const blocks = [
      'event: log\nid: e1\ndata: {"id":"e1","drone_id":"someone-else","message":"hi"}\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    await streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(fetchImpl));
    const s = getStreamStatus();
    expect(s.lastWireActivityAt).not.toBeNull();
    expect(s.lastContentEventAt).not.toBeNull();
    // Both timestamps stamped from the same `nowIso` per event, so equal.
    expect(s.lastContentEventAt).toBe(s.lastWireActivityAt);
  });

  it('bookmark events bump BOTH lastWireActivityAt and lastContentEventAt', async () => {
    const blocks = [
      'event: bookmark\ndata: {"as_of":"2026-05-11T12:00:00Z"}\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    await streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(fetchImpl));
    const s = getStreamStatus();
    expect(s.lastWireActivityAt).not.toBeNull();
    expect(s.lastContentEventAt).not.toBeNull();
  });

  it('heartbeat events bump lastWireActivityAt but NOT lastContentEventAt', async () => {
    // Use a watchdog that's tight enough that no log/bookmark window
    // sneaks content in. Plain heartbeat-only stream.
    const blocks = [
      'event: heartbeat\ndata: {"ts":"2026-05-11T12:00:01Z","hwm":{"id":"e_existing","created_at":"2026-05-11T12:00:00Z"}}\n\n',
    ];
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    await streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(fetchImpl));
    const s = getStreamStatus();
    expect(s.lastWireActivityAt).not.toBeNull(); // wire ticked
    expect(s.lastHeartbeatAt).not.toBeNull(); // heartbeat ticked
    expect(s.lastContentEventAt).toBeNull(); // content did NOT
  });

  it('own-drone broadcast is content — bumps lastContentEventAt despite skipping disk write', async () => {
    // Posting drone sees its own entry on the wire; we skip the inbox
    // file echo (silent-self) but advance cursor + dedup state. From a
    // content-freshness perspective the cube did emit content, so the
    // top-line should reflect activity.
    const blocks = [
      `event: log\nid: e_own\ndata: {"id":"e_own","drone_id":"${ACTIVE_CUBE.droneId}","message":"my post"}\n\n`,
    ];
    const fetchImpl = vi.fn().mockResolvedValue(makeSSEResponse(blocks));
    await streamOnce(ACTIVE_CUBE, null, vi.fn(), makeDeps(fetchImpl));
    const s = getStreamStatus();
    expect(s.lastContentEventAt).not.toBeNull();
    expect(s.lastWireActivityAt).not.toBeNull();
  });
});

describe('gh#857 WI-2 — startLogStream heartbeat wiring (idempotent, codex-only)', () => {
  beforeEach(() => __resetCodexHeartbeatForTest());
  afterEach(() => __resetCodexHeartbeatForTest());

  it('starts exactly ONE heartbeat timer across re-entrant calls (codex)', () => {
    const timer = setInterval(() => {}, 1_000_000); // a real timer the guard stores
    const start = vi.fn(() => timer);
    ensureCodexHeartbeatStarted(start);
    ensureCodexHeartbeatStarted(start);
    ensureCodexHeartbeatStarted(start);
    // The guard means the timer-creating start runs ONCE — no second interval leaked.
    expect(start).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });

  it('stores no timer for a claude session (start returns null) — nothing to leak', () => {
    const claudeStart = vi.fn(() => null); // resolveSessionAgentKind !== codex
    ensureCodexHeartbeatStarted(claudeStart);
    // No timer stored → a later codex start can still take effect (null didn't wedge the guard).
    const timer = setInterval(() => {}, 1_000_000);
    ensureCodexHeartbeatStarted(() => timer);
    expect(claudeStart).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });

  it('gh#861 finding 3: stopCodexHeartbeat clears the timer and is re-armable', () => {
    const timer = setInterval(() => {}, 1_000_000);
    ensureCodexHeartbeatStarted(() => timer);
    // Teardown seam: clears the stored timer.
    stopCodexHeartbeat();
    // After teardown the guard is empty, so a fresh start re-arms (proves re-armability).
    const restart = vi.fn(() => setInterval(() => {}, 1_000_000));
    ensureCodexHeartbeatStarted(restart);
    expect(restart).toHaveBeenCalledTimes(1);
    __resetCodexHeartbeatForTest();
  });

  it('startLogStream() WIRES the heartbeat start (pins log-stream.ts:191) — exactly one across re-entrant calls', () => {
    // QA 75f18e8f: the prior tests called the helper directly; nothing proved
    // startLogStream actually invokes it. Call startLogStream (with the forever
    // loop suppressed so no real network/keychain), then prove the heartbeat was
    // already started by it: a follow-up ensure(spy) must be a NO-OP. If line 191
    // (ensureCodexHeartbeatStarted) were deleted, the timer would be null here and
    // the spy WOULD fire → this test fails (mutation caught).
    const prev = process.env.BORG_CODEX_REMOTE_WAKE;
    const prevAgentKind = process.env.BORG_AGENT_KIND;
    process.env.BORG_CODEX_REMOTE_WAKE = '1'; // → resolveSessionAgentKind() === 'codex'
    process.env.BORG_AGENT_KIND = 'codex';
    try {
      startLogStream({ runForever: () => {} }); // call 1 — should start the heartbeat
      startLogStream({ runForever: () => {} }); // call 2 — guard: no second timer
      const spy = vi.fn(() => null);
      ensureCodexHeartbeatStarted(spy);
      expect(spy).not.toHaveBeenCalled(); // startLogStream already started it (line 191 wired) + idempotent
    } finally {
      __resetCodexHeartbeatForTest();
      if (prev === undefined) delete process.env.BORG_CODEX_REMOTE_WAKE;
      else process.env.BORG_CODEX_REMOTE_WAKE = prev;
      if (prevAgentKind === undefined) delete process.env.BORG_AGENT_KIND;
      else process.env.BORG_AGENT_KIND = prevAgentKind;
    }
  });
});
