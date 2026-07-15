import { describe, it, expect } from 'vitest';
import { composeGetStarted, shouldShowGetStarted } from '../src/get-started';

describe('shouldShowGetStarted — fresh-vs-configured rule (gh#817)', () => {
  it('shows get-started only when NEITHER token is present (truly fresh)', () => {
    expect(shouldShowGetStarted(false, false)).toBe(true);
  });

  it('does NOT show get-started when a refresh token is present (durable configured signal)', () => {
    // primary case: refresh present even if the id_token has expired → configured
    expect(shouldShowGetStarted(true, false)).toBe(false);
  });

  it('does NOT show get-started when only an id_token is present (no-refresh fallback)', () => {
    expect(shouldShowGetStarted(false, true)).toBe(false);
  });

  it('does NOT show get-started when both tokens are present', () => {
    expect(shouldShowGetStarted(true, true)).toBe(false);
  });
});

describe('composeGetStarted — user-visible text (gh#817)', () => {
  it('points at the borg setup → borg assimilate path', () => {
    const out = composeGetStarted(true);
    expect(out).toContain('borg setup');
    expect(out).toContain('borg assimilate');
  });

  it('omits the install-an-agent-CLI step when an agent CLI is present', () => {
    const out = composeGetStarted(true);
    expect(out).not.toContain('claude.ai/download');
    expect(out).not.toContain('developers.openai.com/codex');
  });

  it('leads with the install-an-agent-CLI step (before borg setup) when none is present', () => {
    const out = composeGetStarted(false);
    expect(out).toContain('claude.ai/download');
    expect(out).toContain('developers.openai.com/codex');
    expect(out.indexOf('claude.ai/download')).toBeLessThan(out.indexOf('borg setup'));
  });

  it('carries ZERO auth material (no token/secret words — SR gh#817 constraint)', () => {
    for (const hasCli of [true, false]) {
      const out = composeGetStarted(hasCli).toLowerCase();
      expect(out).not.toContain('token');
      expect(out).not.toContain('refresh_token');
      expect(out).not.toContain('id_token');
      expect(out).not.toContain('bearer');
    }
  });
});
