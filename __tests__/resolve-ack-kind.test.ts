import { describe, expect, it } from 'vitest';
import { resolveAckKind } from '../src/index';

// gh#501: the borg_tool dispatcher only requires its inner arguments to be an
// object, so the direct-tool enum schema does not guard borg_ack.kind. An
// invalid kind must be REFUSED, not silently coerced to a state-changing ack.
describe('resolveAckKind', () => {
  it('defaults an absent kind to ack (documented default path)', () => {
    // Absent key arrives as undefined, or as null if a host normalizes it.
    expect(resolveAckKind(undefined)).toBe('ack');
    expect(resolveAckKind(null)).toBe('ack');
  });

  it('accepts the two valid kinds verbatim', () => {
    expect(resolveAckKind('ack')).toBe('ack');
    expect(resolveAckKind('claim')).toBe('claim');
  });

  it('refuses a present, invalid kind instead of coercing it', () => {
    for (const bad of ['bogus', 'ACK', 'Claim', '', 'ack ', 42, {}, ['ack'], true]) {
      expect(() => resolveAckKind(bad)).toThrow(/kind/);
    }
  });
});
