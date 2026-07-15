import { describe, expect, it } from 'vitest';
import {
  normalizeDirectLogRecipients,
} from '../src/direct-log';

describe('direct borg_log recipient helpers', () => {
  it('normalizes array or scalar to unique non-empty recipient tokens', () => {
    expect(
      normalizeDirectLogRecipients([
        ' one-of-ten-builder ',
        '',
        'one-of-ten-builder',
        'drone-id-2',
        42,
      ])
    ).toEqual(['one-of-ten-builder', 'drone-id-2']);
    expect(normalizeDirectLogRecipients('drone-id-1')).toEqual(['drone-id-1']);
    expect(normalizeDirectLogRecipients(undefined)).toEqual([]);
  });
});
