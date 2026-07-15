/**
 * gh#780 companion fix: auth-failure recovery messages.
 *
 * The pre-gh#780 funnel told the agent "Authentication expired. Run: borg
 * assimilate" for EVERY auth-class failure — and an in-session agent's only
 * reachable assimilate is the borg_assimilate MCP tool, which minted a NEW
 * drone row (the orphan-seat root cause). The classifier must:
 *   - point re-consent cases at `borg setup` (assimilate can't fix auth),
 *   - tell transient-refresh cases to wait/retry (auth self-recovers),
 *   - explicitly warn AGAINST re-assimilating in both,
 *   - stay silent (null) for non-auth errors.
 */

import { describe, it, expect } from 'vitest';
import { authRecoveryMessage } from '../src/auth-recovery.js';

describe('authRecoveryMessage', () => {
  it('transient refresh failure → self-recovers advice, never re-assimilate', () => {
    const msg = authRecoveryMessage({
      name: 'RefreshTransientError',
      message: 'Failed to refresh token: fetch failed',
    });
    expect(msg).toMatch(/transient/i);
    expect(msg).toMatch(/do not.*assimilate/i);
    expect(msg).not.toMatch(/run: borg assimilate/i);
  });

  it('classifies by "Failed to refresh" message text when the error lost its class', () => {
    const msg = authRecoveryMessage({ message: 'Failed to refresh token: Google 503' });
    expect(msg).toMatch(/transient/i);
  });

  it('authentication required/expired → borg setup advice, never re-assimilate', () => {
    for (const text of [
      'Authentication required. Run: borg setup',
      'Authentication expired',
    ]) {
      const msg = authRecoveryMessage({ message: text });
      expect(msg).toMatch(/borg setup/);
      expect(msg).toMatch(/do not.*assimilate/i);
      expect(msg).not.toMatch(/run: borg assimilate/i);
    }
  });

  it('transient classification wins over the generic auth match', () => {
    // A RefreshTransientError whose message also contains "Authentication"
    // must get the wait-and-retry advice, not the re-setup advice.
    const msg = authRecoveryMessage({
      name: 'RefreshTransientError',
      message: 'Authentication refresh hiccup: Failed to refresh token',
    });
    expect(msg).toMatch(/transient/i);
    expect(msg).not.toMatch(/borg setup/);
  });

  it('returns null for non-auth errors', () => {
    expect(authRecoveryMessage({ message: 'Cube not found: foo' })).toBeNull();
    expect(authRecoveryMessage({ message: 'HTTP 500: boom' })).toBeNull();
    expect(authRecoveryMessage({})).toBeNull();
  });
});
