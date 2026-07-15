/**
 * gh#818 P3 — `borg setup` config-mutation disclose+confirm.
 *
 * Pins the six CR-binding build-gate items (3b3e85a5) on the pure,
 * dep-injected seam, so the headless no-regress + abort-before-write
 * semantics are unit-locked without spawning the wizard or a real prompt.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  confirmConfigMutation,
  configMutationTargets,
  formatConfigMutationDisclosure,
  parseYesFlag,
  setupMutationPending,
} from '../src/setup-confirm.js';

describe('confirmConfigMutation — the six binding items', () => {
  it('item 1 (load-bearing): non-TTY → proceed WITHOUT calling confirm (no stdin read → no headless hang)', async () => {
    const confirm = vi.fn(async () => false); // would abort IF called
    const decision = await confirmConfigMutation({ isTTY: false, yes: false, confirm });
    expect(decision).toBe('proceed');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('item 2: --yes bypass → proceed WITHOUT calling confirm (even in a TTY)', async () => {
    const confirm = vi.fn(async () => false);
    const decision = await confirmConfigMutation({ isTTY: true, yes: true, confirm });
    expect(decision).toBe('proceed');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('item 3: TTY + interactive decline → abort (caller exits before any write)', async () => {
    const confirm = vi.fn(async () => false);
    const decision = await confirmConfigMutation({ isTTY: true, yes: false, confirm });
    expect(decision).toBe('abort');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('TTY + interactive accept → proceed', async () => {
    const confirm = vi.fn(async () => true);
    const decision = await confirmConfigMutation({ isTTY: true, yes: false, confirm });
    expect(decision).toBe('proceed');
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('parseYesFlag — item 2 flag set (no collision with --no-browser/--device)', () => {
  it('recognizes --yes and -y', () => {
    expect(parseYesFlag(['--yes'])).toBe(true);
    expect(parseYesFlag(['-y'])).toBe(true);
    expect(parseYesFlag(['setup', '--yes'])).toBe(true);
  });

  it('is false for unrelated / existing flags (no --no-browser/--device collision)', () => {
    expect(parseYesFlag([])).toBe(false);
    expect(parseYesFlag(['--no-browser'])).toBe(false);
    expect(parseYesFlag(['--device'])).toBe(false);
    expect(parseYesFlag(['--y'])).toBe(false);
    expect(parseYesFlag(['yes'])).toBe(false);
  });
});

describe('configMutationTargets — scoped to detected CLIs', () => {
  it('claude-only lists the two Claude config files', () => {
    const t = configMutationTargets({ claude: true, codex: false });
    const files = t.map((x) => x.file);
    expect(files).toEqual(['~/.claude.json', '~/.claude/settings.json']);
  });

  it('codex-only lists the two Codex config files', () => {
    const t = configMutationTargets({ claude: false, codex: true });
    const files = t.map((x) => x.file);
    expect(files).toEqual(['~/.codex/config.toml', '~/.codex/hooks.json']);
  });

  it('both lists all four', () => {
    const t = configMutationTargets({ claude: true, codex: true });
    expect(t.map((x) => x.file)).toEqual([
      '~/.claude.json',
      '~/.claude/settings.json',
      '~/.codex/config.toml',
      '~/.codex/hooks.json',
    ]);
  });
});

describe('formatConfigMutationDisclosure — SR: paths only, no secret, undo note', () => {
  it('lists each target file + change and an undo note', () => {
    const text = formatConfigMutationDisclosure(
      configMutationTargets({ claude: true, codex: true })
    );
    expect(text).toContain('~/.claude.json');
    expect(text).toContain('~/.claude/settings.json');
    expect(text).toContain('~/.codex/config.toml');
    expect(text).toContain('~/.codex/hooks.json');
    expect(text).toContain('register the borg MCP server');
    expect(text).toContain('reversible');
  });

  it('contains no token/secret-shaped content (SR-light: discloses paths only)', () => {
    const text = formatConfigMutationDisclosure(
      configMutationTargets({ claude: true, codex: true })
    );
    // No credential fields, no bearer/oauth/key/token wording in the copy.
    expect(text).not.toMatch(/token|secret|bearer|password|api[_-]?key|refresh/i);
  });
});

describe('setupMutationPending — gh#844 pure-refresh skip (scoped to detected CLIs)', () => {
  // Convenience: fully-configured both CLIs, nothing pending.
  const allConfigured = {
    claude: true,
    codex: true,
    opencode: false,
    claudeMcpConfigured: true,
    codexMcpConfigured: true,
    opencodeMcpConfigured: false,
    claudeHookPending: false,
    codexHookPending: false,
  };

  it('both CLIs fully configured (MCP + hooks) → no mutation pending (pure refresh, skip prompt)', () => {
    expect(setupMutationPending(allConfigured)).toBe(false);
  });

  it('claude detected but its MCP server not yet registered → pending', () => {
    expect(setupMutationPending({ ...allConfigured, claudeMcpConfigured: false })).toBe(true);
  });

  it('codex detected but its MCP server not yet registered → pending', () => {
    expect(setupMutationPending({ ...allConfigured, codexMcpConfigured: false })).toBe(true);
  });

  it('MCP registered but a claude HOOK write is pending → pending (SR finding 8d9c732e gap)', () => {
    // The exact gap the SR caught: MCP already configured, but a hook write
    // (e.g. legacy SessionStart removal on a pre-gh#673 upgrade) is pending.
    // An MCP-only gate would skip consent and mutate settings.json silently.
    expect(setupMutationPending({ ...allConfigured, claudeHookPending: true })).toBe(true);
  });

  it('MCP registered but a codex HOOK write is pending → pending', () => {
    expect(setupMutationPending({ ...allConfigured, codexHookPending: true })).toBe(true);
  });

  it('claude-only user fully configured is NOT gated on absent codex config', () => {
    // The literal `!isMcpServerConfigured() || !isCodexMcpServerConfigured()`
    // gate would fire here (codex config absent → isCodexMcpServerConfigured
    // false), re-prompting an already-configured claude-only user every run.
    expect(
      setupMutationPending({
        claude: true,
        codex: false,
        opencode: false,
        claudeMcpConfigured: true,
        codexMcpConfigured: false,
        opencodeMcpConfigured: false,
        claudeHookPending: false,
        codexHookPending: false,
      }),
    ).toBe(false);
  });

  it('claude-only user fully configured is NOT gated on a pending codex hook it does not have', () => {
    // codexHookPending=true must be ignored when codex isn't detected.
    expect(
      setupMutationPending({
        claude: true,
        codex: false,
        opencode: false,
        claudeMcpConfigured: true,
        codexMcpConfigured: false,
        opencodeMcpConfigured: false,
        claudeHookPending: false,
        codexHookPending: true,
      }),
    ).toBe(false);
  });

  it('codex-only user fully configured is NOT gated on absent claude config', () => {
    expect(
      setupMutationPending({
        claude: false,
        codex: true,
        opencode: false,
        claudeMcpConfigured: false,
        codexMcpConfigured: true,
        opencodeMcpConfigured: false,
        claudeHookPending: true, // ignored — claude not detected
        codexHookPending: false,
      }),
    ).toBe(false);
  });

  it('claude-only user not yet configured → pending', () => {
    expect(
      setupMutationPending({
        claude: true,
        codex: false,
        opencode: false,
        claudeMcpConfigured: false,
        codexMcpConfigured: false,
        opencodeMcpConfigured: false,
        claudeHookPending: true,
        codexHookPending: false,
      }),
    ).toBe(true);
  });

  it('no agent CLI detected → nothing to mutate, not pending', () => {
    expect(
      setupMutationPending({
        claude: false,
        codex: false,
        opencode: false,
        claudeMcpConfigured: false,
        codexMcpConfigured: false,
        opencodeMcpConfigured: false,
        claudeHookPending: false,
        codexHookPending: false,
      }),
    ).toBe(false);
  });
});
