import { spawn as spawnChild, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
import chalk from 'chalk';
import { cubeInitHelpText, isHelpFlag, serverHelpText } from './cli-help.js';
import { consolePrefix } from './console-prefix.js';
import { getPackageVersion } from './version.js';

export const SERVER_LIFECYCLE_COMMANDS = ['setup', 'start', 'stop', 'status', 'update', 'invite', 'dashboard'] as const;
export type ServerLifecycleCommand = typeof SERVER_LIFECYCLE_COMMANDS[number];

export type ParsedServerFacadeArgs =
  | { kind: 'help' }
  | { kind: 'cube-init-help' }
  | { kind: 'cube-init'; args: string[] }
  | { kind: 'command-help'; command: ServerLifecycleCommand }
  | { kind: 'command'; command: ServerLifecycleCommand; args: string[] }
  | { kind: 'error'; reason: 'unknown-command'; command: string };

export function isClientOwnedCubeInitArgv(argv: readonly string[]): boolean {
  return argv[2] === 'server' && argv[3] === 'cube' && argv[4] === 'init';
}

export function parseServerFacadeArgs(args: readonly string[]): ParsedServerFacadeArgs {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h') {
    return { kind: 'help' };
  }
  if (command === 'cube' && rest[0] === 'init') {
    const args = rest.slice(1);
    return args.some(isHelpFlag)
      ? { kind: 'cube-init-help' }
      : { kind: 'cube-init', args };
  }
  if (!(SERVER_LIFECYCLE_COMMANDS as readonly string[]).includes(command)) {
    return { kind: 'error', reason: 'unknown-command', command };
  }
  if (rest.some(isHelpFlag)) {
    return { kind: 'command-help', command: command as ServerLifecycleCommand };
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
  isInteractiveTerminal(): boolean;
  addSignalListener(signal: NodeJS.Signals, listener: () => void): void;
  removeSignalListener(signal: NodeJS.Signals, listener: () => void): void;
}

export interface ServerFacadeOutputDeps {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface ServerFacadeClientDeps {
  cubeInit(args: readonly string[]): Promise<number>;
}

export type AssimilateDepsBuilder = typeof import('./assimilate-deps.js').buildDefaultAssimilateDeps;

export type ServerFacadeProcessResult =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: NodeJS.Signals }
  | { kind: 'spawn-error'; error: Error };

const defaultProcessDeps: ServerFacadeProcessDeps = {
  spawn: (command, args, options) => spawnChild(command, [...args], options),
  isInteractiveTerminal: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  addSignalListener: (signal, listener) => process.on(signal, listener),
  removeSignalListener: (signal, listener) => process.off(signal, listener),
};

const defaultOutputDeps: ServerFacadeOutputDeps = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export function buildDefaultServerFacadeClientDeps(
  buildDeps?: AssimilateDepsBuilder,
): ServerFacadeClientDeps {
  return {
    cubeInit: async (args) => {
      const [{ parseAssimilateArgs }, { buildDefaultAssimilateDeps }, { runAssimilate }] = await Promise.all([
        import('./parse-assimilate-args.js'),
        import('./assimilate-deps.js'),
        import('./assimilate-cmd.js'),
      ]);
      const parsed = parseAssimilateArgs([...args]);
      const unsupported = parsed.ok ? unsupportedCubeInitInput(args, parsed) : undefined;
      if (!parsed.ok || unsupported !== undefined) {
        process.stderr.write(cubeInitUsageErrorText(parsed.ok ? unsupported! : parsed.error));
        return 1;
      }
      return runAssimilate(
        { role: undefined, flags: parsed.flags, mode: 'cube-init' },
        (buildDeps ?? buildDefaultAssimilateDeps)(),
      );
    },
  };
}

function unsupportedCubeInitInput(
  args: readonly string[],
  parsed: { role: string | undefined },
): string | undefined {
  if (parsed.role !== undefined) {
    return 'A role is not accepted because this command does not create a drone.';
  }
  const unsupported = ['--worktree', '--here', '--force', '--cli', '--model', '--backend', '--no-template'];
  const flag = args.find((arg) => unsupported.some((candidate) =>
    arg === candidate || arg.startsWith(`${candidate}=`)));
  return flag === undefined
    ? undefined
    : `${flag.split('=', 1)[0]} is not accepted because this command does not create a drone.`;
}

export function cubeInitUsageErrorText(reason: string): string {
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return (
    chalk.red(`${consolePrefix()}◼ borg server cube init: ${sentence}\n`) +
    'Run `borg server cube init --help` for usage.\n'
  );
}

const defaultClientDeps = buildDefaultServerFacadeClientDeps();

const MAX_RENDERED_COMMAND_CODE_POINTS = 80;

function inertCommand(command: string): string {
  const rendered: string[] = [];
  let truncated = false;
  for (const codePoint of command) {
    if (rendered.length === MAX_RENDERED_COMMAND_CODE_POINTS) {
      truncated = true;
      break;
    }
    rendered.push(/\p{Cc}/u.test(codePoint) ? '?' : codePoint);
  }
  if (truncated) {
    return `${rendered.slice(0, MAX_RENDERED_COMMAND_CODE_POINTS - 3).join('')}...`;
  }
  return rendered.join('');
}

export function unknownServerCommandText(command: string): string {
  return (
    `Unknown server command: ${inertCommand(command)}.\n` +
    `Available commands: setup, start, stop, status, update, invite, dashboard, cube init.\n` +
    `Next: run borg server --help.\n`
  );
}

export function serverLifecycleHelpText(command: ServerLifecycleCommand): string {
  return (
    `Usage: borg server ${command} [arguments]\n\n` +
    `Command arguments are server-owned and pass to the verified borg-mcp-server executable when run.\n`
  );
}

export function missingServerExecutableText(command: ServerLifecycleCommand): string {
  return (
    `Local server command is unavailable: borg-mcp-server was not found.\n` +
    `Next: install a verified borgmcp-server release, then rerun borg server ${command}.\n` +
    `No checkout fallback is attempted.\n`
  );
}

export function serverCommandStartupFailureText(command: ServerLifecycleCommand): string {
  return (
    `Local server command could not be started.\n` +
    `Next: check local permissions and system resources, then rerun borg server ${inertCommand(command)}.\n` +
    `No server command was started.\n`
  );
}

function isMissingServerExecutable(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
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

    const forwardSigint = () => {
      // An interactive terminal has already sent SIGINT to this foreground
      // group, including the server. Forwarding again kills its cleanup path.
      // Node exposes no signal origin, so parent-only SIGINT while attached to
      // a TTY is intentionally treated as terminal delivery and is not forwarded.
      if (!deps.isInteractiveTerminal()) child.kill('SIGINT');
    };
    const forwardSigterm = () => child.kill('SIGTERM');
    forwarders.set('SIGINT', forwardSigint);
    forwarders.set('SIGTERM', forwardSigterm);
    deps.addSignalListener('SIGINT', forwardSigint);
    deps.addSignalListener('SIGTERM', forwardSigterm);

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
  if (result.kind === 'spawn-error') return isMissingServerExecutable(result.error) ? 127 : 1;
  return 128 + (constants.signals[result.signal] ?? 1);
}

/** Routes every facade outcome before client initialization or network work. */
export async function runEarlyServerFacade(
  argv: readonly string[],
  deps: ServerFacadeProcessDeps = defaultProcessDeps,
  output: ServerFacadeOutputDeps = defaultOutputDeps,
  client: ServerFacadeClientDeps = defaultClientDeps,
): Promise<number | null> {
  if (argv[2] !== 'server') return null;
  const parsed = parseServerFacadeArgs(argv.slice(3));
  if (parsed.kind === 'help') {
    output.writeStdout(serverHelpText());
    return 0;
  }
  if (parsed.kind === 'cube-init-help') {
    output.writeStdout(cubeInitHelpText(getPackageVersion()));
    return 0;
  }
  if (parsed.kind === 'command-help') {
    output.writeStdout(serverLifecycleHelpText(parsed.command));
    return 0;
  }
  if (parsed.kind === 'error') {
    output.writeStderr(unknownServerCommandText(parsed.command));
    return 1;
  }
  if (parsed.kind === 'cube-init') return client.cubeInit(parsed.args);

  const result = await runServerFacadeProcess(parsed, deps);
  if (result.kind === 'spawn-error') {
    output.writeStderr(
      isMissingServerExecutable(result.error)
        ? missingServerExecutableText(parsed.command)
        : serverCommandStartupFailureText(parsed.command),
    );
  }
  return processResultExitCode(result);
}
