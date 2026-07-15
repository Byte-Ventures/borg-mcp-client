import { describe, expect, it } from 'vitest';
import {
  lifecycleSignalForMessage,
  nextLifecycleStateAfterLog,
  shouldSuppressLifecycleLogFromState,
} from '../src/lifecycle-log-guard';

const arrival = 'ARRIVAL: drone-1 (Builder) online on host at /repo';
const ready =
  'READY: drone-1 (Builder) — capacity clean, awaiting next dispatch from drone-1 (Coordinator)';

describe('lifecycle-log-guard', () => {
  it('detects ARRIVAL and idle READY lifecycle messages only', () => {
    expect(lifecycleSignalForMessage(arrival)).toBe('arrival');
    expect(lifecycleSignalForMessage(ready)).toBe('ready');
    expect(lifecycleSignalForMessage('READY: review complete')).toBeNull();
    expect(lifecycleSignalForMessage('DONE: shipped')).toBeNull();
  });

  it('suppresses repeated identical ARRIVAL inside the duplicate window', () => {
    const state = nextLifecycleStateAfterLog(
      arrival,
      undefined,
      '2026-05-29T16:00:00.000Z'
    );

    expect(
      shouldSuppressLifecycleLogFromState(
        arrival,
        state,
        new Date('2026-05-29T16:05:00.000Z').getTime()
      )
    ).toEqual({ suppress: true, signal: 'arrival' });
  });

  it('allows identical ARRIVAL after the duplicate window', () => {
    const state = nextLifecycleStateAfterLog(
      arrival,
      undefined,
      '2026-05-29T16:00:00.000Z'
    );

    expect(
      shouldSuppressLifecycleLogFromState(
        arrival,
        state,
        new Date('2026-05-29T16:11:00.000Z').getTime()
      )
    ).toEqual({ suppress: false, signal: 'arrival' });
  });

  it('keeps suppressing ARRIVAL when suppressed duplicates refresh the window', () => {
    const initialState = nextLifecycleStateAfterLog(
      arrival,
      undefined,
      '2026-05-29T16:00:00.000Z'
    );

    expect(
      shouldSuppressLifecycleLogFromState(
        arrival,
        initialState,
        new Date('2026-05-29T16:05:00.000Z').getTime()
      )
    ).toEqual({ suppress: true, signal: 'arrival' });

    const refreshedState = nextLifecycleStateAfterLog(
      arrival,
      initialState,
      '2026-05-29T16:05:00.000Z'
    );

    expect(
      shouldSuppressLifecycleLogFromState(
        arrival,
        refreshedState,
        new Date('2026-05-29T16:11:00.000Z').getTime()
      )
    ).toEqual({ suppress: true, signal: 'arrival' });
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
