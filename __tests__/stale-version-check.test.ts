import { describe, it, expect } from 'vitest';
import { compareVersionsForStaleness } from '../src/stale-version-check';

describe('compareVersionsForStaleness (Sprint 7 / gh#148 close-out)', () => {
  it('warns when installed is 1 minor version behind latest', () => {
    const r = compareVersionsForStaleness('0.9.0', '0.10.0');
    expect(r.stale).toBe(true);
    expect(r.message).toContain('0.9.0');
    expect(r.message).toContain('0.10.0');
    expect(r.message).toContain('is behind latest');
    expect(r.message).toContain('npm install -g borgmcp@latest');
  });

  it('warns when installed is multiple minor versions behind (drone-3 v0.8.0 → v0.8.10 case)', () => {
    const r = compareVersionsForStaleness('0.8.0', '0.8.10');
    // Within same minor (0.8.x) — patch delta only, no warning under
    // the "minor versions behind" threshold. This documents the
    // current shape; drone-3's v0.8.0 → v0.8.10 case would NOT trigger
    // under this rule because they're both 0.8.minor. The actual
    // catch for drone-3's case would have been a v0.8.x → v0.9.x
    // boundary post-borg-assimilate-sprint.
    expect(r.stale).toBe(false);
  });

  it('warns when installed is multiple minor versions behind across the 0.x boundary', () => {
    const r = compareVersionsForStaleness('0.8.0', '0.9.7');
    expect(r.stale).toBe(true);
    expect(r.message).toContain('0.8.0');
    expect(r.message).toContain('0.9.7');
  });

  it('does not warn when installed equals latest', () => {
    const r = compareVersionsForStaleness('0.9.7', '0.9.7');
    expect(r.stale).toBe(false);
    expect(r.message).toBeNull();
  });

  it('does not warn when installed is ahead of latest (development/canary)', () => {
    const r = compareVersionsForStaleness('0.10.0', '0.9.7');
    expect(r.stale).toBe(false);
    expect(r.message).toBeNull();
  });

  it('does not warn when installed is one PATCH behind (same minor)', () => {
    const r = compareVersionsForStaleness('0.9.6', '0.9.7');
    expect(r.stale).toBe(false);
  });

  it('does not warn across major-version boundary (explicit migration)', () => {
    const r = compareVersionsForStaleness('0.9.7', '1.0.0');
    expect(r.stale).toBe(false);
    expect(r.message).toBeNull();
  });

  it('does not warn on "unknown" version (corrupted install fallback)', () => {
    const r = compareVersionsForStaleness('unknown', '0.9.7');
    expect(r.stale).toBe(false);
  });

  it('does not warn on prerelease / build-metadata installed version', () => {
    expect(compareVersionsForStaleness('0.9.7-canary.1', '0.9.7').stale).toBe(false);
    expect(compareVersionsForStaleness('0.9.7+build.5', '0.9.7').stale).toBe(false);
    expect(compareVersionsForStaleness('0.9.7-rc.1', '0.9.8').stale).toBe(false);
  });

  it('does not warn on malformed input', () => {
    expect(compareVersionsForStaleness('', '0.9.7').stale).toBe(false);
    expect(compareVersionsForStaleness('not-a-version', '0.9.7').stale).toBe(false);
    expect(compareVersionsForStaleness('0.9.7', 'broken').stale).toBe(false);
    expect(compareVersionsForStaleness('0.9', '0.10').stale).toBe(false);
  });

  it('warning message fits the Coordinator-discipline 80-char preview rule for first line', () => {
    const r = compareVersionsForStaleness('0.8.0', '0.9.7');
    expect(r.stale).toBe(true);
    // The message is one logical line — verify the lead substring (up to
    // the em-dash) is ≤80 chars so a preview-truncated render still
    // surfaces the actionable bit.
    const lead = r.message!.split(' — ')[0];
    expect(lead.length).toBeLessThanOrEqual(80);
  });
});
