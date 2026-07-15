import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('borg_read-log output', () => {
  it('surfaces has_more as the primary unread-drain signal (gh#712)', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('has_more');
    expect(source).toContain('until has_more=false');
  });
});
