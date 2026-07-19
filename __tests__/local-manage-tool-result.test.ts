import { describe, expect, it } from 'vitest';
import {
  LocalManageRequiredError,
} from '../src/server-errors.js';
import { formatLocalManageToolResult } from '../src/local-manage-tool-result.js';

describe('local manage MCP tool result', () => {
  it('starts with the typed marker and excludes server and credential detail', () => {
    const error = new LocalManageRequiredError(
      'update cube settings in cube "local-cube"',
      'local-cube',
      'No cube settings were changed.',
    );
    const result = formatLocalManageToolResult(error);
    const text = result?.content[0].text ?? '';

    expect(result?.isError).toBe(true);
    expect(text.startsWith('[LOCAL-MANAGE-REQUIRED]')).toBe(true);
    expect(text).not.toContain('Error:');
    expect(text).not.toContain('ACCESS_DENIED');
    expect(text).not.toContain('Bearer');
  });

  it('does not intercept unrelated errors', () => {
    expect(formatLocalManageToolResult(new Error('ordinary failure'))).toBeNull();
  });
});
