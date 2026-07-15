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

describe('regen() metadata query', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cube: {}, role: {}, drone: {}, roles: [], drones: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends advisory model and current working-repository identity on regen', async () => {
    const { regen } = await import('../src/remote-client.js');

    await regen('session-token', HOSTED_API_URL, {
      since: '2026-07-13T18:00:00Z',
      reportedModel: 'gpt-5',
      workingRepo: {
        name: 'borg-mcp',
        origin: 'github.com/borgmcp/borg-mcp',
      },
    });

    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/drone/regen');
    expect(parsed.searchParams.get('since')).toBe('2026-07-13T18:00:00Z');
    expect(parsed.searchParams.get('reported_model')).toBe('gpt-5');
    expect(parsed.searchParams.has('working_repo_name')).toBe(false);
    expect(parsed.searchParams.get('working_repo_origin')).toBe('github.com/borgmcp/borg-mcp');
    expect(parsed.searchParams.get('working_repo_reported')).toBe('1');
    expect(parsed.searchParams.has('working_repo_path')).toBe(false);
  });

  it('omits optional metadata so legacy callers preserve prior server values', async () => {
    const { regen } = await import('../src/remote-client.js');

    await regen('session-token', HOSTED_API_URL);

    const [url] = fetchSpy.mock.calls[0];
    expect(new URL(String(url)).search).toBe('');
  });

  it('canonicalizes a directly supplied raw origin before it reaches the regen query string', async () => {
    const { regen } = await import('../src/remote-client.js');

    await regen('session-token', HOSTED_API_URL, {
      workingRepo: {
        name: 'attacker-controlled',
        origin: 'ssh://git:ssh-secret@github.com/borgmcp/private-repo.git?token=query-secret#fragment-secret',
      },
    });

    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('working_repo_origin')).toBe('github.com/borgmcp/private-repo');
    for (const unsafePart of ['ssh-secret', 'query-secret', 'fragment-secret', 'attacker-controlled']) {
      expect(String(url)).not.toContain(unsafePart);
    }
    expect(parsed.searchParams.has('working_repo_name')).toBe(false);
    expect(parsed.searchParams.has('working_repo_path')).toBe(false);
  });
});
