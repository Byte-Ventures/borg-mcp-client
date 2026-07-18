import { describe, it, expect } from 'vitest';
import { parseAssimilateArgs } from '../src/parse-assimilate-args';

describe('parseAssimilateArgs', () => {
  it('parses bare invocation (no role, no flags)', () => {
    const r = parseAssimilateArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role).toBeUndefined();
      expect(r.flags).toEqual({});
    }
  });

  it('parses positional role', () => {
    const r = parseAssimilateArgs(['builder']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe('builder');
  });

  it('parses all flag forms', () => {
    const r = parseAssimilateArgs([
      'code-reviewer',
      '--worktree', 'review-1',
      '--template', 'research',
      '--cube-name', 'my-cube',
      '--cli', 'codex',
      '--host', 'localhost:8787',
      '--enroll',
      '--here',
      '--yes',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role).toBe('code-reviewer');
      expect(r.flags).toEqual({
        worktree: 'review-1',
        template: 'research',
        cubeName: 'my-cube',
        cli: 'codex',
        server: 'localhost:8787',
        enroll: true,
        here: true,
        yes: true,
      });
    }
  });

  it('parses --no-template + -y shorthand', () => {
    const r = parseAssimilateArgs(['--no-template', '-y']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags).toEqual({ noTemplate: true, yes: true });
  });

  it('parses --cli=claude shorthand', () => {
    const r = parseAssimilateArgs(['--cli=claude']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags).toEqual({ cli: 'claude' });
  });

  it('rejects invalid --cli value', () => {
    const r = parseAssimilateArgs(['--cli', 'vim']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--cli requires');
  });

  it('parses --host=<host> shorthand', () => {
    const r = parseAssimilateArgs(['--host=https://server.example.com']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.server).toBe('https://server.example.com');
  });

  it('rejects --host without a value', () => {
    const r = parseAssimilateArgs(['--host', '--yes']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--host requires');

    const shortFlag = parseAssimilateArgs(['--host', '-y']);
    expect(shortFlag.ok).toBe(false);
    if (!shortFlag.ok) expect(shortFlag.error).toContain('--host requires');

    const emptyEquals = parseAssimilateArgs(['--host=']);
    expect(emptyEquals.ok).toBe(false);
    if (!emptyEquals.ok) expect(emptyEquals.error).toContain('--host requires');
  });

  it('requires --host when --enroll is present', () => {
    expect(parseAssimilateArgs(['--enroll'])).toEqual({
      ok: false,
      error: '--enroll requires --host <host>',
    });
  });

  it('parses --reset-local-seat into flags.resetLocalSeat (explicit non-TTY scoped-reset opt-in)', () => {
    const result = parseAssimilateArgs(['--host', 'localhost:7091', '--here', '--reset-local-seat']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flags.resetLocalSeat).toBe(true);
      expect(result.flags.here).toBe(true);
    }
  });

  it('rejects the unreleased --server spelling instead of retaining an alias', () => {
    for (const args of [
      ['--server', 'localhost:7091'],
      ['--server=https://server.example.com'],
    ]) {
      const result = parseAssimilateArgs(args);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('unknown flag');
        expect(result.error).toContain('--host');
      }
    }
  });

  it('flag order is independent of positional role', () => {
    const r = parseAssimilateArgs(['--yes', 'builder', '--worktree', 'wt']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role).toBe('builder');
      expect(r.flags).toEqual({ yes: true, worktree: 'wt' });
    }
  });

  it('rejects --worktree without value', () => {
    const r = parseAssimilateArgs(['--worktree']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--worktree requires');
  });

  it('rejects --template without value', () => {
    const r = parseAssimilateArgs(['--template']);
    expect(r.ok).toBe(false);
  });

  it('rejects --cube-name without value', () => {
    const r = parseAssimilateArgs(['--cube-name']);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown flag', () => {
    const r = parseAssimilateArgs(['--bogus']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown flag');
  });

  it('rejects duplicate positional', () => {
    const r = parseAssimilateArgs(['a', 'b']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('extra argument');
  });

  // CR-PF-F1 regression (drone-2 Phase F review 2026-05-18T05:04Z):
  // spec rev-2 mandates argparse-level rejection of both flags
  // together; orchestrator silently picked --template before this fix.
  it('rejects --template + --no-template combo', () => {
    const r = parseAssimilateArgs(['--template', 'software-dev', '--no-template']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mutually exclusive/);
  });

  it('rejects --no-template + --template combo (order independent)', () => {
    const r = parseAssimilateArgs(['--no-template', '--template', 'research']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mutually exclusive/);
  });

  // Task 27: --model flag parsing tests
  it('parses --model <descriptor>', () => {
    const r = parseAssimilateArgs(['builder', '--model', 'claude:claude-opus-4-8']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.flags.model).toBe('claude:claude-opus-4-8');
    }
  });

  it('parses --model=<descriptor> shorthand', () => {
    const r = parseAssimilateArgs(['--model=claude:claude-sonnet-4-6']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.flags.model).toBe('claude:claude-sonnet-4-6');
    }
  });

  it('rejects --model with missing argument', () => {
    const r = parseAssimilateArgs(['--model']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/requires a descriptor/);
  });

  it('rejects --model with invalid kind', () => {
    const r = parseAssimilateArgs(['--model', 'invalid:model']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid model descriptor/);
  });

  it('rejects --model with missing colon', () => {
    const r = parseAssimilateArgs(['--model', 'claudemodel']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid model descriptor/);
  });

  it('rejects provider configuration owned by the agent CLI', () => {
    const r = parseAssimilateArgs(['--model', 'ollama:qwen:v2:q4_K_M']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/configure local models in the agent CLI/);
  });

  it('unknown flag error includes --model in supported list', () => {
    const r = parseAssimilateArgs(['--bogus']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--model');
  });
});
