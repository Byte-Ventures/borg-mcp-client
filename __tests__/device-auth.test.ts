/**
 * Tests for gh#557 RFC 8628 device-grant flow (no-browser auth).
 *
 * `requestDeviceCode` asks Google for a device_code + user_code; the user
 * visits the verification URL on ANY device (phone/laptop) and enters the
 * code. `pollForDeviceToken` then polls Google's token endpoint until the
 * user authorizes — honoring the RFC 8628 poll semantics:
 *   - authorization_pending → keep polling at `interval`
 *   - slow_down            → increase the interval by 5s
 *   - access_denied        → user rejected; abort
 *   - expired_token        → user_code TTL elapsed; abort
 *   - success (200)        → return id_token/refresh_token/expires_in
 *
 * fetch + sleep + now are injected so the state machine is fully
 * deterministic without real network, timers, or Google.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  requestDeviceCode,
  pollForDeviceToken,
  DeviceAuthError,
  type DeviceAuthConfig,
  type DeviceCodeResponse,
} from '../src/device-auth.js';

const CONFIG: DeviceAuthConfig = {
  clientId: 'device-client.apps.googleusercontent.com',
  clientSecret: 'device-secret',
  scopes: ['openid', 'email', 'profile'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch stub that returns queued responses in order. */
function queuedFetch(responses: Response[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    const r = responses[i++];
    if (!r) throw new Error(`queuedFetch: no response queued for call ${i}`);
    return r;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('requestDeviceCode (gh#557 RFC 8628)', () => {
  it('POSTs client_id + scope to the device endpoint and parses the response', async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse({
        device_code: 'DEV-CODE',
        user_code: 'WXYZ-ABCD',
        verification_url: 'https://www.google.com/device',
        expires_in: 1800,
        interval: 5,
      }),
    ]);

    const result = await requestDeviceCode(CONFIG, { fetch, sleep: async () => {} });

    expect(result.device_code).toBe('DEV-CODE');
    expect(result.user_code).toBe('WXYZ-ABCD');
    expect(result.verification_url).toBe('https://www.google.com/device');
    expect(result.interval).toBe(5);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/device/code');
    expect(calls[0].body).toContain('client_id=device-client');
    // scopes joined with a space → URL-encoded '+'
    expect(calls[0].body).toContain('scope=openid');
  });

  it('throws DeviceAuthError when the device endpoint rejects (e.g. invalid_client)', async () => {
    const { fetch } = queuedFetch([jsonResponse({ error: 'invalid_client' }, 401)]);
    await expect(
      requestDeviceCode(CONFIG, { fetch, sleep: async () => {} })
    ).rejects.toBeInstanceOf(DeviceAuthError);
  });

  it('defaults interval to 5s when Google omits it', async () => {
    const { fetch } = queuedFetch([
      jsonResponse({
        device_code: 'D',
        user_code: 'U',
        verification_url: 'https://www.google.com/device',
        expires_in: 1800,
      }),
    ]);
    const result = await requestDeviceCode(CONFIG, { fetch, sleep: async () => {} });
    expect(result.interval).toBe(5);
  });
});

describe('pollForDeviceToken (gh#557 RFC 8628 state machine)', () => {
  const deviceCode: DeviceCodeResponse = {
    device_code: 'DEV-CODE',
    user_code: 'WXYZ-ABCD',
    verification_url: 'https://www.google.com/device',
    expires_in: 1800,
    interval: 5,
  };

  it('returns tokens on an immediate success (200)', async () => {
    const { fetch, calls } = queuedFetch([
      jsonResponse({
        id_token: 'ID-TOKEN',
        refresh_token: 'REFRESH-TOKEN',
        expires_in: 3600,
      }),
    ]);
    const sleep = vi.fn(async () => {});

    const result = await pollForDeviceToken(deviceCode, CONFIG, { fetch, sleep, now: () => 0 });

    expect(result.id_token).toBe('ID-TOKEN');
    expect(result.refresh_token).toBe('REFRESH-TOKEN');
    expect(result.expires_in).toBe(3600);
    // Body carries the RFC 8628 grant + the device_code + client creds.
    expect(calls[0].url).toContain('/token');
    expect(calls[0].body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    expect(calls[0].body).toContain('device_code=DEV-CODE');
    expect(calls[0].body).toContain('client_secret=device-secret');
  });

  it('keeps polling through authorization_pending, then succeeds', async () => {
    const { fetch } = queuedFetch([
      jsonResponse({ error: 'authorization_pending' }, 428),
      jsonResponse({ error: 'authorization_pending' }, 428),
      jsonResponse({ id_token: 'ID', expires_in: 3600 }),
    ]);
    const sleepMs: number[] = [];
    const sleep = async (ms: number) => {
      sleepMs.push(ms);
    };

    const result = await pollForDeviceToken(deviceCode, CONFIG, { fetch, sleep, now: () => 0 });

    expect(result.id_token).toBe('ID');
    // Waited the 5s interval before each of the 3 polls.
    expect(sleepMs).toEqual([5000, 5000, 5000]);
  });

  it('honors slow_down by increasing the poll interval by 5s', async () => {
    const { fetch } = queuedFetch([
      jsonResponse({ error: 'slow_down' }, 403),
      jsonResponse({ id_token: 'ID', expires_in: 3600 }),
    ]);
    const sleepMs: number[] = [];
    const sleep = async (ms: number) => {
      sleepMs.push(ms);
    };

    await pollForDeviceToken(deviceCode, CONFIG, { fetch, sleep, now: () => 0 });

    // First poll at 5s; after slow_down the next interval is 10s.
    expect(sleepMs).toEqual([5000, 10000]);
  });

  it('throws DeviceAuthError(access_denied) when the user rejects', async () => {
    const { fetch } = queuedFetch([jsonResponse({ error: 'access_denied' }, 403)]);
    try {
      await pollForDeviceToken(deviceCode, CONFIG, { fetch, sleep: async () => {}, now: () => 0 });
      throw new Error('expected DeviceAuthError');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('access_denied');
    }
  });

  it('throws DeviceAuthError(expired_token) when Google reports the code expired', async () => {
    const { fetch } = queuedFetch([jsonResponse({ error: 'expired_token' }, 400)]);
    await expect(
      pollForDeviceToken(deviceCode, CONFIG, { fetch, sleep: async () => {}, now: () => 0 })
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('aborts with expired_token once the local deadline passes (no infinite poll)', async () => {
    // Advancing clock: the first now() (deadline = 0 + 1s) is computed at
    // start; the next now() jumps past it → loop must bail before any fetch.
    const { fetch, calls } = queuedFetch([]);
    let t = 0;
    const now = () => {
      const v = t;
      t += 10_000;
      return v;
    };
    await expect(
      pollForDeviceToken({ ...deviceCode, expires_in: 1 }, CONFIG, {
        fetch,
        sleep: async () => {},
        now,
      })
    ).rejects.toMatchObject({ code: 'expired_token' });
    expect(calls).toHaveLength(0);
  });

  it('throws DeviceAuthError on a malformed success body (missing id_token)', async () => {
    const { fetch } = queuedFetch([jsonResponse({ expires_in: 3600 })]);
    await expect(
      pollForDeviceToken(deviceCode, CONFIG, { fetch, sleep: async () => {}, now: () => 0 })
    ).rejects.toBeInstanceOf(DeviceAuthError);
  });
});
