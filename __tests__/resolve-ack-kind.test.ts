import { describe, expect, it } from 'vitest';
import { resolveAckKind } from '../src/index';

// gh#501: the borg_tool dispatcher only requires its inner arguments to be an
// object, so the direct-tool enum schema does not guard borg_ack.kind. An
// invalid kind must be REFUSED, not silently coerced to a state-changing ack.
describe('resolveAckKind', () => {
  it('defaults ONLY a missing (undefined) kind to ack', () => {
    // Absent optional arrives as undefined; that is the documented default.
    expect(resolveAckKind(undefined)).toBe('ack');
  });

  it('accepts the two valid kinds verbatim', () => {
    expect(resolveAckKind('ack')).toBe('ack');
    expect(resolveAckKind('claim')).toBe('claim');
  });

  it('refuses every present invalid kind — including explicit null — instead of coercing it', () => {
    // gh#501: borg_tool can pass {kind:null}; a present value that is not
    // 'ack'/'claim' must fail, not default to a state-changing ack.
    for (const bad of [null, 'bogus', 'ACK', 'Claim', '', 'ack ', 42, {}, ['ack'], true]) {
      expect(() => resolveAckKind(bad)).toThrow(/kind/);
    }
  });
});
