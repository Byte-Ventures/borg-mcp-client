/**
 * gh#877: unit coverage for the shared drone-lifecycle signal helpers used by
 * all three client wire layers (log-stream SSE, remote-client authedFetch,
 * index tool funnel). The discrimination decision keys on the STRUCTURED code
 * (errorCodeFromBody), never the bare HTTP status — SEC R2/R4.
 */

import { describe, it, expect } from 'vitest';
import {
  DroneEvictedError,
  DRONE_EVICTED_CODE,
  EVICTED_RESULT_MARKER,
  errorCodeFromBody,
  formatEvictedToolResult,
} from '../src/drone-lifecycle';

describe('errorCodeFromBody', () => {
  it('reads the top-level { code } shape (sanitizeError/createHttpError funnel)', () => {
    expect(
      errorCodeFromBody(JSON.stringify({ code: DRONE_EVICTED_CODE, message: 'x' }))
    ).toBe(DRONE_EVICTED_CODE);
  });

  it('reads the nested { error: { code } } shape', () => {
    expect(
      errorCodeFromBody(JSON.stringify({ error: { code: DRONE_EVICTED_CODE } }))
    ).toBe(DRONE_EVICTED_CODE);
  });

  it('returns null for non-JSON, empty, or code-less bodies (no false authority)', () => {
    expect(errorCodeFromBody('not json at all')).toBeNull();
    expect(errorCodeFromBody('')).toBeNull();
    expect(errorCodeFromBody(JSON.stringify({ message: 'no code here' }))).toBeNull();
    // A peer can't fake a code by posting sentinel-shaped TEXT into a body
    // field that isn't `code` — only the real worker funnel sets `code`.
    expect(errorCodeFromBody(JSON.stringify({ note: '[CUBE-EVICTED]' }))).toBeNull();
  });
});

describe('error classes', () => {
  it('DroneEvictedError carries its name + default message', () => {
    const e = new DroneEvictedError();
    expect(e.name).toBe('DroneEvictedError');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/evicted/i);
  });
});

describe('tool-result formatters', () => {
  it('EVICTED result marks terminal + spells out the sanctioned shutdown sequence', () => {
    const text = formatEvictedToolResult('Drone evicted.');
    expect(text).toContain(EVICTED_RESULT_MARKER);
    expect(text).toMatch(/TaskStop the inbox Monitor/i);
    expect(text).toMatch(/do NOT reschedule \/loop/i);
    expect(text).toMatch(/410/);
  });

});
