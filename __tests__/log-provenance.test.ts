import { describe, expect, it, vi } from 'vitest';
import {
  auditMessageShas,
  renderProvenance,
  requiresRefs,
  resolveRefs,
  validateRefs,
  type RunGit,
} from '../src/log-provenance.js';

const HEAD = '1234567890abcdef1234567890abcdef12345678';

describe('borg_log Git provenance', () => {
  it('C1 resolves refs with the guarded Git invocation and renders them in order', () => {
    const runGit = vi.fn<RunGit>(() => ({ status: 0, stdout: `${HEAD}\n` }));
    const resolved = resolveRefs(['HEAD', 'origin/main'], '/repo', runGit);

    expect(runGit).toHaveBeenNthCalledWith(
      1,
      '/repo',
      ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
    );
    expect(runGit).toHaveBeenNthCalledWith(
      2,
      '/repo',
      ['rev-parse', '--verify', '--quiet', '--end-of-options', 'origin/main^{commit}'],
    );
    expect(`ready${renderProvenance(resolved)}`).toBe(
      `ready\n\nHEAD = ${HEAD}\norigin/main = ${HEAD}`,
    );
  });

  it('C2 refuses the first unresolved ref with Git stderr', () => {
    const runGit = vi.fn<RunGit>(() => ({ status: 1, stderr: 'fatal: bad revision\n' }));
    expect(() => resolveRefs(['missing'], '/repo', runGit)).toThrow(
      'Could not resolve Git ref "missing": fatal: bad revision',
    );
  });

  it('C3 refuses leading dashes before Git runs', () => {
    const runGit = vi.fn<RunGit>();
    expect(() => resolveRefs(validateRefs(['--output=x']), '/repo', runGit)).toThrow(
      'must not start with "-"',
    );
    expect(runGit).not.toHaveBeenCalled();
  });

  it.each([
    // Incidents 1-3 retain exact posted prefixes; their lost tails are fixed zero padding.
    ['5767f743ef710000000000000000000000000000', '5767f747ca8472bc4ba2ed847e3360eedf53f6d6'],
    ['d67a96b15cb60000000000000000000000000000', 'd67a96b4faa76138f04ccc440fa6b13647020ab2'],
    ['627b523e25640000000000000000000000000000', '627b52354595fe9249935ce01db7bc859b30917e'],
    ['a5f45b3068d5cf2fe0cf70f13854d0fe957384a2', 'a5f45b3fa341928bfa86c7a4e55a66b430d18f5c'],
    ['fd99aaa5f850a699941d7f3c0d150da60e8e1ddb', 'fd99aaa720f68e3871bc0583deb76dc3e1bfc5e4'],
  ])('C4 refuses incident-shaped expansion %s when its prefix resolves to %s', (posted, real) => {
    const runGit = vi.fn<RunGit>((_cwd, args) => {
      const ref = args.at(-1)?.replace(/\^\{commit\}$/u, '');
      return ref === posted.slice(0, 7)
        ? { status: 0, stdout: `${real}\n` }
        : { status: 1 };
    });
    const result = auditMessageShas(`REVIEW ${posted}`, '/repo', runGit);

    expect(result.refusal).toContain(posted);
    expect(result.refusal).toContain(real);
    expect(result.refusal).toContain('refs parameter');
  });

  it('C5 allows a foreign SHA and reports it as unverified', () => {
    const foreign = 'abcdef0123456789abcdef0123456789abcdef01';
    const runGit = vi.fn<RunGit>(() => ({ status: 1 }));
    expect(auditMessageShas(`foreign ${foreign}`, '/repo', runGit)).toEqual({
      unverified: [foreign],
    });
  });

  it('C6 identifies only REVIEW-READY-prefixed messages', () => {
    expect(requiresRefs('REVIEW-READY branch')).toBe(true);
    expect(requiresRefs('REVIEW-READY: branch')).toBe(true);
    expect(requiresRefs('note REVIEW-READY branch')).toBe(false);
  });

  it('validates the complete refs shape at the client boundary', () => {
    expect(validateRefs(undefined)).toEqual([]);
    expect(validateRefs(['HEAD'])).toEqual(['HEAD']);
    expect(() => validateRefs([])).toThrow('1-8');
    expect(() => validateRefs(['HEAD', 'HEAD'])).toThrow('duplicated');
    expect(() => validateRefs(['bad ref'])).toThrow('whitespace');
    expect(() => validateRefs(['x'.repeat(201)])).toThrow('200 UTF-8 bytes');
  });
});
