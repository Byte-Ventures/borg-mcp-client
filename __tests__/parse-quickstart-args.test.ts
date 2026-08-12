import { describe, expect, it } from 'vitest';
import { parseQuickstartArgs } from '../src/parse-quickstart-args';

describe('parseQuickstartArgs', () => {
  it('parses the template, whole-plan confirmation, and a fully specified roster', () => {
    expect(parseQuickstartArgs([
      '--template', 'starter', '--role', 'builder:2', '--role', 'code-reviewer', '--yes',
    ])).toEqual({
      ok: true,
      args: {
        template: 'starter',
        roles: [{ slug: 'builder', count: 2 }, { slug: 'code-reviewer', count: 1 }],
        yes: true,
      },
    });
  });

  it.each([
    [['--role', 'Builder'], 'invalid role'],
    [['--role', 'builder:0'], 'invalid role'],
    [['--role'], '--role requires'],
    [['--template', 'unknown'], 'unknown template'],
    [['--bogus'], 'unknown option'],
  ] as const)('rejects invalid input %#', (argv, message) => {
    const result = parseQuickstartArgs(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});
