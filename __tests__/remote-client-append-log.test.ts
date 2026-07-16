import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOSTED_API_URL = process.env.BORG_API_URL || 'https://api.borgmcp.ai';

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

describe('appendLog directed-message request body', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          entry: {
            id: 'entry-1',
            cube_id: 'cube-1',
            drone_id: 'drone-1',
            message: 'hello',
            visibility: 'broadcast',
            created_at: '2026-05-29T20:00:00.000Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('omits visibility fields for default broadcast back-compat', async () => {
    const { appendLog } = await import('../src/remote-client.js');

    await appendLog('session-token', HOSTED_API_URL, 'hello');

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({ message: 'hello' });
  });

  it('sends direct visibility and recipient ids when requested', async () => {
    const { appendLog } = await import('../src/remote-client.js');

    await appendLog('session-token', HOSTED_API_URL, 'secret', {
      visibility: 'direct',
      recipientDroneIds: ['drone-2'],
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({
      message: 'secret',
      visibility: 'direct',
      recipientDroneIds: ['drone-2'],
    });
  });

  it('sends raw server-routing tokens without resolving them client-side', async () => {
    const { appendLog } = await import('../src/remote-client.js');

    await appendLog('session-token', HOSTED_API_URL, 'STARTING: work', {
      class: 'status-claim',
      to: ['Coordinator'],
      visibility: 'broadcast',
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({
      message: 'STARTING: work',
      class: 'status-claim',
      to: ['Coordinator'],
      visibility: 'broadcast',
    });
  });

  it('preserves an explicit empty to array for the server D3 path', async () => {
    const { appendLog } = await import('../src/remote-client.js');

    await appendLog('session-token', HOSTED_API_URL, 'hello', {
      to: [],
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({
      message: 'hello',
      to: [],
    });
  });
});
