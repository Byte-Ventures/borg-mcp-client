import { describe, expect, it } from 'vitest';
import {
  CLEAR_REWAKE_REMINDER,
  evaluateClearRewake,
} from '../src/clear-rewake-core.js';

const borgEnv = { BORG_SESSION: '1' } as NodeJS.ProcessEnv;

function payload(source: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ hook_event_name: 'SessionStart', source, ...extra });
}

describe('evaluateClearRewake', () => {
  it('forces exactly one static recovery turn for a Borg SessionStart clear', () => {
    expect(evaluateClearRewake(payload('clear'), borgEnv)).toEqual({
      exitCode: 2,
      stderr: `${CLEAR_REWAKE_REMINDER}\n`,
    });
    expect(CLEAR_REWAKE_REMINDER).toBe(
      'Post-/clear recovery: full regen, drain the unread log; handle actionable cube entries, otherwise resume the work from before this wake.'
    );
  });

  it.each(['startup', 'resume', 'compact'])('does not wake for source=%s', (source) => {
    expect(evaluateClearRewake(payload(source), borgEnv)).toEqual({ exitCode: 0, stderr: '' });
  });

  it('does not wake outside a Borg-launched session', () => {
    expect(evaluateClearRewake(payload('clear'), {})).toEqual({ exitCode: 0, stderr: '' });
  });

  it('requires a SessionStart clear payload and tolerates malformed input', () => {
    expect(evaluateClearRewake(JSON.stringify({ hook_event_name: 'Stop', source: 'clear' }), borgEnv))
      .toEqual({ exitCode: 0, stderr: '' });
    expect(evaluateClearRewake('{bad json', borgEnv)).toEqual({ exitCode: 0, stderr: '' });
    expect(evaluateClearRewake('', borgEnv)).toEqual({ exitCode: 0, stderr: '' });
  });

  it('never interpolates hook metadata, paths, cube content, or tokens into stderr', () => {
    const result = evaluateClearRewake(payload('clear', {
      session_id: 'secret-session',
      cwd: '/private/user/repository',
      cube: 'private-cube-content',
      token: 'secret-token',
    }), borgEnv);
    expect(result.stderr).toBe(`${CLEAR_REWAKE_REMINDER}\n`);
    expect(result.stderr).not.toMatch(/secret|private|token/i);
  });

  it('contains only recovery triage and continuation, with no re-arm or recurring loop', () => {
    const { stderr } = evaluateClearRewake(payload('clear'), borgEnv);
    expect(stderr).toMatch(/full regen.*drain the unread log/i);
    expect(stderr).toMatch(/handle actionable.*otherwise resume/i);
    expect(stderr).not.toMatch(/ScheduleWakeup|\/loop|timer|re-arm/i);
  });
});
