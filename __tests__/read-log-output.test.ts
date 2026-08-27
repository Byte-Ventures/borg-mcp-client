import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('borg_read-log output', () => {
  it('surfaces has_more as the primary unread-drain signal (gh#712)', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      '⚠ has_more: true — call \\`borg_read-log unread_only=true\\` again until has_more=false so you finish draining unread entries.',
    );
    expect(source).toContain(
      'more unread ${behind_by === 1 ? \'entry\' : \'entries\'} addressed to you — call \\`borg_read-log unread_only=true\\` again until behind_by=0 so you don\'t skip messages.',
    );
  });
});
