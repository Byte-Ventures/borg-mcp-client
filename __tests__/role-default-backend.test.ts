/**
 * Task 36 — Integration verify: default_model flows from MCP tool call args
 * through the handler to the REST request body.
 *
 * Tests the full client-side pipeline:
 *   MCP inputSchema → handler args → createRole/updateRole helper → REST body
 *
 * Uses fetch spy to intercept the outgoing request and assert the body.
 */

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

describe('createRole — default_model forwarded to REST body', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          role: {
            id: 'role-uuid-1',
            name: 'Builder',
            short_description: 'Builds things',
            detailed_description: 'Full playbook.',
            is_default: false,
            is_human_seat: false,
            can_broadcast: false,
            receives_all_direct: false,
            default_model: 'ollama:qwen3-coder-next:q4_K_M',
            role_class: 'worker',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends default_model in POST body when provided to createRole', async () => {
    const { createRole } = await import('../src/remote-client.js');

    await createRole('cube-uuid-1', {
      name: 'Builder',
      short_description: 'Builds things',
      detailed_description: 'Full playbook.',
      default_model: 'ollama:qwen3-coder-next:q4_K_M',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.default_model).toBe('ollama:qwen3-coder-next:q4_K_M');
    expect(body.name).toBe('Builder');
  });

  it('omits default_model from POST body when not provided to createRole', async () => {
    const { createRole } = await import('../src/remote-client.js');

    await createRole('cube-uuid-1', {
      name: 'Builder',
      short_description: 'Builds things',
      detailed_description: 'Full playbook.',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).not.toHaveProperty('default_model');
  });

  it('sends claude model descriptor in POST body when provided', async () => {
    const { createRole } = await import('../src/remote-client.js');

    await createRole('cube-uuid-1', {
      name: 'Reviewer',
      short_description: 'Reviews things',
      detailed_description: 'Playbook.',
      default_model: 'claude:claude-opus-4-8',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.default_model).toBe('claude:claude-opus-4-8');
  });
});

describe('updateRole — default_model forwarded to REST body', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          role: {
            id: 'role-uuid-2',
            name: 'Builder',
            short_description: 'Builds things',
            detailed_description: 'Full playbook.',
            is_default: false,
            is_human_seat: false,
            can_broadcast: false,
            receives_all_direct: false,
            default_model: 'claude:claude-opus-4-8',
            role_class: 'worker',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends default_model in PATCH body when provided to updateRole', async () => {
    const { updateRole } = await import('../src/remote-client.js');

    await updateRole('role-uuid-2', {
      default_model: 'claude:claude-opus-4-8',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.default_model).toBe('claude:claude-opus-4-8');
  });

  it('omits default_model from PATCH body when not in updates', async () => {
    const { updateRole } = await import('../src/remote-client.js');

    await updateRole('role-uuid-2', {
      name: 'Senior Builder',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).not.toHaveProperty('default_model');
    expect(body.name).toBe('Senior Builder');
  });

  it('sends ollama model descriptor in PATCH body when provided', async () => {
    const { updateRole } = await import('../src/remote-client.js');

    await updateRole('role-uuid-2', {
      default_model: 'ollama:qwen3-coder-next:q4_K_M',
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.default_model).toBe('ollama:qwen3-coder-next:q4_K_M');
  });
});
