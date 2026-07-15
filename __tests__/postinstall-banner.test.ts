import { describe, it, expect } from 'vitest';
import { composeInstallBanner } from '../src/postinstall-banner';

describe('composeInstallBanner — gh#653 B1', () => {
  it('points at "borg setup" as the next step when an agent CLI is present', () => {
    const out = composeInstallBanner(true);
    expect(out).toContain('Next step:');
    expect(out).toContain('borg setup');
  });

  it('does NOT show the install-an-agent-CLI warning when one is present', () => {
    const out = composeInstallBanner(true);
    expect(out).not.toContain('No agent CLI detected');
    expect(out).not.toContain('claude.ai/download');
  });

  it('warns to install an agent CLI FIRST when none is detected', () => {
    const out = composeInstallBanner(false);
    expect(out).toContain('No agent CLI detected');
    expect(out).toContain('claude.ai/download');
    expect(out).toContain('developers.openai.com/codex');
  });

  it('still surfaces "borg setup" as the step after installing an agent CLI', () => {
    const out = composeInstallBanner(false);
    expect(out).toContain('borg setup');
    // the install-agent-CLI guidance must come BEFORE the borg setup step so
    // the user does the prerequisite first
    expect(out.indexOf('claude.ai/download')).toBeLessThan(out.indexOf('borg setup'));
  });

  it('renders the installed banner header in both modes', () => {
    expect(composeInstallBanner(true)).toContain('Borg MCP Installed');
    expect(composeInstallBanner(false)).toContain('Borg MCP Installed');
  });
});
