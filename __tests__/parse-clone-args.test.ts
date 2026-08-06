import { describe, expect, it } from 'vitest';
import { parseCloneArgs } from '../src/parse-clone-args';

describe('borg clone argument parsing', () => {
  it('parses the repository URL and all supported controls', () => {
    expect(parseCloneArgs([
      'https://github.com/example/project.git',
      '--destination', '/tmp/project',
      '--name', 'reviewer',
      '--branch', 'feature/reviewer',
      '--no-launch',
    ])).toEqual({
      ok: true,
      args: {
        repositoryUrl: 'https://github.com/example/project.git',
        flags: {
          destination: '/tmp/project',
          name: 'reviewer',
          branch: 'feature/reviewer',
          noLaunch: true,
        },
      },
    });
  });

  it('requires exactly one repository URL', () => {
    expect(parseCloneArgs([])).toMatchObject({ ok: false, error: 'a repository URL is required' });
    expect(parseCloneArgs(['one', 'two'])).toMatchObject({ ok: false, error: 'unexpected extra argument: two' });
  });

  it('rejects unknown options and missing option values', () => {
    expect(parseCloneArgs(['repo', '--wat'])).toMatchObject({ ok: false, error: expect.stringContaining('unknown option') });
    expect(parseCloneArgs(['repo', '--destination'])).toMatchObject({ ok: false, error: '--destination requires a value' });
    expect(parseCloneArgs(['repo', '--branch', '--no-launch'])).toMatchObject({ ok: false, error: '--branch requires a value' });
  });

  it('redacts a credential-bearing extra positional from parser diagnostics', () => {
    const secret = 'parse-secret-317';
    const result = parseCloneArgs(['safe', `https://alice:${secret}@example.com/org/repo.git`]);

    expect(result).toMatchObject({ ok: false, error: 'unexpected extra argument: https://<credentials>@example.com/org/repo.git' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
