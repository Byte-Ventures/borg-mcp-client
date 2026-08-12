import { describe, expect, it } from 'vitest';
import { parseCloneArgs } from '../src/parse-clone-args';

describe('parseCloneArgs', () => {
  it('accepts the ratified URL, positional destination, and only flag', () => {
    expect(parseCloneArgs(['https://example.com/org/repo.git', 'checkout', '--no-launch'])).toEqual({
      ok: true,
      args: {
        repositoryUrl: 'https://example.com/org/repo.git',
        destination: 'checkout',
        noLaunch: true,
      },
    });
  });

  it('does not echo values attached to unknown options', () => {
    const result = parseCloneArgs(['https://example.com/org/repo.git', '--token=SECRET']);
    expect(result).toEqual({ ok: false, error: 'unknown option --token; the only option is --no-launch' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it.each([
    [[], 'repository URL'],
    [['url', 'one', 'two'], 'unexpected extra'],
    [['url', '--no-launch', '--no-launch'], 'more than once'],
  ] as const)('rejects invalid argv %#', (argv, message) => {
    const result = parseCloneArgs(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});
