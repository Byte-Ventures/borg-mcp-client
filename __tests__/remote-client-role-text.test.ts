import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_MANIFEST } from '../src/tool-manifest.js';

/**
 * MCP role-text proxy policy.
 *
 * The core invariant is unchanged after cloud severance: the client publishes
 * NO client-side maxLength for role-text tools — the 51,200-char limit is owned
 * by the server, and the client never truncates or length-rejects before the
 * wire. The deleted file proved this by forwarding oversized text to the cloud
 * /api/roles proxy. That proxy is not carried by the local server: updateRole
 * fails closed with "does not support" before any network call, and — crucially
 * — it does so REGARDLESS of text size, i.e. no client-side length gate
 * short-circuits ahead of it. The manifest invariant below is the authoritative
 * no-client-maxLength assertion and is preserved verbatim.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);
const ROLE_TEXT_LIMIT = 51_200;

describe('MCP role-text proxy policy (local path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({
        identity: TRUST_IDENTITY,
        fetchImpl: fetchSpy,
      })),
    }));
    vi.doMock('../src/cubes.js', () => ({
      getActiveCube: vi.fn(async () => ({
        cubeId: CUBE_ID,
        droneId: DRONE_ID,
        sessionToken: SESSION,
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST_IDENTITY,
      })),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('applies no client-side length gate ahead of the local unsupported check (large text)', async () => {
    const repair = 'x'.repeat(ROLE_TEXT_LIMIT + 100);
    const { updateRole } = await import('../src/remote-client.js');
    await expect(updateRole('role-1', { detailed_description: repair }))
      .rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not length-reject an oversized update client-side (fails closed the same way)', async () => {
    const oversized = 'x'.repeat(ROLE_TEXT_LIMIT + 1);
    const { updateRole } = await import('../src/remote-client.js');
    await expect(updateRole('role-1', { detailed_description: oversized }))
      .rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
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
