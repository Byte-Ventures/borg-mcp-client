import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeLaunchPlan, launchOpenCodeProcess } from '../src/claude';
import { allocateOpenCodePort, createOpenCodeLaunchKickoff } from '../src/opencode-drone';
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

  it('normal launch seam observes the same port at spawn and connect', async () => {
    const spawnProcess = vi.fn(() => new EventEmitter() as any);
    const connect = vi.fn(async () => {});
    const kickoff = createOpenCodeLaunchKickoff('kickoff');

    await launchOpenCodeProcess({
      cwd: '/repo',
      port: 15555,
      prompt: kickoff.prompt,
      passthroughArgs: [],
      env: { BORG_SESSION: '1' },
      droneLabel: 'drone-1',
      cubeName: 'borg',
      kickoff,
      spawnProcess,
      connect,
      injectKickoff: async () => true,
    });

    const [, args, spawnOptions] = spawnProcess.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    const portIndex = args.indexOf('--port');
    expect(args[portIndex + 1]).toBe('15555');
    expect(spawnOptions.env.BORG_OPENCODE_PORT).toBe('15555');
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'http://127.0.0.1:15555' }));
  });

  it('keeps independent API and correlation secrets out of argv and prompt text', async () => {
    const apiPassword = Buffer.alloc(32, 0x41).toString('base64url');
    const correlationIdentity = Buffer.alloc(32, 0x42).toString('base64url');
    const spawnProcess = vi.fn(() => new EventEmitter() as any);
    const connect = vi.fn(async () => {});
    const kickoff = createOpenCodeLaunchKickoff('operator kickoff', {
      apiPassword,
      correlationIdentity,
    });

    const launched = await launchOpenCodeProcess({
      cwd: '/repo',
      port: 15555,
      prompt: kickoff.prompt,
      passthroughArgs: [],
      env: { BORG_SESSION: '1' },
      droneLabel: 'drone-1',
      cubeName: 'borg',
      kickoff,
      spawnProcess,
      connect,
      injectKickoff: async () => true,
    });

    expect(kickoff.prompt).toBe('operator kickoff');
    expect(launched.launchArgs.join('\0')).not.toContain(apiPassword);
    expect(launched.launchArgs.join('\0')).not.toContain(correlationIdentity);
    expect(launched.launchEnv).toMatchObject({
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: apiPassword,
      BORG_OPENCODE_LAUNCH_CORRELATION: correlationIdentity,
    });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ apiPassword }));
  });

  it('rebinds child and consumer identity when the probed port is taken before bind', async () => {
    const initialPort = await allocateOpenCodePort();
    const blocker = createServer();
    blocker.listen(initialPort, '127.0.0.1');
    await once(blocker, 'listening');
    const children: EventEmitter[] = [];
    const servers: ReturnType<typeof createServer>[] = [];
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const child = new EventEmitter();
      const server = createServer();
      const port = Number(args[args.indexOf('--port') + 1]);
      server.once('error', () => child.emit('exit', 1));
      server.listen(port, '127.0.0.1');
      children.push(child);
      servers.push(server);
      return child as any;
    });
    const connect = vi.fn(async () => {});
    const injectKickoff = vi.fn(async () => {
      const server = servers[injectKickoff.mock.calls.length - 1];
      if (!server.listening) await once(server, 'listening');
      return true;
    });
    const allocatePort = vi.fn(() => allocateOpenCodePort());
    const kickoff = createOpenCodeLaunchKickoff('kickoff');

    try {
      const launched = await launchOpenCodeProcess({
        cwd: '/repo',
        port: initialPort,
        prompt: kickoff.prompt,
        passthroughArgs: [],
        env: { BORG_SESSION: '1' },
        droneLabel: 'drone-1',
        cubeName: 'borg',
        kickoff,
        spawnProcess: spawnProcess as any,
        connect,
        injectKickoff,
        allocatePort,
      });

      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(allocatePort).toHaveBeenCalledTimes(1);
      const attemptedPorts = spawnProcess.mock.calls.map(([, args, spawnOptions]) => {
        const port = args[args.indexOf('--port') + 1];
        expect(spawnOptions.env.BORG_OPENCODE_PORT).toBe(port);
        return port;
      });
      expect(attemptedPorts[0]).toBe(String(initialPort));
      expect(attemptedPorts[1]).not.toBe(attemptedPorts[0]);
      expect(connect.mock.calls.map(([input]) => input.serverUrl)).toEqual(
        attemptedPorts.map((port) => `http://127.0.0.1:${port}`),
      );
      expect(launched.process).toBe(children[1]);
      expect(launched.launchEnv.BORG_OPENCODE_PORT).toBe(attemptedPorts[1]);
    } finally {
      blocker.close();
      for (const server of servers) if (server.listening) server.close();
    }
  });

  it('bounds retries when every child exits before readiness', async () => {
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 1));
      return child as any;
    });
    const allocatePort = vi.fn(async () => 16000 + allocatePort.mock.calls.length);
    const kickoff = createOpenCodeLaunchKickoff('kickoff');

    await expect(launchOpenCodeProcess({
      cwd: '/repo',
      port: 15555,
      prompt: kickoff.prompt,
      passthroughArgs: [],
      env: { BORG_SESSION: '1' },
      droneLabel: 'drone-1',
      cubeName: 'borg',
      kickoff,
      spawnProcess,
      connect: async () => {},
      injectKickoff: () => new Promise<boolean>(() => {}),
      allocatePort,
    })).rejects.toThrow('after 3 attempts');

    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(allocatePort).toHaveBeenCalledTimes(2);
  });

  it('index consumer connects to the propagated launch port', async () => {
    const connect = vi.fn(async () => {});

    await expect(connectOpenCodeRuntime(
      { name: 'borg', droneLabel: 'drone-1' },
      {
        BORG_OPENCODE_PORT: '15555',
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: Buffer.alloc(32, 0x41).toString('base64url'),
      },
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

  it('index consumer fails closed before connect when API authentication is absent or unverifiable', async () => {
    const connect = vi.fn(async () => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(connectOpenCodeRuntime(
      { name: 'borg', droneLabel: 'drone-1' },
      { BORG_OPENCODE_PORT: '15555' },
      { connect },
    )).resolves.toBe(false);
    await expect(connectOpenCodeRuntime(
      { name: 'borg', droneLabel: 'drone-1' },
      {
        BORG_OPENCODE_PORT: '15555',
        OPENCODE_SERVER_USERNAME: 'other',
        OPENCODE_SERVER_PASSWORD: 'not-256-bit',
      },
      { connect },
    )).resolves.toBe(false);

    expect(connect).not.toHaveBeenCalled();
  });
});
