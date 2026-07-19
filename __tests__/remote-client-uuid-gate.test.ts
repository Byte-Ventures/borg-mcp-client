/**
 * gh#782 (reassign half): drone_id must be UUID-shape-validated BEFORE it
 * is interpolated into the request path in remote-client.ts, for BOTH
 * path-interpolating drone mutations:
 *
 *   reassignDrone
 *   evictDrone
 *
 * The gate must throw before any token fetch or network call (path-shaped
 * values like "../cubes/<uuid>" never reach URL construction), and must not
 * change behavior for valid UUIDs.
 *
 * The local server does not expose drone mutation
 * routes are not carried by the local server, so a VALID drone_id passes the
 * UUID gate and then fails closed at the local transport with "does not
 * support" — still WITHOUT any network call. The security property under test
 * (the gate rejects path-traversal shapes before URL construction and network)
 * is unchanged. The old cloud drone routes are dead code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertUuidShape } from '../src/evict-drone';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

const VALID_UUID = '22222222-2222-4222-8222-222222222222';
const TRAVERSAL_ID = `../cubes/${VALID_UUID}`;

describe('assertUuidShape', () => {
  it('passes a valid UUID through silently', () => {
    expect(() => assertUuidShape(VALID_UUID, 'drone_id')).not.toThrow();
  });

  it('throws a clear, labelled error on a path-traversal-shaped value', () => {
    expect(() => assertUuidShape(TRAVERSAL_ID, 'drone_id')).toThrow(/drone_id .* not a UUID/);
  });

  it('throws on a drone label', () => {
    expect(() => assertUuidShape('two-of-seventeen-builder', 'drone_id')).toThrow(/not a UUID/);
  });
});

describe('remote-client path-interpolation gate (gh#782, local path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn();
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
        name: 'local-cube',
        sessionToken: SESSION,
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST_IDENTITY,
      })),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('reassignDrone REJECTS a ../-bearing drone_id BEFORE any network call', async () => {
    const { reassignDrone } = await import('../src/remote-client.js');
    await expect(reassignDrone(TRAVERSAL_ID, 'role-1')).rejects.toThrow(/not a UUID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('evictDrone REJECTS a ../-bearing drone_id BEFORE any network call', async () => {
    const { evictDrone } = await import('../src/remote-client.js');
    await expect(evictDrone(TRAVERSAL_ID)).rejects.toThrow(/not a UUID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reassignDrone with a valid UUID remains unsupported without a network call', async () => {
    const { reassignDrone } = await import('../src/remote-client.js');
    await expect(reassignDrone(VALID_UUID, 'role-1')).rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('evictDrone with a valid UUID remains unsupported without a network call', async () => {
    const { evictDrone } = await import('../src/remote-client.js');
    await expect(evictDrone(VALID_UUID)).rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
