/**
 * gh#877: unit coverage for the shared drone-lifecycle signal helpers used by
 * all three client wire layers (log-stream SSE, remote-client authedFetch,
 * index tool funnel). The discrimination decision keys on the STRUCTURED code
 * (errorCodeFromBody), never the bare HTTP status — SEC R2/R4.
 */

import { describe, it, expect } from 'vitest';
import {
  CubeDeletedError,
  CUBE_DELETED_RESULT_MARKER,
  DroneEvictedError,
  DRONE_EVICTED_CODE,
  EVICTED_RESULT_MARKER,
  errorCodeFromBody,
  formatCubeDeletedToolResult,
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
    expect(e.message).toMatch(/removed from the cube/i);
  });

  it('CubeDeletedError carries its name + default message', () => {
    const error = new CubeDeletedError();
    expect(error.name).toBe('CubeDeletedError');
    expect(error.message).toMatch(/cube was deleted/i);
  });
});

describe('tool-result formatters', () => {
  it('EVICTED result matches the terminal recovery contract without harness-specific commands', () => {
    const text = formatEvictedToolResult('borg-mcp');
    expect(text).toBe(
      `${EVICTED_RESULT_MARKER} This drone was removed from cube borg-mcp.\n\n` +
      'Borg has stopped listening for activity for this drone. Do not retry this request or restart the loop.\n\n' +
      'Your worktree and project files are unchanged. Finish any local file safety checks, then end this agent session.\n\n' +
      'To rejoin later, start a new session and use a new invitation from the server operator. Do not re-assimilate from this evicted session.',
    );
    expect(text).not.toMatch(/TaskStop|410|\/loop/);
  });

  it('CUBE_DELETED result stops retries without implying that local files were removed', () => {
    const text = formatCubeDeletedToolResult('borg-mcp');
    expect(text).toContain(`${CUBE_DELETED_RESULT_MARKER} Cube borg-mcp was deleted.`);
    expect(text).toContain('Do not retry this request or restart the loop.');
    expect(text).toContain('Your worktree and project files are unchanged.');
    expect(text).not.toMatch(/TaskStop|410|\/loop/);
  });

});
