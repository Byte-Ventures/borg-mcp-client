import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDisplayIdentityForTests,
  confirmDisplayIdentity,
  markDisplayIdentityReadFailed,
  renderDisplayIdentity,
} from '../src/display-identity.js';
import type { ActiveCube } from '../src/cubes.js';

function active(overrides: Partial<ActiveCube> = {}): ActiveCube {
  return {
    cubeId: 'cube-a',
    droneId: 'drone-a',
    name: 'persisted-cube',
    droneLabel: 'persisted-label',
    roleName: 'Builder',
    sessionToken: 'token',
    apiUrl: 'https://127.0.0.1:7091',
    ...overrides,
  };
}

beforeEach(() => {
  _resetDisplayIdentityForTests();
});

describe('process-local display identity', () => {
  it('retains last-confirmed values and qualifies only fields not reconfirmed after failure', () => {
    const seat = active();
    confirmDisplayIdentity(seat, {
      cubeName: 'server-cube',
      droneLabel: 'server-label',
      roleName: 'Coordinator',
    });
    markDisplayIdentityReadFailed(seat);
    confirmDisplayIdentity(seat, { droneLabel: 'renamed-label' });

    expect(renderDisplayIdentity(seat)).toEqual({
      cubeName: 'server-cube (last confirmed)',
      droneLabel: 'renamed-label',
      roleName: 'Coordinator (last confirmed)',
    });
  });

  it('never falls back to older persisted metadata after server truth was confirmed', () => {
    const seat = active();
    confirmDisplayIdentity(seat, { droneLabel: 'server-label' });
    markDisplayIdentityReadFailed(seat);

    expect(renderDisplayIdentity(active({ droneLabel: 'older-on-disk-label' })).droneLabel)
      .toBe('server-label (last confirmed)');
  });

  it('resets on a different resolved seat so identity cannot bleed across #63 selection', () => {
    const first = active();
    confirmDisplayIdentity(first, { droneLabel: 'server-label-a' });

    const second = active({
      cubeId: 'cube-b',
      droneId: 'drone-b',
      name: 'selected-cube-b',
      droneLabel: 'selected-label-b',
      roleName: 'Reviewer',
    });
    expect(renderDisplayIdentity(second)).toEqual({
      cubeName: 'selected-cube-b',
      droneLabel: 'selected-label-b',
      roleName: 'Reviewer',
    });
  });
});
