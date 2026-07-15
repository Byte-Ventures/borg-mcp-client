import { describe, expect, it, vi } from 'vitest';
import { parseCliFlag, resolveCliChoice, type CliAvailability } from '../src/cli-platform';

function deps(
  availability: CliAvailability,
  stored: 'claude' | 'codex' | 'opencode' | null = null,
  isTTY = true,
) {
  return {
    detectCli: vi.fn(() => availability),
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
});

describe('resolveCliChoice', () => {
  it('uses explicit cli and persists it', async () => {
    const d = deps({ claude: '/bin/claude', codex: '/bin/codex' });
    await expect(resolveCliChoice('codex', d)).resolves.toBe('codex');
    expect(d.setPreference).toHaveBeenCalledWith('codex');
  });

  it('uses stored project preference when installed', async () => {
    const d = deps({ claude: '/bin/claude', codex: '/bin/codex' }, 'codex');
    await expect(resolveCliChoice(undefined, d)).resolves.toBe('codex');
    expect(d.prompt).not.toHaveBeenCalled();
  });

  it('auto-selects the only installed cli', async () => {
    const d = deps({ claude: null, codex: '/bin/codex' });
    await expect(resolveCliChoice(undefined, d)).resolves.toBe('codex');
    expect(d.setPreference).toHaveBeenCalledWith('codex');
  });

  it('uses instructional copy when both clis are installed in non-tty mode', async () => {
    const d = deps({ claude: '/bin/claude', codex: '/bin/codex' }, null, false);
    await expect(resolveCliChoice(undefined, d)).rejects.toThrow(
      'Multiple agent CLIs detected. Pass --cli claude, --cli codex, or --cli opencode to choose.',
    );
  });
});
