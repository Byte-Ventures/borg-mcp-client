import { describe, expect, it, vi } from 'vitest';
import {
  configuredCliNames,
  parseCliFlag,
  resolveCliChoice,
  type CliAvailability,
  type CliConfiguration,
} from '../src/cli-platform';

function deps(
  availability: CliAvailability,
  stored: 'claude' | 'codex' | 'opencode' | null = null,
  isTTY = true,
  configuration: Partial<CliConfiguration> = {},
) {
  return {
    detectCli: vi.fn(() => availability),
    detectConfigured: vi.fn(() => ({
      claude: configuration.claude ?? false,
      codex: configuration.codex ?? false,
      opencode: configuration.opencode ?? false,
    })),
    getPreference: vi.fn(async () => stored),
    setPreference: vi.fn(async () => {}),
    prompt: vi.fn(async () => '1'),
    isTTY: () => isTTY,
  };
}

describe('parseCliFlag', () => {
  it('strips --cli and returns passthrough args', () => {
    expect(parseCliFlag(['--cli', 'codex', '--resume', 'abc'])).toEqual({
      cli: 'codex',
      rest: ['--resume', 'abc'],
    });
  });

  it('rejects invalid values', () => {
    expect(parseCliFlag(['--cli=vim']).error).toContain('--cli requires');
  });

  it('consumes --force as the bare-seat relaunch override instead of forwarding it', () => {
    expect(parseCliFlag(['--force', '--resume', 'abc'])).toEqual({
      force: true,
      rest: ['--resume', 'abc'],
    });
  });

  it('consumes the launch approval opt-out instead of forwarding it', () => {
    expect(parseCliFlag(['--no-borg-approval-override', '--resume', 'abc'])).toEqual({
      noBorgApprovalOverride: true,
      rest: ['--resume', 'abc'],
    });
  });
});

describe('resolveCliChoice', () => {
  it('allows an explicit installed but unconfigured cli to remain on-demand', async () => {
    const d = deps({ claude: '/bin/claude', codex: '/bin/codex' });
    await expect(resolveCliChoice('codex', d)).resolves.toBe('codex');
    expect(d.setPreference).toHaveBeenCalledWith('codex');
  });

  it('uses stored project preference when configured', async () => {
    const d = deps({ claude: '/bin/claude', codex: '/bin/codex' }, 'codex', true, { codex: true });
    await expect(resolveCliChoice(undefined, d)).resolves.toBe('codex');
    expect(d.prompt).not.toHaveBeenCalled();
  });

  it('auto-selects the only configured cli', async () => {
    const d = deps({ claude: '/bin/claude', codex: '/bin/codex' }, null, true, { codex: true });
    await expect(resolveCliChoice(undefined, d)).resolves.toBe('codex');
    expect(d.setPreference).toHaveBeenCalledWith('codex');
  });

  it('ignores an installed but unconfigured stored preference', async () => {
    const d = deps(
      { claude: '/bin/claude', codex: '/bin/codex' },
      'codex',
      true,
      { claude: true },
    );
    await expect(resolveCliChoice(undefined, d)).resolves.toBe('claude');
  });

  it('prompts with configured CLIs only', async () => {
    const d = deps(
      { claude: '/bin/claude', codex: '/bin/codex', opencode: '/bin/opencode' },
      null,
      true,
      { codex: true, opencode: true },
    );
    await expect(resolveCliChoice(undefined, d)).resolves.toBe('codex');
    expect(d.prompt).toHaveBeenCalledWith(
      expect.stringContaining('  1) codex\n  2) opencode'),
    );
    expect(d.prompt.mock.calls[0][0]).not.toContain('claude');
  });

  it('directs the zero-configured state to borg setup', async () => {
    const d = deps({ claude: '/bin/claude', codex: '/bin/codex' });
    await expect(resolveCliChoice(undefined, d)).rejects.toThrow(
      'Run `borg setup` to configure one',
    );
  });

  it('uses instructional copy when multiple configured CLIs are present in non-tty mode', async () => {
    const d = deps(
      { claude: '/bin/claude', codex: '/bin/codex' },
      null,
      false,
      { claude: true, codex: true },
    );
    await expect(resolveCliChoice(undefined, d)).rejects.toThrow(
      'Multiple configured agent CLIs detected. Pass --cli claude, --cli codex, or --cli opencode to choose.',
    );
  });
});

describe('configuredCliNames', () => {
  it('returns only installed CLIs with Borg configured', () => {
    expect(configuredCliNames(
      { claude: '/bin/claude', codex: '/bin/codex', opencode: '/bin/opencode' },
      { claude: true, codex: false, opencode: true },
    )).toEqual(['claude', 'opencode']);
  });
});
