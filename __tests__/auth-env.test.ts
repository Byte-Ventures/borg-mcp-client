/**
 * Tests for the surviving auth-env helper. The isKeyringAvailable probe was
 * DELETED with the OS keychain (Queen rescope — credentials now rest in the 0600
 * file store, so there is no keychain to probe).
 */
import { describe, it, expect } from 'vitest';
import { envToggleOn } from '../src/auth-env.js';

describe('envToggleOn', () => {
  it('is off for unset and the falsy spellings', () => {
    for (const v of [undefined, '', ' ', '0', 'false', 'FALSE', 'no', ' No ']) {
      expect(envToggleOn(v)).toBe(false);
    }
  });

  it('is on for any other non-empty value', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
      expect(envToggleOn(v)).toBe(true);
    }
  });
});
