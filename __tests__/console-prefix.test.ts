/**
 * Tests for the gh#25 drone self-identification console prefix.
 *
 * Pure-function tests on the prefix resolution: cube-cache-hit /
 * cube-cache-miss / read-error fallback shapes. No real filesystem
 * access — getActiveCube is mocked per-test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/cubes.js', () => ({
  getActiveCube: vi.fn(),
}));

import { getActiveCube } from '../src/cubes.js';
import {
  initConsolePrefix,
  droneIdPrefix,
  consolePrefix,
  cerr,
  _resetCachedPrefixForTests,
} from '../src/console-prefix.js';

beforeEach(() => {
  _resetCachedPrefixForTests();
  vi.clearAllMocks();
});

describe('initConsolePrefix — cube-cache-hit', () => {
  it('returns `[drone-label · cube-name]` when cube is cached', async () => {
    (getActiveCube as any).mockResolvedValue({
      cubeId: '00000000-0000-0000-0000-000000000001',
      droneId: '00000000-0000-0000-0000-000000000002',
      name: 'borg-mcp',
      sessionToken: 'tok',
      droneLabel: 'drone-6',
      apiUrl: 'https://127.0.0.1:7091',
      serverTrustIdentity: 'spki-sha256:test-server',
    });
    const prefix = await initConsolePrefix();
    expect(prefix).toBe('[drone-6 · borg-mcp]');
  });

  it('caches the resolved prefix across subsequent reads', async () => {
    (getActiveCube as any).mockResolvedValue({
      cubeId: '00000000-0000-0000-0000-000000000001',
      droneId: '00000000-0000-0000-0000-000000000002',
      name: 'cube-a',
      sessionToken: 't',
      droneLabel: 'drone-x',
      apiUrl: 'https://x',
    });
    await initConsolePrefix();
    // Mutate the mock — cached value should NOT re-resolve.
    (getActiveCube as any).mockResolvedValue(null);
    const prefix = await initConsolePrefix();
    expect(prefix).toBe('[drone-x · cube-a]');
    expect(droneIdPrefix()).toBe('[drone-x · cube-a]');
  });
});

describe('initConsolePrefix — cube-cache-miss', () => {
  // gh#818 P1: the not-yet-assimilated shape is the neutral `[borg · <repo>]`
  // (matches the unassimilated terminal-title shape), NOT `[unassimilated · …]`
  // which read as a fault. It must never contain the word "unassimilated".
  it('falls back to neutral `[borg · <repo>]` when no cube is cached', async () => {
    (getActiveCube as any).mockResolvedValue(null);
    const prefix = await initConsolePrefix();
    expect(prefix).toMatch(/^\[borg · /);
    expect(prefix).not.toContain('unassimilated');
  });

  it('falls back when getActiveCube throws (defensive)', async () => {
    (getActiveCube as any).mockRejectedValue(new Error('fs error'));
    const prefix = await initConsolePrefix();
    expect(prefix).toMatch(/^\[borg · /);
    expect(prefix).not.toContain('unassimilated');
  });

  it('falls back when cached entry lacks droneLabel', async () => {
    (getActiveCube as any).mockResolvedValue({
      cubeId: '00000000-0000-0000-0000-000000000001',
      droneId: '00000000-0000-0000-0000-000000000002',
      name: 'cube',
      sessionToken: 't',
      droneLabel: '',
      apiUrl: 'https://x',
    });
    const prefix = await initConsolePrefix();
    expect(prefix).toMatch(/^\[borg · /);
    expect(prefix).not.toContain('unassimilated');
  });
});

describe('droneIdPrefix — synchronous getter', () => {
  it('returns neutral `[borg · <repo>]` fallback when initConsolePrefix has not run', () => {
    // No init call. Pure synchronous read.
    expect(droneIdPrefix()).toMatch(/^\[borg · /);
    expect(droneIdPrefix()).not.toContain('unassimilated');
  });

  it('returns the cached prefix after init', async () => {
    (getActiveCube as any).mockResolvedValue({
      cubeId: '00000000-0000-0000-0000-000000000001',
      droneId: '00000000-0000-0000-0000-000000000002',
      name: 'c',
      sessionToken: 't',
      droneLabel: 'd-2',
      apiUrl: 'u',
    });
    await initConsolePrefix();
    expect(droneIdPrefix()).toBe('[d-2 · c]');
  });
});

describe('consolePrefix — styled', () => {
  it('returns a chalk-styled prefix with a trailing space', async () => {
    (getActiveCube as any).mockResolvedValue({
      cubeId: '00000000-0000-0000-0000-000000000001',
      droneId: '00000000-0000-0000-0000-000000000002',
      name: 'c',
      sessionToken: 't',
      droneLabel: 'd-3',
      apiUrl: 'u',
    });
    await initConsolePrefix();
    const styled = consolePrefix();
    // chalk passthrough on non-TTY emits raw text; the key invariant is
    // that the prefix appears verbatim and ends with a space.
    expect(styled).toContain('[d-3 · c]');
    expect(styled.endsWith(' ')).toBe(true);
  });
});

describe('cerr — drop-in console.error replacement', () => {
  it('prepends the prefix to a string first arg', async () => {
    (getActiveCube as any).mockResolvedValue({
      cubeId: '00000000-0000-0000-0000-000000000001',
      droneId: '00000000-0000-0000-0000-000000000002',
      name: 'c',
      sessionToken: 't',
      droneLabel: 'd-4',
      apiUrl: 'u',
    });
    await initConsolePrefix();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cerr('hello');
    expect(spy).toHaveBeenCalledTimes(1);
    const firstArg = spy.mock.calls[0][0] as string;
    expect(firstArg).toContain('[d-4 · c]');
    expect(firstArg).toContain('hello');
    spy.mockRestore();
  });

  it('passes additional args through unchanged', async () => {
    (getActiveCube as any).mockResolvedValue({
      cubeId: '00000000-0000-0000-0000-000000000001',
      droneId: '00000000-0000-0000-0000-000000000002',
      name: 'c',
      sessionToken: 't',
      droneLabel: 'd-5',
      apiUrl: 'u',
    });
    await initConsolePrefix();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const obj = { foo: 1 };
    cerr('label:', obj);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(obj);
    spy.mockRestore();
  });

  it('handles non-string first arg by passing prefix as own argument', async () => {
    (getActiveCube as any).mockResolvedValue(null);
    await initConsolePrefix();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    cerr(err);
    expect(spy).toHaveBeenCalledTimes(1);
    // Prefix is the first arg; the original arg shifts to position 1.
    expect(spy.mock.calls[0][1]).toBe(err);
    spy.mockRestore();
  });
});
