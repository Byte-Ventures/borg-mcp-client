import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeLaunchPlan, launchOpenCodeProcess } from '../src/claude';
import {
  __getOpenCodeBindingPathForTests,
  __resetOpenCodeDroneForTests,
  allocateOpenCodePort,
  connectOpenCodeDrone,
  createOpenCodeLaunchKickoff,
  disconnectOpenCodeDrone,
  injectInitialKickoff,
  injectOpenCodeEntry,
  probeOpenCodeDroneArmed,
} from '../src/opencode-drone';
import { connectOpenCodeRuntime } from '../src/index';
import { OPENCODE_LAUNCH_CORRELATION_METADATA_KEY } from '../src/opencode-plugin';

describe('OpenCode production launch wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetOpenCodeDroneForTests();
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
    const observedKickoffs: Array<ReturnType<typeof createOpenCodeLaunchKickoff>> = [];
    const injectKickoff = vi.fn(async (attemptKickoff: ReturnType<typeof createOpenCodeLaunchKickoff>) => {
      observedKickoffs.push(attemptKickoff);
      const server = servers[injectKickoff.mock.calls.length - 1];
      if (!server.listening) await once(server, 'listening');
      return observedKickoffs.filter(
        ({ correlationIdentity }) => correlationIdentity === attemptKickoff.correlationIdentity,
      ).length === 1;
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
      expect(observedKickoffs).toHaveLength(2);
      expect(observedKickoffs[1].correlationIdentity).not.toBe(observedKickoffs[0].correlationIdentity);
      expect(observedKickoffs[1].apiPassword).not.toBe(observedKickoffs[0].apiPassword);
      for (const [index, attemptKickoff] of observedKickoffs.entries()) {
        const spawnEnv = spawnProcess.mock.calls[index][2].env;
        expect(spawnEnv.BORG_OPENCODE_LAUNCH_CORRELATION).toBe(attemptKickoff.correlationIdentity);
        expect(spawnEnv.OPENCODE_SERVER_PASSWORD).toBe(attemptKickoff.apiPassword);
        expect(connect.mock.calls[index][0].apiPassword).toBe(attemptKickoff.apiPassword);
        expect(connect.mock.calls[index][0].launchIdentity).toBe(attemptKickoff.correlationIdentity);
      }
      expect(launched.process).toBe(children[1]);
      expect(launched.launchEnv.BORG_OPENCODE_PORT).toBe(attemptedPorts[1]);
    } finally {
      blocker.close();
      for (const server of servers) if (server.listening) server.close();
    }
  });

  it('restores and delivers only through the surviving retry binding', async () => {
    const directory = '/repo/retry-binding';
    const sessions: Array<{ id: string; directory: string; time: { created: number } }> = [];
    const messages = new Map<string, unknown[]>();
    let promptCount = 0;
    const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && url.pathname === '/session') {
        response.end(JSON.stringify(sessions));
        return;
      }
      const detail = sessions.find((session) => url.pathname === `/session/${session.id}`);
      if (request.method === 'GET' && detail) {
        response.end(JSON.stringify(detail));
        return;
      }
      const messageSession = sessions.find(
        (session) => url.pathname === `/session/${session.id}/message`,
      );
      if (request.method === 'GET' && messageSession) {
        response.end(JSON.stringify(messages.get(messageSession.id) ?? []));
        return;
      }
      const promptSession = sessions.find(
        (session) => url.pathname === `/session/${session.id}/prompt_async`,
      );
      if (request.method === 'POST' && promptSession) {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { parts: unknown[] };
          promptCount++;
          messages.get(promptSession.id)!.push({
            info: { id: `msg_000000000000retry${promptCount}`, role: 'user' },
            parts: body.parts,
          });
          response.statusCode = 204;
          response.end();
        });
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    };
    const firstServer = createHttpServer(handler);
    const secondServer = createHttpServer(handler);
    firstServer.listen(0, '127.0.0.1');
    secondServer.listen(0, '127.0.0.1');
    await Promise.all([once(firstServer, 'listening'), once(secondServer, 'listening')]);
    const firstAddress = firstServer.address();
    const secondAddress = secondServer.address();
    if (!firstAddress || typeof firstAddress === 'string' || !secondAddress || typeof secondAddress === 'string') {
      throw new Error('test servers did not bind TCP');
    }
    const children: EventEmitter[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      children.push(child);
      return child as any;
    });
    const attempts: Array<ReturnType<typeof createOpenCodeLaunchKickoff>> = [];
    const bindingPaths: string[] = [];
    const kickoff = createOpenCodeLaunchKickoff('retry binding kickoff');

    try {
      const launched = await launchOpenCodeProcess({
        cwd: directory,
        port: firstAddress.port,
        prompt: kickoff.prompt,
        passthroughArgs: [],
        env: { BORG_SESSION: '1' },
        droneLabel: 'opencode',
        cubeName: 'borg',
        kickoff,
        spawnProcess,
        allocatePort: async () => secondAddress.port,
        injectKickoff: async (attemptKickoff) => {
          attempts.push(attemptKickoff);
          const index = attempts.length;
          const session = {
            id: `ses_000000000000attempt${index}`,
            directory,
            time: { created: index },
          };
          sessions.push(session);
          messages.set(session.id, [{
            info: { id: `msg_000000000000attempt${index}`, role: 'user' },
            parts: [{
              type: 'text',
              text: attemptKickoff.prompt,
              metadata: {
                [OPENCODE_LAUNCH_CORRELATION_METADATA_KEY]: attemptKickoff.correlationIdentity,
              },
            }],
          }]);
          await expect(injectInitialKickoff(attemptKickoff)).resolves.toBe(true);
          bindingPaths.push(__getOpenCodeBindingPathForTests());
          if (index === 1) {
            children[0].emit('exit', 1, null);
            return new Promise<boolean>(() => {});
          }
          return true;
        },
      });

      expect(launched.process).toBe(children[1]);
      expect(attempts).toHaveLength(2);
      expect(bindingPaths[1]).not.toBe(bindingPaths[0]);
      expect(bindingPaths.every((path) => existsSync(path))).toBe(true);
      expect(launched.launchEnv.BORG_OPENCODE_LAUNCH_CORRELATION).toBe(
        attempts[1].correlationIdentity,
      );

      disconnectOpenCodeDrone();
      await connectOpenCodeDrone({
        serverUrl: `http://127.0.0.1:${secondAddress.port}`,
        apiPassword: attempts[1].apiPassword,
        directory,
        droneLabel: 'builder-survivor',
        cubeName: 'cube-one',
        launchIdentity: attempts[1].correlationIdentity,
      });
      await expect(probeOpenCodeDroneArmed()).resolves.toBe(true);
      await expect(injectOpenCodeEntry('surviving retry wake', 'surviving-retry-entry')).resolves.toBe(true);
      expect(promptCount).toBe(1);
    } finally {
      firstServer.close();
      secondServer.close();
      await Promise.all([once(firstServer, 'close'), once(secondServer, 'close')]);
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
    })).rejects.toThrow('after 3 attempts (code=1, signal=none)');

    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(allocatePort).toHaveBeenCalledTimes(2);
  });

  it('preserves an OpenCode executable-not-found spawn failure', async () => {
    const spawnError = Object.assign(new Error('spawn opencode ENOENT'), {
      code: 'ENOENT',
      path: 'opencode',
    });
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', spawnError));
      return child as any;
    });
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
      allocatePort: vi.fn(),
    })).rejects.toBe(spawnError);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('index consumer connects to the propagated launch port', async () => {
    const connect = vi.fn(async () => {});

    await expect(connectOpenCodeRuntime(
      { name: 'borg', droneLabel: 'drone-1' },
      {
        BORG_OPENCODE_PORT: '15555',
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: Buffer.alloc(32, 0x41).toString('base64url'),
        BORG_OPENCODE_LAUNCH_CORRELATION: Buffer.alloc(32, 0x42).toString('base64url'),
      },
      { connect },
    )).resolves.toBe(true);

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'http://127.0.0.1:15555',
      launchIdentity: Buffer.alloc(32, 0x42).toString('base64url'),
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

  it('index consumer fails closed before connect when launch authentication is absent or unverifiable', async () => {
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
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: Buffer.alloc(32, 0x41).toString('base64url'),
        BORG_OPENCODE_LAUNCH_CORRELATION: 'not-256-bit',
      },
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
