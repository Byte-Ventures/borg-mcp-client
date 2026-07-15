/**
 * Tests for gh#557 device-flow wiring decisions in auth.ts.
 *
 * Two pure seams the dispatcher rests on:
 *   - shouldUseDeviceFlow: explicit --no-browser/--device wins, else
 *     auto-detect via isNoBrowserEnv.
 *   - buildDeviceAuthConfig: assembles the DeviceAuthConfig from the
 *     environment and enforces the ESCALATION-1 gate — the live device flow
 *     needs a "TVs & Limited Input devices" OAuth client (GOOGLE_DEVICE_CLIENT_ID);
 *     without it we fail with an actionable error rather than hitting Google
 *     with the Desktop client (which rejects /device/code as invalid_client).
 */
import { describe, it, expect } from 'vitest';
import { shouldUseDeviceFlow, buildDeviceAuthConfig } from '../src/auth.js';

describe('shouldUseDeviceFlow (gh#557)', () => {
  it('returns true when --no-browser/--device is explicit', () => {
    expect(shouldUseDeviceFlow({ noBrowser: true })).toBe(true);
  });

  it('returns false when the caller explicitly forces the browser flow', () => {
    expect(shouldUseDeviceFlow({ noBrowser: false })).toBe(false);
  });
});

describe('buildDeviceAuthConfig (gh#557 ESCALATION-1 — baked-in device client)', () => {
  it('falls back to the baked-in device client id + secret when no env override is set', () => {
    // ESCALATION-1 resolved: the "TVs & Limited Input devices" client is now
    // baked in, so the no-env path returns a usable config (no throw).
    const config = buildDeviceAuthConfig({});
    expect(config.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(config.clientId.length).toBeGreaterThan(0);
    expect(config.clientSecret).toBeTruthy();
    expect(config.scopes).toContain('openid');
  });

  it('an env client-id override wins and does NOT inherit the baked-in secret', () => {
    // Secret pairs with the id SOURCE: overriding the id but not the secret
    // must yield no secret, never the baked-in client's secret (mismatch).
    const config = buildDeviceAuthConfig({
      GOOGLE_DEVICE_CLIENT_ID: 'device-client.apps.googleusercontent.com',
    });
    expect(config.clientId).toBe('device-client.apps.googleusercontent.com');
    expect(config.scopes).toContain('openid');
    expect(config.scopes).toContain('email');
    expect(config.clientSecret).toBeUndefined();
  });

  it('a stray env secret WITHOUT an id override does not re-pair the baked id', () => {
    // Footgun guard: GOOGLE_DEVICE_CLIENT_SECRET set alone must NOT pair the
    // baked id with a foreign secret ({baked id, wrong secret} -> invalid_client).
    // The baked id always keeps the baked secret.
    const config = buildDeviceAuthConfig({ GOOGLE_DEVICE_CLIENT_SECRET: 'stray-secret' });
    expect(config.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(config.clientSecret).not.toBe('stray-secret');
    expect(config.clientSecret).toBeTruthy();
  });

  it('includes the device client secret when provided', () => {
    const config = buildDeviceAuthConfig({
      GOOGLE_DEVICE_CLIENT_ID: 'device-client',
      GOOGLE_DEVICE_CLIENT_SECRET: 'device-secret',
    });
    expect(config.clientSecret).toBe('device-secret');
  });

  it('trims surrounding whitespace from the configured client id', () => {
    const config = buildDeviceAuthConfig({ GOOGLE_DEVICE_CLIENT_ID: '  padded-id\n' });
    expect(config.clientId).toBe('padded-id');
  });
});
