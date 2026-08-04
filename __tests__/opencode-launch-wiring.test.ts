import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeLaunchPlan } from '../src/claude';
import { connectOpenCodeRuntime } from '../src/index';

describe('OpenCode production launch wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normal claude launch uses one port for CLI args, child env, and consumer URL', () => {
    const plan = createOpenCodeLaunchPlan('/repo', 15555, 'kickoff');
    const portIndex = plan.launchArgs.indexOf('--port');

    expect(portIndex).toBeGreaterThanOrEqual(0);
    expect(plan.launchArgs[portIndex + 1]).toBe('15555');
    expect(plan.envPort).toBe('15555');
    expect(plan.serverUrl).toBe('http://127.0.0.1:15555');
  });

  it('index consumer connects to the propagated launch port', async () => {
    const connect = vi.fn(async () => {});

    await expect(connectOpenCodeRuntime(
      { name: 'borg', droneLabel: 'drone-1' },
      { BORG_OPENCODE_PORT: '15555' },
      { connect },
    )).resolves.toBe(true);

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'http://127.0.0.1:15555',
    }));
  });

  it('index consumer fails closed for absent or invalid launch ports', async () => {
    const connect = vi.fn(async () => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(connectOpenCodeRuntime(
      { name: 'borg', droneLabel: 'drone-1' },
      {},
      { connect },
    )).resolves.toBe(false);
    await expect(connectOpenCodeRuntime(
      { name: 'borg', droneLabel: 'drone-1' },
      { BORG_OPENCODE_PORT: '0' },
      { connect },
    )).resolves.toBe(false);

    expect(connect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toContain('Relaunch through borg');
  });
});
