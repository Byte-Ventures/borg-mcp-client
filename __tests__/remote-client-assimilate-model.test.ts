import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOSTED_API_URL = 'https://api.borgmcp.ai';

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

// gh#890: the selector carried `model` from assimilate-deps but remote-client
// never copied it onto the /api/assimilate POST body — drones.model stayed NULL
// even though the server accepts + persists it. These tests pin the wire body.
describe('assimilate() model on the /api/assimilate POST body (gh#890)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          cube: {
            id: 'cube-1',
            owner_id: 'owner-1',
            name: 'borg-mcp',
            cube_directive: '',
            created_at: '2026-06-20T00:00:00.000Z',
            updated_at: '2026-06-20T00:00:00.000Z',
          },
          role: {
            id: 'role-1',
            cube_id: 'cube-1',
            name: 'Builder',
            short_description: '',
            detailed_description: '',
            is_default: true,
            is_human_seat: false,
            role_class: 'worker',
            created_at: '2026-06-20T00:00:00.000Z',
          },
          drone: {
            id: 'drone-1',
            cube_id: 'cube-1',
            role_id: 'role-1',
            label: 'one-of-one-builder',
            last_seen: '2026-06-20T00:00:00.000Z',
            hostname: null,
            created_at: '2026-06-20T00:00:00.000Z',
          },
          sessionToken: 'session-token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('includes model on the wire body when the selector carries it', async () => {
    const { assimilate } = await import('../src/remote-client.js');

    await assimilate(
      { cube_id: 'cube-1', role_id: 'role-1', model: 'ollama:qwen3:q4_K_M' },
      HOSTED_API_URL,
      null,
      'claude'
    );

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('ollama:qwen3:q4_K_M');
  });

  it('omits model from the wire body when the selector has none', async () => {
    const { assimilate } = await import('../src/remote-client.js');

    await assimilate(
      { cube_id: 'cube-1', role_id: 'role-1' },
      HOSTED_API_URL,
      null,
      'claude'
    );

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect('model' in body).toBe(false);
  });

  it('omits model when the selector value is explicitly null', async () => {
    const { assimilate } = await import('../src/remote-client.js');

    await assimilate(
      { cube_id: 'cube-1', role_id: 'role-1', model: null },
      HOSTED_API_URL,
      null,
      'claude'
    );

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect('model' in body).toBe(false);
  });

  // gh#896: defense-in-depth — reject a malformed descriptor client-side before
  // the wire (belt-and-suspenders over the upstream flag-parse + server gate).
  it('rejects a malformed model descriptor BEFORE POSTing (throws, no fetch)', async () => {
    const { assimilate } = await import('../src/remote-client.js');

    await expect(
      assimilate(
        { cube_id: 'cube-1', role_id: 'role-1', model: 'garbage-no-colon' },
        HOSTED_API_URL,
        null,
        'claude'
      )
    ).rejects.toThrow(/Invalid model descriptor/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid descriptor and sends it on the wire', async () => {
    const { assimilate } = await import('../src/remote-client.js');

    await assimilate(
      { cube_id: 'cube-1', role_id: 'role-1', model: 'claude:claude-opus-4-8' },
      HOSTED_API_URL,
      null,
      'claude'
    );

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('claude:claude-opus-4-8');
  });
});
