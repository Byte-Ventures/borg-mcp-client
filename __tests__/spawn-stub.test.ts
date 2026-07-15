import { describe, it, expect, vi } from 'vitest';
import { runSpawn, validateName } from '../src/spawn';

describe('spawn deprecation stub (Phase F Task 18 + Phase G scenario 12)', () => {
  it('runSpawn prints redirect message and exits non-zero', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await runSpawn();
      expect(code).toBe(2);
      const stderrCalls = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrCalls).toContain('borg spawn is removed');
      expect(stderrCalls).toContain('borg assimilate [role] --worktree <name>');
      expect(stderrCalls).toContain('borg spawn drone-2');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('validateName is still re-exported from spawn.ts (backwards-compat)', () => {
    expect(validateName('builder')).toEqual({ ok: true });
    expect(validateName('Bad/Name').ok).toBe(false);
  });
});
