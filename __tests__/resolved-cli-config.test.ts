import { describe, expect, it, vi } from 'vitest';
import { configureResolvedCli } from '../src/resolved-cli-config';

function deps() {
  return {
    ensureMcp: vi.fn(),
    addClaudeProjectSessionStartHook: vi.fn(),
    removeClaudeGlobalSessionStartHook: vi.fn(),
    addClaudeUserPromptSubmitHook: vi.fn(),
    addCodexSessionStartHook: vi.fn(),
    addCodexUserPromptSubmitHook: vi.fn(),
    installOpenCodePlugin: vi.fn(),
  };
}

describe('configureResolvedCli', () => {
  it('configures only Claude, including its project-local self-heal', () => {
    const d = deps();
    configureResolvedCli('claude', d);
    expect(d.ensureMcp).toHaveBeenCalledWith('claude');
    expect(d.addClaudeProjectSessionStartHook).toHaveBeenCalledOnce();
    expect(d.removeClaudeGlobalSessionStartHook).toHaveBeenCalledOnce();
    expect(d.addClaudeUserPromptSubmitHook).toHaveBeenCalledOnce();
    expect(d.addCodexSessionStartHook).not.toHaveBeenCalled();
    expect(d.installOpenCodePlugin).not.toHaveBeenCalled();
    expect(d.addCodexUserPromptSubmitHook).not.toHaveBeenCalled();
  });

  it('configures only Codex', () => {
    const d = deps();
    configureResolvedCli('codex', d);
    expect(d.ensureMcp).toHaveBeenCalledWith('codex');
    expect(d.addCodexSessionStartHook).toHaveBeenCalledOnce();
    expect(d.addCodexUserPromptSubmitHook).toHaveBeenCalledOnce();
    expect(d.addClaudeProjectSessionStartHook).not.toHaveBeenCalled();
    expect(d.removeClaudeGlobalSessionStartHook).not.toHaveBeenCalled();
    expect(d.installOpenCodePlugin).not.toHaveBeenCalled();
  });

  it('configures only OpenCode', () => {
    const d = deps();
    configureResolvedCli('opencode', d);
    expect(d.ensureMcp).toHaveBeenCalledWith('opencode');
    expect(d.installOpenCodePlugin).toHaveBeenCalledOnce();
    expect(d.addClaudeProjectSessionStartHook).not.toHaveBeenCalled();
    expect(d.addCodexSessionStartHook).not.toHaveBeenCalled();
  });
});
