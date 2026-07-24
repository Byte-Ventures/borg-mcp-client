import { describe, expect, it } from 'vitest';
import {
  LocalManageRequiredError,
} from '../src/server-errors.js';
import { formatLocalManageToolResult } from '../src/local-manage-tool-result.js';
import { RoleSectionConflictError } from '../src/local-manage-tool-result.js';

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

  it('escapes control and bidi characters from local section-patch context', () => {
    const result = formatLocalManageToolResult(new RoleSectionConflictError({
      roleId: '44444444-4444-4444-8444-444444444444',
      action: 'insert',
      heading: 'Work\u001b[2J\u202eflow\\path',
      after: 'Scope\r\n"Next"',
    }));
    const text = result?.content[0].text ?? '';

    expect(result?.isError).toBe(true);
    expect(text).toContain('action=insert');
    expect(text).toContain('Work\\u{1b}\\u{5b}2J\\u{202e}flow\\u{5c}path');
    expect(text).toContain('Scope\\u{d}\\u{a}\\u{22}Next\\u{22}');
    for (const unsafe of ['\u001b', '\u202e', '\r', '\nNext', '\\path', '"Next"']) {
      expect(text).not.toContain(unsafe);
    }
  });
});
