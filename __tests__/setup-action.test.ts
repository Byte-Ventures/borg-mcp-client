import { describe, it, expect } from 'vitest';
import { setupActionForSession } from '../src/setup-action.js';

/**
 * gh#794 (CR 9f302b15): pins the setup auth-step SR#3 mapping. `tsc` proves
 * setup.ts's switch compiles; this proves it MAPS correctly — esp. that a
 * 'dead' session RE-AUTHs (never short-circuits past the failure #794 fixes).
 */
describe('setupActionForSession (gh#794 SR#3 mapping)', () => {
  it('valid → skip (short-circuit OAuth)', () => {
    expect(setupActionForSession('valid')).toBe('skip');
  });

  it('dead → reauth (NEVER short-circuit past a dead token — SR#3)', () => {
    expect(setupActionForSession('dead')).toBe('reauth');
  });

  it('transient → retry (network blip: do not re-auth, do not destroy)', () => {
    expect(setupActionForSession('transient')).toBe('retry');
  });
});
