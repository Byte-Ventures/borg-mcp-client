import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * assimilate() model handling.
 *
 * gh#896 (defense-in-depth) is fully preserved: a malformed model descriptor is
 * rejected client-side BEFORE any network attempt. gh#890 asserted that a valid
 * model was copied onto the CLOUD /api/assimilate POST body; after cloud
 * severance assimilate() is not carried by the local server — /api/assimilate is
 * outside the local /api/cubes surface, so it fails closed with "does not
 * support" (local enrollment goes through the server handshake, not this path).
 * These tests pin BOTH: the descriptor gate still guards valid vs. malformed
 * input, and every well-formed selector fails closed at the transport boundary
 * without leaking to a cloud route.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

describe('assimilate() model descriptor gate and local transport (gh#890 / gh#896)', () => {
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

  // gh#896: reject a malformed descriptor client-side BEFORE the transport
  // (belt-and-suspenders over the upstream flag-parse + server gate).
  it('rejects a malformed model descriptor BEFORE any network attempt (throws, no fetch)', async () => {
    const { assimilate } = await import('../src/remote-client.js');
    await expect(
      assimilate(
        { cube_id: 'cube-1', role_id: 'role-1', model: 'garbage-no-colon' },
        ORIGIN,
        null,
        'claude',
      ),
    ).rejects.toThrow(/Invalid model descriptor/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid descriptor at the gate, then fails closed at the local transport (no cloud route)', async () => {
    const { assimilate } = await import('../src/remote-client.js');
    await expect(
      assimilate(
        { cube_id: 'cube-1', role_id: 'role-1', model: 'ollama:qwen3:q4_K_M' },
        ORIGIN,
        null,
        'claude',
      ),
    ).rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a canonical claude descriptor at the gate, then fails closed at the local transport', async () => {
    const { assimilate } = await import('../src/remote-client.js');
    await expect(
      assimilate(
        { cube_id: 'cube-1', role_id: 'role-1', model: 'claude:claude-opus-4-8' },
        ORIGIN,
        null,
        'claude',
      ),
    ).rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a selector with no model passes the gate and fails closed at the local transport', async () => {
    const { assimilate } = await import('../src/remote-client.js');
    await expect(
      assimilate({ cube_id: 'cube-1', role_id: 'role-1' }, ORIGIN, null, 'claude'),
    ).rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a selector with an explicitly null model passes the gate and fails closed at the local transport', async () => {
    const { assimilate } = await import('../src/remote-client.js');
    await expect(
      assimilate({ cube_id: 'cube-1', role_id: 'role-1', model: null }, ORIGIN, null, 'claude'),
    ).rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
