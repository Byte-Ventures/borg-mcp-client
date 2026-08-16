import { describe, expect, it } from 'vitest';
import {
  normalizeLogAudience,
} from '../src/direct-log';

describe('borg_log explicit audience', () => {
  it('accepts broadcast or a non-empty selector array without rewriting it', () => {
    expect(normalizeLogAudience('broadcast')).toBe('broadcast');
    expect(normalizeLogAudience(['builder-1', 'id:12345678']))
      .toEqual(['builder-1', 'id:12345678']);
  });

  it.each(([
    undefined,
    null,
    [],
    'builder-1',
    ['', 'builder-1'],
    [42],
    ['builder-1', 'builder-1'],
    [' builder-1'],
    ['builder-1 '],
    ['builder\u0000one'],
    Array.from({ length: 101 }, (_, index) => `builder-${index}`),
    ['a'.repeat(121)],
    ['é'.repeat(61)],
  ] as unknown[]).map((value) => [value]))(
    'rejects an invalid or omitted audience %#',
    (value) => {
      expect(() => normalizeLogAudience(value)).toThrow(/to|selector/);
    },
  );

  it('does not mutate the caller array', () => {
    const audience = ['builder-1'];
    expect(normalizeLogAudience(audience)).not.toBe(audience);
  });
});
