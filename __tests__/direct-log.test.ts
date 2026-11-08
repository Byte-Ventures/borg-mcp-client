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

  it('shows a corrected direct call for a mistaken string recipient', () => {
    expect(() => normalizeLogAudience('Build')).toThrow('{"to":["Build"]}');
    expect(() => normalizeLogAudience('Build')).toThrow('Even one recipient needs an array');
    expect(() => normalizeLogAudience('"broadcast"')).toThrow('For broadcast use {"to":"broadcast"}');
  });

  it.each(([[], undefined, ['builder-demo', 'builder-demo']] as unknown[]).map(value => [value]))('labels malformed-array recovery as an example, not a new destination %#', (audience) => {
    try { normalizeLogAudience(audience); throw new Error('expected refusal'); }
    catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('Direct-delivery example:');
      expect(message).toContain('<existing-selector>');
      expect(message).toContain('use existing selectors from your cube, not a replacement destination');
      expect(message).not.toContain('Build');
    }
  });
});

// gh#491: hosts normalize the manifest's type-less `to` property (kept
// combinator-free by gh#485) to a string and deliver a directed audience
// JSON-encoded. The boundary decodes exactly that shape; nothing else loosens.
describe('borg_log host-serialized audience', () => {
  it('accepts a directed audience delivered as a JSON-encoded array string', () => {
    expect(normalizeLogAudience('["builder-1"]')).toEqual(['builder-1']);
    expect(normalizeLogAudience('["builder-1","id:12345678"]'))
      .toEqual(['builder-1', 'id:12345678']);
    expect(normalizeLogAudience(' ["builder-1"] ')).toEqual(['builder-1']);
  });

  it.each(([
    '[]',
    '"broadcast"',
    '[42]',
    '["builder-1","builder-1"]',
    '[" builder-1"]',
    '["builder-1"',
    '[["builder-1"]]',
    `["${'a'.repeat(121)}"]`,
    JSON.stringify(Array.from({ length: 101 }, (_, index) => `builder-${index}`)),
  ] as string[]).map((value) => [value]))(
    'refuses an invalid serialized audience %#',
    (value) => {
      expect(() => normalizeLogAudience(value)).toThrow(/to|selector/);
    },
  );
});
