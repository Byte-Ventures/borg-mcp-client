import { spawn as spawnChild, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
import { serverHelpText } from './cli-help.js';

export const SERVER_LIFECYCLE_COMMANDS = ['setup', 'start', 'status', 'update'] as const;
export type ServerLifecycleCommand = typeof SERVER_LIFECYCLE_COMMANDS[number];

export type ParsedServerFacadeArgs =
  | { kind: 'help' }
  | { kind: 'command'; command: ServerLifecycleCommand; args: string[] }
  | { kind: 'error'; reason: 'unknown-command'; command: string };

export function parseServerFacadeArgs(args: readonly string[]): ParsedServerFacadeArgs {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    return { kind: 'help' };
  }
  if (!(SERVER_LIFECYCLE_COMMANDS as readonly string[]).includes(command)) {
    return { kind: 'error', reason: 'unknown-command', command };
  }
  return {
    kind: 'command',
    command: command as ServerLifecycleCommand,
    args: rest,
  };
}

interface ServerFacadeChild {
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface ServerFacadeProcessDeps {
  spawn(
    command: string,
    args: readonly string[],
    options: Pick<SpawnOptions, 'shell' | 'stdio'>,
  ): ServerFacadeChild;
  addSignalListener(signal: NodeJS.Signals, listener: () => void): void;
  removeSignalListener(signal: NodeJS.Signals, listener: () => void): void;
}

export interface ServerFacadeOutputDeps {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export type ServerFacadeProcessResult =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: NodeJS.Signals }
  | { kind: 'spawn-error'; error: Error };

const defaultProcessDeps: ServerFacadeProcessDeps = {
  spawn: (command, args, options) => spawnChild(command, [...args], options),
  addSignalListener: (signal, listener) => process.on(signal, listener),
  removeSignalListener: (signal, listener) => process.off(signal, listener),
};

const defaultOutputDeps: ServerFacadeOutputDeps = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

function inertCommand(command: string): string {
  return JSON.stringify(command).slice(1, -1);
}

export function unknownServerCommandText(command: string): string {
  return (
    `Unknown server command: ${inertCommand(command)}.\n` +
    `Available commands: setup, start, status, update.\n` +
    `Next: run borg server --help.\n`
  );
}

export function missingServerExecutableText(command: ServerLifecycleCommand): string {
  return (
    `Local server command is unavailable: borg-mcp-server was not found.\n` +
    `Next: install a verified borgmcp-server release, then rerun borg server ${command}.\n` +
    `No checkout fallback is attempted.\n`
  );
}

export function runServerFacadeProcess(
  input: { command: ServerLifecycleCommand; args: readonly string[] },
  deps: ServerFacadeProcessDeps = defaultProcessDeps,
): Promise<ServerFacadeProcessResult> {
  const child = deps.spawn(
    'borg-mcp-server',
    [input.command, ...input.args],
    { shell: false, stdio: 'inherit' },
  );
  const signals = ['SIGINT', 'SIGTERM'] as const;

  return new Promise((resolve) => {
    let settled = false;
    const forwarders = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      for (const [signal, listener] of forwarders) {
        deps.removeSignalListener(signal, listener);
      }
      forwarders.clear();
    };
    const settle = (result: ServerFacadeProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    for (const signal of signals) {
      const listener = () => {
        child.kill(signal);
      };
      forwarders.set(signal, listener);
      deps.addSignalListener(signal, listener);
    }

    child.once('error', (error) => settle({ kind: 'spawn-error', error }));
    child.once('exit', (code, signal) => {
      if (signal) {
        settle({ kind: 'signaled', signal });
        return;
      }
      settle({ kind: 'exited', code: code ?? 1 });
    });
  });
}

function processResultExitCode(result: ServerFacadeProcessResult): number {
  if (result.kind === 'exited') return result.code;
  if (result.kind === 'spawn-error') return 127;
  return 128 + (constants.signals[result.signal] ?? 1);
}

/** Routes every facade outcome before client initialization or network work. */
export async function runEarlyServerFacade(
  argv: readonly string[],
  deps: ServerFacadeProcessDeps = defaultProcessDeps,
  output: ServerFacadeOutputDeps = defaultOutputDeps,
): Promise<number | null> {
  if (argv[2] !== 'server') return null;
  const parsed = parseServerFacadeArgs(argv.slice(3));
  if (parsed.kind === 'help') {
    output.writeStdout(serverHelpText());
    return 0;
  }
  if (parsed.kind === 'error') {
    output.writeStderr(unknownServerCommandText(parsed.command));
    return 1;
  }

  const result = await runServerFacadeProcess(parsed, deps);
  if (result.kind === 'spawn-error') {
    output.writeStderr(missingServerExecutableText(parsed.command));
  }
  return processResultExitCode(result);
}
