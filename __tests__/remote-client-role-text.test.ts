import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_MANIFEST } from '../src/tool-manifest.js';

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

const ROLE_TEXT_LIMIT = 51_200;

describe('MCP role-text proxy policy', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => fetchSpy.mockRestore());

  it('forwards a shrinking legacy whole-text repair above the limit', async () => {
    const repair = 'x'.repeat(ROLE_TEXT_LIMIT + 100);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ role: { id: 'role-1', detailed_description: repair } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const { updateRole } = await import('../src/remote-client.js');

    await updateRole('role-1', { detailed_description: repair });

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init!.body as string).detailed_description).toBe(repair);
  });

  it('surfaces the worker rejection for a new oversized role-text update', async () => {
    const oversized = 'x'.repeat(ROLE_TEXT_LIMIT + 1);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        code: 'CONTENT_TOO_LARGE',
        message: 'Role detailed_description exceeds the 51200-character limit.',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const { updateRole } = await import('../src/remote-client.js');

    await expect(updateRole('role-1', { detailed_description: oversized }))
      .rejects.toThrow(/HTTP 400.*51200-character limit/);
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init!.body as string).detailed_description).toBe(oversized);
  });

  it('does not publish a conflicting client-side maxLength for role-text tools', () => {
    for (const name of ['borg_create-role', 'borg_update-role', 'borg_patch-role-section']) {
      const tool = TOOL_MANIFEST.find((entry) => entry.name === name)!;
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      const field = name === 'borg_patch-role-section' ? properties.body : properties.detailed_description;
      expect(field.maxLength).toBeUndefined();
    }
  });
});
