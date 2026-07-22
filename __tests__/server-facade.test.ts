import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  parseServerFacadeArgs,
  missingServerExecutableText,
  runEarlyServerFacade,
  runServerFacadeProcess,
  serverCommandStartupFailureText,
  unknownServerCommandText,
  type ServerFacadeOutputDeps,
  type ServerFacadeProcessDeps,
} from '../src/server-facade.js';

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
}

function outputDeps() {
  let stdout = '';
  let stderr = '';
  const output: ServerFacadeOutputDeps = {
    writeStdout: (text) => { stdout += text; },
    writeStderr: (text) => { stderr += text; },
  };
  return {
    output,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function processDeps(child: FakeChild) {
  const listeners = new Map<NodeJS.Signals, () => void>();
  const deps: ServerFacadeProcessDeps = {
    spawn: vi.fn(() => child),
    addSignalListener: vi.fn((signal, listener) => listeners.set(signal, listener)),
    removeSignalListener: vi.fn((signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    }),
  };
  return { deps, listeners };
}

describe('parseServerFacadeArgs', () => {
  it.each(['setup', 'start', 'stop', 'status', 'update', 'invite'] as const)(
    'accepts %s and preserves server-owned arguments verbatim',
    (command) => {
      expect(parseServerFacadeArgs([command, '--lan', '127.0.0.1'])).toEqual({
        kind: 'command',
        command,
        args: ['--lan', '127.0.0.1'],
      });
    },
  );

  it.each([[[]], [['--help']], [['-h']]] as const)('routes %j to facade help', (args) => {
    expect(parseServerFacadeArgs(args)).toEqual({ kind: 'help' });
  });

  it('rejects unknown lifecycle commands without forwarding them', () => {
    expect(parseServerFacadeArgs(['daemonize'])).toEqual({
      kind: 'error',
      reason: 'unknown-command',
      command: 'daemonize',
    });
  });
});

describe('runServerFacadeProcess', () => {
  it('runs the separate server executable in the foreground and preserves its exit code', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const pending = runServerFacadeProcess(
      { command: 'start', args: ['--lan'] },
      deps,
    );

    expect(deps.spawn).toHaveBeenCalledWith(
      'borg-mcp-server',
      ['start', '--lan'],
      { shell: false, stdio: 'inherit' },
    );
    child.emit('exit', 23, null);

    await expect(pending).resolves.toEqual({ kind: 'exited', code: 23 });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s to the foreground child and removes signal listeners after exit',
    async (signal) => {
      const child = new FakeChild();
      const { deps, listeners } = processDeps(child);
      const pending = runServerFacadeProcess({ command: 'start', args: [] }, deps);

      listeners.get(signal)?.();
      expect(child.kill).toHaveBeenCalledWith(signal);
      child.emit('exit', null, signal);

      await expect(pending).resolves.toEqual({ kind: 'signaled', signal });
      expect(listeners.size).toBe(0);
    },
  );

  it('returns a typed spawn failure without interpreting it as server status', async () => {
    const child = new FakeChild();
    const { deps, listeners } = processDeps(child);
    const pending = runServerFacadeProcess({ command: 'status', args: [] }, deps);
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    child.emit('error', error);

    await expect(pending).resolves.toEqual({ kind: 'spawn-error', error });
    expect(listeners.size).toBe(0);
  });
});

describe('runEarlyServerFacade', () => {
  it('does nothing for non-server client invocations', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);

    await expect(runEarlyServerFacade(['node', 'borg', 'assimilate'], deps))
      .resolves.toBeNull();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each([[[]], [['--help']], [['-h']]] as const)(
    'renders approved plain-text help for %j without starting the server',
    async (args) => {
      const child = new FakeChild();
      const { deps } = processDeps(child);
      const output = outputDeps();

      await expect(runEarlyServerFacade(['node', 'borg', 'server', ...args], deps, output.output))
        .resolves.toBe(0);
      expect(output.stdout()).toBe(
        `Usage: borg server <command> [arguments]\n\n` +
        `Commands:\n` +
        `  setup    Prepare local server identity and data; does not start the server.\n` +
        `  start    Start the verified server in the foreground.\n` +
        `  stop     Stop the managed local server.\n` +
        `  status   Report verified runtime evidence.\n` +
        `  update   Verify and activate a local server artifact.\n` +
        `  invite   Create a single-use invitation in an interactive terminal.\n\n` +
        `Run borg server <command> --help for server command options.\n`,
      );
      expect(output.stderr()).toBe('');
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it('renders an unknown command as inert text without forwarding trailing arguments', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const output = outputDeps();

    await expect(runEarlyServerFacade(
      ['node', 'borg', 'server', 'bad\n\u001b[31m', '--secret'],
      deps,
      output.output,
    )).resolves.toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toBe(
      `Unknown server command: bad??[31m.\n` +
      `Available commands: setup, start, stop, status, update, invite.\n` +
      `Next: run borg server --help.\n`,
    );
    expect(output.stderr()).not.toContain('--secret');
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('caps an oversized unknown command at 80 Unicode code points', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const output = outputDeps();
    const oversized = '😀'.repeat(1024 * 1024);

    await expect(runEarlyServerFacade(
      ['node', 'borg', 'server', oversized],
      deps,
      output.output,
    )).resolves.toBe(1);
    expect(output.stderr()).toBe(
      `Unknown server command: ${'😀'.repeat(77)}....\n` +
      `Available commands: setup, start, stop, status, update, invite.\n` +
      `Next: run borg server --help.\n`,
    );
    const renderedToken = output.stderr().split('\n', 1)[0]
      .slice('Unknown server command: '.length, -1);
    expect(Array.from(renderedToken)).toHaveLength(80);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('forwards exact server argv and returns the separate server exit status', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const pending = runEarlyServerFacade(
      ['node', 'borg', 'server', 'status', '--json'],
      deps,
    );

    expect(deps.spawn).toHaveBeenCalledWith(
      'borg-mcp-server',
      ['status', '--json'],
      { shell: false, stdio: 'inherit' },
    );
    child.emit('exit', 7, null);
    await expect(pending).resolves.toBe(7);
  });

  it('forwards invite and its server-owned arguments without rendering output', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const output = outputDeps();
    const pending = runEarlyServerFacade(
      ['node', 'borg', 'server', 'invite', '--future-server-option'],
      deps,
      output.output,
    );

    expect(deps.spawn).toHaveBeenCalledWith(
      'borg-mcp-server',
      ['invite', '--future-server-option'],
      { shell: false, stdio: 'inherit' },
    );
    child.emit('exit', 0, null);
    await expect(pending).resolves.toBe(0);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toBe('');
  });

  it('forwards stop and its server-owned arguments without interpreting runtime state', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const output = outputDeps();
    const pending = runEarlyServerFacade(
      ['node', 'borg', 'server', 'stop', '--future-server-option'],
      deps,
      output.output,
    );

    expect(deps.spawn).toHaveBeenCalledWith(
      'borg-mcp-server',
      ['stop', '--future-server-option'],
      { shell: false, stdio: 'inherit' },
    );
    child.emit('exit', 42, null);
    await expect(pending).resolves.toBe(42);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toBe('');
  });

  it('maps a signal-terminated server to the conventional process exit status', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const pending = runEarlyServerFacade(
      ['node', 'borg', 'server', 'start'],
      deps,
    );

    child.emit('exit', null, 'SIGINT');
    await expect(pending).resolves.toBe(130);
  });

  it('maps a missing separate server executable to command-not-found status', async () => {
    const child = new FakeChild();
    const { deps } = processDeps(child);
    const output = outputDeps();
    const pending = runEarlyServerFacade(
      ['node', 'borg', 'server', 'setup'],
      deps,
      output.output,
    );

    child.emit('error', Object.assign(new Error('spawn borg-mcp-server ENOENT /secret/path'), { code: 'ENOENT' }));
    await expect(pending).resolves.toBe(127);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toBe(
      `Local server command is unavailable: borg-mcp-server was not found.\n` +
      `Next: install a verified borgmcp-server release, then rerun borg server setup.\n` +
      `No checkout fallback is attempted.\n`,
    );
    expect(output.stderr()).not.toContain('/secret/path');
  });

  it.each(['EACCES', 'EMFILE'])(
    'keeps %s distinct from a missing executable without exposing spawn details',
    async (code) => {
      const child = new FakeChild();
      const { deps } = processDeps(child);
      const output = outputDeps();
      const pending = runEarlyServerFacade(
        ['node', 'borg', 'server', 'update'],
        deps,
        output.output,
      );

      child.emit('error', Object.assign(new Error(`${code} /secret/path`), { code }));
      await expect(pending).resolves.toBe(1);
      expect(output.stdout()).toBe('');
      expect(output.stderr()).toBe(
        `Local server command could not be started.\n` +
        `Next: check local permissions and system resources, then rerun borg server update.\n` +
        `No server command was started.\n`,
      );
      expect(output.stderr()).not.toMatch(new RegExp(`${code}|/secret/path`));
    },
  );
});

describe('approved server facade copy', () => {
  it('renders the exact bounded unknown-command text', () => {
    expect(unknownServerCommandText('daemonize')).toBe(
      `Unknown server command: daemonize.\n` +
      `Available commands: setup, start, stop, status, update, invite.\n` +
      `Next: run borg server --help.\n`,
    );
  });

  it('renders the exact bounded missing-executable text', () => {
    expect(missingServerExecutableText('update')).toBe(
      `Local server command is unavailable: borg-mcp-server was not found.\n` +
      `Next: install a verified borgmcp-server release, then rerun borg server update.\n` +
      `No checkout fallback is attempted.\n`,
    );
  });

  it('renders the exact bounded non-ENOENT startup-failure text', () => {
    expect(serverCommandStartupFailureText('start')).toBe(
      `Local server command could not be started.\n` +
      `Next: check local permissions and system resources, then rerun borg server start.\n` +
      `No server command was started.\n`,
    );
  });
});
