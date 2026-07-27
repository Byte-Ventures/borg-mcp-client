import { describe, expect, it, vi } from 'vitest';
import {
  parseUpdateArgs,
  runEarlyUpdate,
  runUpdate,
  type PublishedPackage,
  type UpdateDeps,
} from '../src/update-cmd.js';

const CLIENT_TARGET: PublishedPackage = {
  name: 'borgmcp',
  version: '2.3.0',
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  sharedVersion: '0.6.5',
};

const SERVER_TARGET: PublishedPackage = {
  name: 'borgmcp-server',
  version: '0.4.0',
  integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
  sharedVersion: '0.6.5',
};

const runningStatus = {
  status: 'running',
  installed_controller: 'borgmcp-server@0.4.0',
  prepared_runtime: 'borgmcp-server@0.4.0',
  prepared_integrity: SERVER_TARGET.integrity,
  running_runtime: 'borgmcp-server@0.4.0',
  running_integrity: SERVER_TARGET.integrity,
  build_identity: 'a'.repeat(40),
  endpoint: 'https://127.0.0.1:7091',
  mode: 'managed',
  service_adapter: 'launchd',
  data_identity: 'available',
  next_action: null,
};

const updatedResult = {
  status: 'updated',
  installed_controller: 'borgmcp-server@0.4.0',
  artifact: 'borgmcp-server@0.4.0',
  artifact_integrity: SERVER_TARGET.integrity,
  running_runtime: 'borgmcp-server@0.4.0',
  build_identity: 'a'.repeat(40),
  mode: 'managed',
  data_identity: 'preserved',
  next_action: null,
};

function deps(overrides: Partial<UpdateDeps> = {}): UpdateDeps {
  const calls: string[] = [];
  let clientVersion = '2.2.0';
  let clientShared = '0.6.4';
  let serverVersion = '0.3.0';
  let serverShared = '0.6.4';
  return {
    currentClient: vi.fn(async () => ({
      name: 'borgmcp',
      version: clientVersion,
      sharedVersion: clientShared,
      packageRoot: '/npm/lib/node_modules/borgmcp',
      binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
    })),
    currentServer: vi.fn(async () => ({
      name: 'borgmcp-server',
      version: serverVersion,
      sharedVersion: serverShared,
      packageRoot: '/npm/lib/node_modules/borgmcp-server',
      binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
    })),
    publishedPackage: vi.fn(async (name) =>
      name === 'borgmcp' ? CLIENT_TARGET : SERVER_TARGET),
    installGlobal: vi.fn(async (name) => {
      calls.push(`install:${name}`);
      if (name === 'borgmcp') {
        clientVersion = CLIENT_TARGET.version;
        clientShared = CLIENT_TARGET.sharedVersion;
      } else {
        serverVersion = SERVER_TARGET.version;
        serverShared = SERVER_TARGET.sharedVersion;
      }
    }),
    reenter: vi.fn(async () => { calls.push('reenter'); return 0; }),
    serverJson: vi.fn(async (_bin, command) => {
      calls.push(`server:${command}`);
      return command === 'update'
        ? updatedResult
        : runningStatus;
    }),
    verifyRunningProtocol: vi.fn(async () => { calls.push('protocol'); }),
    confirm: vi.fn(async () => 'yes'),
    isTTY: () => true,
    stdout: vi.fn(),
    stderr: vi.fn(),
    calls,
    ...overrides,
  };
}

describe('parseUpdateArgs', () => {
  it('accepts only help and explicit confirmation for public invocations', () => {
    expect(parseUpdateArgs([])).toEqual({ ok: true, yes: false });
    expect(parseUpdateArgs(['--yes'])).toEqual({ ok: true, yes: true });
    expect(parseUpdateArgs(['-y'])).toEqual({ ok: true, yes: true });
    expect(parseUpdateArgs(['--help'])).toEqual({ ok: true, help: true, yes: false });
    expect(parseUpdateArgs(['--target-client', '2.3.0', '--target-server', '0.4.0']))
      .toEqual({ ok: false, error: 'internal update continuation is unavailable' });
    expect(parseUpdateArgs(['--force'])).toEqual({ ok: false, error: 'unknown option: --force' });
  });

  it('accepts a complete exact target only for a verified re-entry', () => {
    expect(parseUpdateArgs(
      [
        '--yes',
        '--target-client', '2.3.0',
        '--target-server', '0.4.0',
        '--server-present', 'yes',
      ],
      true,
    )).toEqual({
      ok: true,
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0', serverPresent: true },
    });
  });

  it('rejects a boxed string that RegExp.test would coerce to an exact semver', () => {
    const boxedVersion = new String('2.3.0') as unknown as string;

    expect(parseUpdateArgs(
      [
        '--target-client', boxedVersion,
        '--target-server', '0.4.0',
        '--server-present', 'yes',
      ],
      true,
    )).toEqual({
      ok: false,
      error: 'internal update continuation requires exact versions',
    });
  });
});

describe('runUpdate', () => {
  it('refuses mismatched published shared pins before confirmation or mutation', async () => {
    const d = deps({
      publishedPackage: vi.fn(async (name) => name === 'borgmcp'
        ? CLIENT_TARGET
        : { ...SERVER_TARGET, sharedVersion: '0.6.6' }),
    });

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(1);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.installGlobal).not.toHaveBeenCalled();
    expect(d.reenter).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledWith(expect.stringMatching(/0\.6\.5.*0\.6\.6/s));
  });

  it('shows installed and target package identities plus integrity before mutation', async () => {
    const d = deps({ confirm: vi.fn(async () => 'no') });

    await expect(runUpdate({ yes: false }, d)).resolves.toBe(0);
    expect(d.stdout).toHaveBeenCalledWith(expect.stringMatching(
      /borgmcp@2\.2\.0 -> borgmcp@2\.3\.0[\s\S]*target integrity: sha512-[A-Za-z0-9+/=]+[\s\S]*borgmcp-server@0\.3\.0 -> borgmcp-server@0\.4\.0/,
    ));
    expect(d.installGlobal).not.toHaveBeenCalled();
  });

  it.each([
    ['range', '^0.6.5'],
    ['tag', 'latest'],
    ['missing', ''],
  ])('refuses a %s shared dependency before mutation', async (_name, sharedVersion) => {
    const d = deps({
      publishedPackage: vi.fn(async (name) => name === 'borgmcp'
        ? { ...CLIENT_TARGET, sharedVersion }
        : SERVER_TARGET),
    });

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(1);
    expect(d.installGlobal).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it('refuses malformed registry integrity before mutation', async () => {
    const d = deps({
      publishedPackage: vi.fn(async (name) => name === 'borgmcp'
        ? { ...CLIENT_TARGET, integrity: 'sha512-not-canonical' }
        : SERVER_TARGET),
    });

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(1);
    expect(d.installGlobal).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it('requires --yes outside a TTY without reading confirmation or mutating', async () => {
    const d = deps({ isTTY: () => false });

    await expect(runUpdate({ yes: false }, d)).resolves.toBe(1);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.installGlobal).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it.each([
    ['no', 0],
    ['eof', 1],
    ['interrupted', 130],
  ] as const)('handles interactive %s before every mutation', async (decision, exitCode) => {
    const d = deps({ confirm: vi.fn(async () => decision) });

    await expect(runUpdate({ yes: false }, d)).resolves.toBe(exitCode);
    expect(d.installGlobal).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it('installs the client and re-enters verified new code without any server mutation', async () => {
    const d = deps();

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(0);

    expect(d.calls).toEqual(['install:borgmcp', 'reenter']);
    expect(d.reenter).toHaveBeenCalledWith(
      '/npm/lib/node_modules/borgmcp/dist/claude.js',
      [
        'update', '--yes',
        '--target-client', '2.3.0',
        '--target-server', '0.4.0',
        '--server-present', 'yes',
      ],
    );
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it('suppresses every server mutation when the client install fails', async () => {
    const d = deps({ installGlobal: vi.fn(async () => { throw new Error('install failed'); }) });

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(1);
    expect(d.reenter).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it('suppresses every server mutation when new-client verification prevents re-entry', async () => {
    const currentClient = vi.fn()
      .mockResolvedValueOnce({
        name: 'borgmcp', version: '2.2.0', sharedVersion: '0.6.4',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })
      .mockRejectedValueOnce(new Error('new client bin escaped npm package root'));
    const d = deps({ currentClient });

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(1);
    expect(d.reenter).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it('suppresses every server mutation when the verified new client cannot be started', async () => {
    const d = deps({ reenter: vi.fn(async () => { throw new Error('spawn failed'); }) });

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(1);
    expect(d.installGlobal).toHaveBeenCalledWith('borgmcp', '2.3.0');
    expect(d.reenter).toHaveBeenCalledOnce();
    expect(d.serverJson).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledOnce();
    expect(d.stderr).toHaveBeenCalledWith(
      `Client update or re-entry failed: spawn failed.\n` +
      `Observed update state:\n` +
      `  client: borgmcp@2.3.0 installed and verified\n` +
      `  server controller before client update: borgmcp-server@0.3.0\n` +
      `  prepared runtime: not inspected\n` +
      `  running runtime: not inspected\n` +
      `Server mutation was not attempted.\n` +
      `Retry with: borg update --yes\n`,
    );
  });

  it('installs the controller before runtime update and verifies the running pair', async () => {
    let statusCalls = 0;
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn()
        .mockResolvedValueOnce({
          name: 'borgmcp-server', version: '0.3.0', sharedVersion: '0.6.4',
          packageRoot: '/npm/lib/node_modules/borgmcp-server',
          binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
        })
        .mockResolvedValue({
          name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
          packageRoot: '/npm/lib/node_modules/borgmcp-server',
          binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
        }),
      serverJson: vi.fn(async (_bin, command) => {
        d.calls?.push(`server:${command}`);
        if (command === 'update') return updatedResult;
        statusCalls += 1;
        return statusCalls === 1
          ? {
            ...runningStatus,
            prepared_runtime: 'borgmcp-server@0.3.0',
            prepared_integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
            running_runtime: 'borgmcp-server@0.3.0',
            running_integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
            next_action: 'borg-mcp-server update',
          }
          : runningStatus;
      }),
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(0);

    expect(d.calls).toEqual([
      'install:borgmcp-server',
      'server:status',
      'server:update',
      'server:status',
      'protocol',
    ]);
    expect(d.verifyRunningProtocol).toHaveBeenCalledWith('https://127.0.0.1:7091');
  });

  it('accepts a stopped server only when controller and prepared runtime match target', async () => {
    const stoppedStatus = {
      status: 'stopped',
      installed_controller: 'borgmcp-server@0.4.0',
      prepared_runtime: 'borgmcp-server@0.4.0',
      prepared_integrity: SERVER_TARGET.integrity,
      running_runtime: null,
      running_integrity: null,
      build_identity: null,
      endpoint: null,
      mode: 'stopped',
      service_adapter: null,
      data_identity: 'available',
      next_action: null,
    };
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => ({
        name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp-server',
        binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
      })),
      serverJson: vi.fn(async (_bin, command) => command === 'update'
        ? {
          status: 'prepared',
          installed_controller: 'borgmcp-server@0.4.0',
          artifact: 'borgmcp-server@0.4.0',
          artifact_integrity: SERVER_TARGET.integrity,
          running_runtime: null,
          build_identity: 'a'.repeat(40),
          mode: 'stopped',
          data_identity: 'preserved',
          next_action: null,
        }
        : stoppedStatus),
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(0);
    expect(d.verifyRunningProtocol).not.toHaveBeenCalled();
    expect(d.stdout).toHaveBeenCalledWith(expect.stringContaining('prepared; still stopped'));
  });

  it('does not reactivate an already verified server runtime', async () => {
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => ({
        name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp-server',
        binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
      })),
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(0);
    expect(d.calls).toEqual(['server:status', 'protocol']);
  });

  it('updates only the client when the server was absent and never installs it', async () => {
    const d = deps({ currentServer: vi.fn(async () => null) });

    await expect(runUpdate({ yes: true }, d)).resolves.toBe(0);
    expect(d.installGlobal).toHaveBeenCalledOnce();
    expect(d.installGlobal).toHaveBeenCalledWith('borgmcp', '2.3.0');
    expect(d.serverJson).not.toHaveBeenCalled();
  });

  it('reports the installed client when a previously present server disappears during re-entry', async () => {
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => null),
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0', serverPresent: true },
    }, d)).resolves.toBe(1);
    expect(d.installGlobal).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledWith(
      `The previously installed server is no longer available.\n` +
      `Observed update state:\n` +
      `  client: borgmcp@2.3.0 (borgmcp-shared@0.6.5)\n` +
      `  server controller: unavailable\n` +
      `  prepared runtime: not inspected\n` +
      `  running runtime: not inspected\n` +
      `Server mutation was not attempted.\n` +
      `Retry with: borg update --yes\n`,
    );
  });

  it('reports partial completion and skips runtime mutation when controller install fails', async () => {
    const installGlobal = vi.fn(async (name: string) => {
      if (name === 'borgmcp-server') throw new Error('controller install failed');
    });
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      installGlobal,
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(1);
    expect(d.serverJson).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledOnce();
    expect(d.stderr).toHaveBeenCalledWith(
      `Client updated, but server controller update failed: controller install failed.\n` +
      `Observed update state:\n` +
      `  client: borgmcp@2.3.0 (borgmcp-shared@0.6.5)\n` +
      `  server controller: unavailable after controller failure\n` +
      `  prepared runtime: not inspected\n` +
      `  running runtime: not inspected\n` +
      `Server runtime mutation was not attempted.\n` +
      `Retry with: borg update --yes\n`,
    );
  });

  it('rejects final server identity mismatch even after both installs succeed', async () => {
    const oldIntegrity = `sha512-${Buffer.alloc(64, 3).toString('base64')}`;
    let statusCalls = 0;
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => ({
        name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp-server',
        binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
      })),
      serverJson: vi.fn(async (_bin, command) => {
        if (command === 'update') return updatedResult;
        statusCalls += 1;
        return statusCalls === 1
          ? {
            ...runningStatus,
            prepared_runtime: 'borgmcp-server@0.3.0',
            prepared_integrity: oldIntegrity,
            running_runtime: 'borgmcp-server@0.3.0',
            running_integrity: oldIntegrity,
            next_action: 'borg-mcp-server update',
          }
          : {
            ...runningStatus,
            running_runtime: 'borgmcp-server@0.3.0',
            running_integrity: oldIntegrity,
          };
      }),
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(1);
    expect(d.verifyRunningProtocol).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledOnce();
    expect(d.stderr).toHaveBeenCalledWith(
      `Server update or final verification failed: final server verification failed: running runtime mismatched.\n` +
      `Observed update state:\n` +
      `  client (last verified): borgmcp@2.3.0 (borgmcp-shared@0.6.5)\n` +
      `  server controller (last verified): borgmcp-server@0.4.0 (borgmcp-shared@0.6.5)\n` +
      `  prepared runtime: borgmcp-server@0.4.0\n` +
      `  prepared integrity: ${SERVER_TARGET.integrity}\n` +
      `  running runtime: borgmcp-server@0.3.0\n` +
      `  running integrity: ${oldIntegrity}\n` +
      `  server update: updated borgmcp-server@0.4.0 (${SERVER_TARGET.integrity})\n` +
      `Retry with: borg update --yes\n`,
    );
  });

  it('accepts additive status and update fields while validating the known contract', async () => {
    let statusCalls = 0;
    const additiveFields = {
      service_state: 'running',
      service_recovery: null,
      runtime_lock: { state: 'owned' },
      future_server_field: ['ignored'],
    };
    const serverJson = vi.fn(async (_bin: string, command: 'update' | 'status') => {
      if (command === 'update') return { ...updatedResult, ...additiveFields };
      statusCalls += 1;
      return statusCalls === 1
        ? {
          ...runningStatus,
          ...additiveFields,
          prepared_runtime: 'borgmcp-server@0.3.0',
          prepared_integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
          running_runtime: 'borgmcp-server@0.3.0',
          running_integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
          next_action: 'borg-mcp-server update',
        }
        : { ...runningStatus, ...additiveFields };
    });
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => ({
        name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp-server',
        binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
      })),
      serverJson,
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(0);
    expect(serverJson).toHaveBeenCalledTimes(3);
    expect(d.verifyRunningProtocol).toHaveBeenCalledOnce();
    expect(d.stderr).not.toHaveBeenCalled();
  });

  it('rejects a wrong-typed known status field even with additive fields', async () => {
    const serverJson = vi.fn(async () => ({
      ...runningStatus,
      service_adapter: 42,
      future_server_field: 'ignored',
    }));
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => ({
        name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp-server',
        binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
      })),
      serverJson,
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(1);
    expect(serverJson).toHaveBeenCalledOnce();
    expect(d.verifyRunningProtocol).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining('server returned invalid JSON status'));
  });

  it('rejects a wrong-typed known update field even with additive fields', async () => {
    const serverJson = vi.fn(async (_bin: string, command: 'update' | 'status') =>
      command === 'update'
        ? { ...updatedResult, artifact: 42, future_server_field: 'ignored' }
        : {
          ...runningStatus,
          prepared_runtime: 'borgmcp-server@0.3.0',
          running_runtime: 'borgmcp-server@0.3.0',
          next_action: 'borg-mcp-server update',
        });
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => ({
        name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp-server',
        binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
      })),
      serverJson,
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(1);
    expect(serverJson).toHaveBeenCalledTimes(2);
    expect(d.verifyRunningProtocol).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining('server returned invalid JSON update result'));
  });

  it('strictly decodes the server failure envelope and reports partial completion', async () => {
    const serverJson = vi.fn(async (_bin: string, command: 'update' | 'status') =>
      command === 'update'
        ? {
          status: 'failed',
          error_code: 'ACTIVATION_FAILED',
          recovery: 'restored',
          data_identity: 'preserved',
          future_server_field: 'ignored',
        }
        : {
          ...runningStatus,
          prepared_runtime: 'borgmcp-server@0.3.0',
          running_runtime: 'borgmcp-server@0.3.0',
          next_action: 'borg-mcp-server update',
        });
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      currentServer: vi.fn(async () => ({
        name: 'borgmcp-server', version: '0.4.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp-server',
        binPath: '/npm/lib/node_modules/borgmcp-server/dist/cli.js',
      })),
      serverJson,
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0' },
    }, d)).resolves.toBe(1);
    expect(d.stderr).toHaveBeenCalledOnce();
    expect(d.stderr).toHaveBeenCalledWith(
      `Server update or final verification failed: server update failed: ACTIVATION_FAILED (restored).\n` +
      `Observed update state:\n` +
      `  client (last verified): borgmcp@2.3.0 (borgmcp-shared@0.6.5)\n` +
      `  server controller (last verified): borgmcp-server@0.4.0 (borgmcp-shared@0.6.5)\n` +
      `  prepared runtime: unavailable\n` +
      `  prepared integrity: unavailable\n` +
      `  running runtime: unavailable\n` +
      `  running integrity: unavailable\n` +
      `  server update: failed ACTIVATION_FAILED (restored)\n` +
      `Retry with: borg update --yes\n`,
    );
  });

  it('rejects a changed exact target during re-entry before server mutation', async () => {
    const d = deps({
      currentClient: vi.fn(async () => ({
        name: 'borgmcp', version: '2.3.0', sharedVersion: '0.6.5',
        packageRoot: '/npm/lib/node_modules/borgmcp',
        binPath: '/npm/lib/node_modules/borgmcp/dist/claude.js',
      })),
      publishedPackage: vi.fn(async (name) => name === 'borgmcp'
        ? { ...CLIENT_TARGET, version: '2.3.1' }
        : SERVER_TARGET),
    });

    await expect(runUpdate({
      yes: true,
      target: { clientVersion: '2.3.0', serverVersion: '0.4.0', serverPresent: true },
    }, d)).resolves.toBe(1);
    expect(d.installGlobal).not.toHaveBeenCalled();
    expect(d.serverJson).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledOnce();
    expect(d.stderr).toHaveBeenCalledWith(
      `published update targets changed during client re-entry\n` +
      `Observed update state:\n` +
      `  client: borgmcp@2.3.0 installed and verified before re-entry\n` +
      `  server controller: not changed by this continuation\n` +
      `  prepared runtime: not inspected\n` +
      `  running runtime: not inspected\n` +
      `Server mutation was not attempted.\n` +
      `Retry with: borg update --yes\n`,
    );
  });
});

describe('runEarlyUpdate', () => {
  it('does nothing for another top-level command', async () => {
    const d = deps();
    await expect(runEarlyUpdate(['node', 'borg', 'server', 'status'], d)).resolves.toBeNull();
    expect(d.publishedPackage).not.toHaveBeenCalled();
  });

  it('renders focused help without registry, provenance, prompt, or mutation work', async () => {
    const d = deps();
    await expect(runEarlyUpdate(['node', 'borg', 'update', '--help'], d)).resolves.toBe(0);
    expect(d.stdout).toHaveBeenCalledWith(expect.stringContaining('borg update'));
    expect(d.publishedPackage).not.toHaveBeenCalled();
    expect(d.currentClient).not.toHaveBeenCalled();
    expect(d.currentServer).not.toHaveBeenCalled();
    expect(d.installGlobal).not.toHaveBeenCalled();
  });

  it('rejects unknown options without any update work', async () => {
    const d = deps();
    await expect(runEarlyUpdate(['node', 'borg', 'update', '--force'], d)).resolves.toBe(1);
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining('unknown option: --force'));
    expect(d.publishedPackage).not.toHaveBeenCalled();
    expect(d.installGlobal).not.toHaveBeenCalled();
  });
});
