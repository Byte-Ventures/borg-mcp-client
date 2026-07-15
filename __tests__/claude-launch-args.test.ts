import { describe, it, expect } from 'vitest';
import { buildClaudeLaunchArgs, BORG_MCP_ALLOWED_TOOLS } from '../src/claude-launch-args';

/**
 * gh#702 — borg-launched claude drones auto-allow ONLY the borg MCP tools.
 * Verified against Claude Code CLI: `--allowedTools` is VARIADIC (`<tools...>`,
 * space-separated, each rule a separate argv element), `mcp__borg__*` wildcard,
 * allowlist-ADD (Bash/file/web still prompt).
 */
describe('gh#702 buildClaudeLaunchArgs', () => {
  it('places the kickoff positional BEFORE the trailing variadic --allowedTools', () => {
    const args = buildClaudeLaunchArgs(['--model', 'x'], 'KICKOFF');
    expect(args).toEqual(['--model', 'x', 'KICKOFF', '--allowedTools', 'mcp__borg__*']);
    // --allowedTools and its value are separate argv elements (not joined)
    const i = args.indexOf('--allowedTools');
    expect(args[i + 1]).toBe('mcp__borg__*');
  });

  // CR blocker 0e5c697e — a shape-test alone missed that the VARIADIC
  // --allowedTools greedily eats every following non-flag arg. This models the
  // commander parse: the variadic consumes args AFTER the flag, so the kickoff
  // must NOT sit after it (else it launches with no prompt + a bogus tool).
  it('the kickoff is NOT swallowed by the variadic --allowedTools (parse-level)', () => {
    const args = buildClaudeLaunchArgs(['--model', 'x'], 'KICKOFF_PROMPT');
    const flagIdx = args.indexOf('--allowedTools');
    // what the variadic flag consumes = args after it, up to the next --flag / end
    const consumed: string[] = [];
    for (let j = flagIdx + 1; j < args.length && !args[j].startsWith('--'); j++) consumed.push(args[j]);
    expect(consumed).toEqual(['mcp__borg__*']); // variadic value = ONLY the borg pattern
    expect(consumed).not.toContain('KICKOFF_PROMPT'); // kickoff NOT eaten as a tool
    // the kickoff is a positional located BEFORE the variadic flag → parsed as the prompt
    expect(args.indexOf('KICKOFF_PROMPT')).toBeLessThan(flagIdx);
    expect(args.indexOf('KICKOFF_PROMPT')).toBeGreaterThanOrEqual(0);
  });

  it('the allowlist is mcp__borg__* ONLY — no Bash/file/web over-grant, no skip-permissions (SR)', () => {
    expect(BORG_MCP_ALLOWED_TOOLS).toBe('mcp__borg__*');
    const args = buildClaudeLaunchArgs([], 'k');
    const joined = args.join(' ');
    // none of the prompting tools are auto-allowed
    expect(joined).not.toMatch(/\bBash\b|\bRead\b|\bWrite\b|\bEdit\b|\bWebFetch\b|\bWebSearch\b/);
    // not a blanket bypass
    expect(joined).not.toContain('--dangerously-skip-permissions');
    expect(joined).not.toContain('--permission-mode');
    // exactly one allowedTools flag, and its single value is the borg wildcard
    const flags = args.filter((a) => a === '--allowedTools');
    expect(flags).toHaveLength(1);
    expect(args.indexOf('mcp__borg__*')).toBe(args.indexOf('--allowedTools') + 1);
  });

  it('preserves passthrough args incl. the empty case (kickoff before the flag)', () => {
    expect(buildClaudeLaunchArgs([], 'k')).toEqual(['k', '--allowedTools', 'mcp__borg__*']);
    expect(buildClaudeLaunchArgs(['--resume', 'abc'], 'k')).toEqual([
      '--resume', 'abc', 'k', '--allowedTools', 'mcp__borg__*',
    ]);
  });
});
