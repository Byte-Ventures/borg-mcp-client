import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  getIdToken: vi.fn(async () => 'id-token'),
  getRefreshToken: vi.fn(async () => null),
  clearTokens: vi.fn(async () => {}),
}));

vi.mock('../src/auth.js', () => ({
  refreshIdToken: vi.fn(async () => {}),
  RefreshTokenInvalidError: class RefreshTokenInvalidError extends Error {},
  RefreshTransientError: class RefreshTransientError extends Error {},
}));

/**
 * gh#418: ackLogEntry gains an optional kind. The default keeps the wire
 * byte-identical to pre-#418 callers; kind='claim' sends the claim kind.
 */
describe('ackLogEntry request body (gh#418 claim kind)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('defaults to { kind: "ack" } and hits the entry ack route (back-compat)', async () => {
    const { ackLogEntry } = await import('../src/remote-client.js');
    await ackLogEntry('session-token', 'https://api.example.test', 'entry-1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/drone/log/entry-1/ack');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ kind: 'ack' });
  });

  it('sends { kind: "claim" } when claiming', async () => {
    const { ackLogEntry } = await import('../src/remote-client.js');
    await ackLogEntry('session-token', 'https://api.example.test', 'entry-1', 'claim');
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({ kind: 'claim' });
  });
});
