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
 * gh#740: recordDecision / listDecisions wire shape against the decision routes.
 */
describe('decision registry request shapes', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => fetchSpy.mockRestore());

  it('recordDecision POSTs {topic, decision, rationale?} to /api/drone/decide', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ decision: { id: 'd1', topic: 't', status: 'active' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const { recordDecision } = await import('../src/remote-client.js');
    const out = await recordDecision('session-token', 'https://api.example.test', {
      topic: 'pricing-model',
      decision: 'pooled',
      rationale: 'gh#738',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/drone/decide');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({
      topic: 'pricing-model',
      decision: 'pooled',
      rationale: 'gh#738',
    });
    expect(out.decision.id).toBe('d1');
  });

  it('listDecisions GETs /api/drone/decisions (no topic → no query)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ decisions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const { listDecisions } = await import('../src/remote-client.js');
    await listDecisions('session-token', 'https://api.example.test');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/drone/decisions');
    expect(String(url)).not.toContain('?topic=');
    expect(init!.method).toBe('GET');
  });

  it('listDecisions encodes the topic query param', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ decisions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const { listDecisions } = await import('../src/remote-client.js');
    await listDecisions('session-token', 'https://api.example.test', 'release cadence');
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/drone/decisions?topic=release%20cadence');
  });

  it('removeDecision DELETEs exactly the selected topic or id', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ decision: { id: 'd1', topic: 'release-cadence', status: 'removed' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const { removeDecision } = await import('../src/remote-client.js');

    await removeDecision('session-token', 'https://api.example.test', { topic: 'release-cadence' });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/drone/decisions');
    expect(init!.method).toBe('DELETE');
    expect(JSON.parse(init!.body as string)).toEqual({ topic: 'release-cadence' });
  });
});
