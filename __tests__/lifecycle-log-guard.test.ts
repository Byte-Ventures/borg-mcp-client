import { describe, expect, it } from 'vitest';
import {
  lifecycleSignalForMessage,
  nextLifecycleStateAfterLog,
  shouldSuppressLifecycleLogFromState,
} from '../src/lifecycle-log-guard';

const arrival = 'ARRIVAL: drone-1 (Builder) online on host';
const ready =
  'READY: drone-1 (Builder) — capacity clean, awaiting next dispatch from drone-1 (Coordinator)';

describe('lifecycle-log-guard', () => {
  it('detects ARRIVAL and idle READY lifecycle messages only', () => {
    expect(lifecycleSignalForMessage(arrival)).toBe('arrival');
    expect(lifecycleSignalForMessage(ready)).toBe('ready');
    expect(lifecycleSignalForMessage('READY: review complete')).toBeNull();
    expect(lifecycleSignalForMessage('DONE: shipped')).toBeNull();
  });

  const identity = { kind: 'known' as const, id: 'claude:session-a', source: 'claude-session-start', observedAt: new Date(0).toISOString() };

  it('suppresses an announced session regardless of message wording or elapsed time', () => {
    const state = nextLifecycleStateAfterLog(arrival, undefined, new Date(0).toISOString(), identity);
    expect(shouldSuppressLifecycleLogFromState('ARRIVAL: changed wording', state, identity))
      .toEqual({ suppress: true, signal: 'arrival' });
    expect(shouldSuppressLifecycleLogFromState(arrival, state, { ...identity, id: 'claude:session-b' }))
      .toEqual({ suppress: false, signal: 'arrival' });
  });

  it('announces unknown without forgetting previously announced sessions', () => {
    const state = nextLifecycleStateAfterLog(arrival, undefined, undefined, identity);
    const unknown = { kind: 'unknown' as const, reason: 'missing-hook' };
    expect(shouldSuppressLifecycleLogFromState(arrival, state, unknown).suppress).toBe(false);
    const next = nextLifecycleStateAfterLog(arrival, state, undefined, unknown);
    expect(shouldSuppressLifecycleLogFromState(arrival, next, identity).suppress).toBe(true);
  });

  it('remembers an earlier session after another session has announced', () => {
    const first = nextLifecycleStateAfterLog(arrival, undefined, undefined, identity);
    const second = nextLifecycleStateAfterLog(arrival, first, undefined, { ...identity, id: 'claude:session-b' });
    expect(shouldSuppressLifecycleLogFromState(arrival, second, identity).suppress).toBe(true);
  });

  it('suppresses repeated READY while the idle period is still open', () => {
    const state = nextLifecycleStateAfterLog(
      ready,
      undefined,
      '2026-05-29T16:00:00.000Z'
    );

    expect(shouldSuppressLifecycleLogFromState(ready, state)).toEqual({
      suppress: true,
      signal: 'ready',
    });
  });

  it('allows READY after other activity closes the previous idle period', () => {
    const idleState = nextLifecycleStateAfterLog(
      ready,
      undefined,
      '2026-05-29T16:00:00.000Z'
    );
    const activeState = nextLifecycleStateAfterLog(
      'STARTING: real work',
      idleState,
      '2026-05-29T16:01:00.000Z'
    );

    expect(shouldSuppressLifecycleLogFromState(ready, activeState)).toEqual({
      suppress: false,
      signal: 'ready',
    });
  });

  it('does not suppress ordinary log messages', () => {
    expect(shouldSuppressLifecycleLogFromState('STARTING: real work', undefined)).toEqual({
      suppress: false,
      signal: null,
    });
  });
});
