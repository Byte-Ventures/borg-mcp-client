import { describe, expect, it } from 'vitest';
import { parseCloneArgs } from '../src/parse-clone-args';

describe('parseCloneArgs', () => {
  it('accepts the URL, destination, and full quickstart plan', () => {
    expect(parseCloneArgs([
      'https://example.com/org/repo.git', 'checkout',
      '--template', 'starter', '--role', 'builder:2', '--role', 'code-reviewer', '-y',
    ])).toEqual({
      ok: true,
      args: {
        repositoryUrl: 'https://example.com/org/repo.git',
        destination: 'checkout',
        checkoutOnly: false,
        template: 'starter',
        roles: [{ slug: 'builder', count: 2 }, { slug: 'code-reviewer', count: 1 }],
        yes: true,
      },
    });
  });

  it.each(['--checkout-only', '--no-launch'])('accepts checkout-only spelling %s', (flag) => {
    expect(parseCloneArgs(['https://example.com/org/repo.git', flag])).toEqual({
      ok: true,
      args: {
        repositoryUrl: 'https://example.com/org/repo.git',
        checkoutOnly: true,
        roles: [],
        yes: false,
      },
    });
  });

  it('does not echo values attached to unknown options', () => {
    const result = parseCloneArgs(['https://example.com/org/repo.git', '--token=SECRET']);
    expect(result).toEqual({
      ok: false,
      error: 'unknown option --token=<redacted>; supported: --template, --role, --yes/-y, --checkout-only, --no-launch',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each(['--template=software-dev', '-yq'])('echoes the full unsupported token %s', (option) => {
    const result = parseCloneArgs(['https://example.com/org/repo.git', option]);
    expect(result).toEqual({
      ok: false,
      error: `unknown option ${option}; supported: --template, --role, --yes/-y, --checkout-only, --no-launch`,
    });
  });

  it.each([
    [[], 'repository URL'],
    [['url', 'one', 'two'], 'unexpected extra'],
    [['url', '--checkout-only', '--no-launch'], 'more than once'],
    [['url', '--checkout-only', '--template', 'bogus'], 'cannot be combined'],
    [['url', '--no-launch', '--role', 'builder'], 'cannot be combined'],
    [['url', '--checkout-only', '--yes'], 'cannot be combined'],
    [['url', '--role', 'Builder'], 'invalid role'],
    [['url', '--template', 'unknown'], 'unknown template'],
  ] as const)('rejects invalid argv %#', (argv, message) => {
    const result = parseCloneArgs(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});
