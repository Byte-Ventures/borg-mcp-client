import { describe, expect, it, vi } from 'vitest';
import { ensureCliMcpConfigured, type EnsureMcpConfigDeps } from '../src/ensure-mcp-config';

function makeDeps(configured: Partial<Record<'claude' | 'codex' | 'opencode', boolean>> = {}): EnsureMcpConfigDeps {
  return {
    isClaudeConfigured: vi.fn(() => configured.claude ?? false),
    addClaude: vi.fn(),
    isCodexConfigured: vi.fn(() => configured.codex ?? false),
    addCodex: vi.fn(),
    isOpenCodeConfigured: vi.fn(() => configured.opencode ?? false),
    addOpenCode: vi.fn(),
  };
}

describe('ensureCliMcpConfigured', () => {
  it.each([
    ['claude', 'isClaudeConfigured', 'addClaude'],
    ['codex', 'isCodexConfigured', 'addCodex'],
    ['opencode', 'isOpenCodeConfigured', 'addOpenCode'],
  ] as const)('adds borg only for an unconfigured %s CLI', (cli, checkName, addName) => {
    const deps = makeDeps();

    expect(ensureCliMcpConfigured(cli, deps)).toBe(true);
    expect(deps[checkName]).toHaveBeenCalledOnce();
    expect(deps[addName]).toHaveBeenCalledOnce();
  });

  it.each(['claude', 'codex', 'opencode'] as const)('does not rewrite an existing %s MCP registration', (cli) => {
    const deps = makeDeps({ [cli]: true });

    expect(ensureCliMcpConfigured(cli, deps)).toBe(false);
    expect(deps.addClaude).not.toHaveBeenCalled();
    expect(deps.addCodex).not.toHaveBeenCalled();
    expect(deps.addOpenCode).not.toHaveBeenCalled();
  });

  it('preserves an adder failure for the launch caller to report', () => {
    const addOpenCode = vi.fn(() => {
      throw new Error('opencode CLI not found');
    });
    const deps = { ...makeDeps(), addOpenCode };

    expect(() => ensureCliMcpConfigured('opencode', deps)).toThrow('opencode CLI not found');
  });
});
