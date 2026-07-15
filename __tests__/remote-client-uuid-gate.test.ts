/**
 * gh#782 (reassign half): drone_id must be UUID-shape-validated BEFORE it
 * is interpolated into the request path in remote-client.ts. PR #781 added
 * the gate at the borg_evict-drone tool layer; this covers the layer that
 * actually builds the URL, for BOTH path-interpolating drone mutations:
 *
 *   reassignDrone -> PATCH  /api/drones/:id
 *   evictDrone    -> DELETE /api/drones/:id
 *
 * The gate must throw before any token fetch or network call (path-shaped
 * values like "../cubes/<uuid>" never reach URL construction), and must
 * not change behavior for valid UUIDs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertUuidShape } from '../src/evict-drone';

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

describe('remote-client path-interpolation gate (gh#782)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ drone: { id: VALID_UUID, label: 'one-of-one-builder', role_id: 'role-1' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
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

  it('reassignDrone with a valid UUID proceeds unchanged (PATCH to the drone path)', async () => {
    const { reassignDrone } = await import('../src/remote-client.js');
    const { drone } = await reassignDrone(VALID_UUID, 'role-1');
    expect(drone.id).toBe(VALID_UUID);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(`/api/drones/${VALID_UUID}`);
    expect(init!.method).toBe('PATCH');
  });

  it('evictDrone with a valid UUID proceeds unchanged (DELETE to the drone path)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const { evictDrone } = await import('../src/remote-client.js');
    await evictDrone(VALID_UUID);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(`/api/drones/${VALID_UUID}`);
    expect(init!.method).toBe('DELETE');
  });
});
