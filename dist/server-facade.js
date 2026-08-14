import { spawn as spawnChild } from 'node:child_process';
import { constants } from 'node:os';
import chalk from 'chalk';
import { cubeInitHelpText, isHelpFlag, serverHelpText, serverServiceHelpText, } from './cli-help.js';
import { consolePrefix } from './console-prefix.js';
import { getPackageVersion } from './version.js';
export const SERVER_LIFECYCLE_COMMANDS = [
    'setup',
    'start',
    'status',
    'update',
    'invite',
    'cert-reissue',
    'client-list',
    'client-grant',
    'dashboard',
];
export function isClientOwnedCubeInitArgv(argv) {
    return argv[2] === 'server' && argv[3] === 'cube' && argv[4] === 'init';
}
export function parseServerFacadeArgs(args) {
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
    if (command === 'service') {
        const [subcommand, ...args] = rest;
        if (subcommand === undefined || isHelpFlag(subcommand)) {
            return { kind: 'service-help' };
        }
        if (subcommand !== 'install' && subcommand !== 'uninstall') {
            return {
                kind: 'error',
                reason: 'unknown-command',
                command: subcommand === undefined ? command : `${command} ${subcommand}`,
            };
        }
        const serviceCommand = subcommand === 'install' ? 'service install' : 'service uninstall';
        return args.some(isHelpFlag)
            ? { kind: 'command-help', command: serviceCommand }
            : { kind: 'command', command: serviceCommand, args };
    }
    if (!SERVER_LIFECYCLE_COMMANDS.includes(command)) {
        return { kind: 'error', reason: 'unknown-command', command };
    }
    if (rest.some(isHelpFlag)) {
        return { kind: 'command-help', command: command };
    }
    return {
        kind: 'command',
        command: command,
        args: rest,
    };
}
const defaultProcessDeps = {
    spawn: (command, args, options) => spawnChild(command, [...args], options),
    isInteractiveTerminal: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    addSignalListener: (signal, listener) => process.on(signal, listener),
    removeSignalListener: (signal, listener) => process.off(signal, listener),
};
const defaultOutputDeps = {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
};
export function buildDefaultServerFacadeClientDeps(buildDeps) {
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
                process.stderr.write(cubeInitUsageErrorText(parsed.ok ? unsupported : parsed.error));
                return 1;
            }
            return runAssimilate({ role: undefined, flags: parsed.flags, mode: 'cube-init' }, (buildDeps ?? buildDefaultAssimilateDeps)());
        },
    };
}
function unsupportedCubeInitInput(args, parsed) {
    if (parsed.role !== undefined) {
        return 'A role is not accepted because this command does not create a drone.';
    }
    const unsupported = ['--worktree', '--here', '--force', '--cli', '--model', '--backend', '--no-template'];
    const flag = args.find((arg) => unsupported.some((candidate) => arg === candidate || arg.startsWith(`${candidate}=`)));
    return flag === undefined
        ? undefined
        : `${flag.split('=', 1)[0]} is not accepted because this command does not create a drone.`;
}
export function cubeInitUsageErrorText(reason) {
    const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    return (chalk.red(`${consolePrefix()}◼ borg server cube init: ${sentence}\n`) +
        'Run `borg server cube init --help` for usage.\n');
}
const defaultClientDeps = buildDefaultServerFacadeClientDeps();
const MAX_RENDERED_COMMAND_CODE_POINTS = 80;
function inertCommand(command) {
    const rendered = [];
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
export function unknownServerCommandText(command) {
    return (`Unknown server command: ${inertCommand(command)}.\n` +
        `Available commands: setup, start, service install, service uninstall, status, update, invite, cert-reissue, client-list, client-grant, dashboard, cube init.\n` +
        `Next: run borg server --help.\n`);
}
export function serverLifecycleHelpText(command) {
    return (`Usage: borg server ${command} [arguments]\n\n` +
        `Command arguments are server-owned and pass to the verified borg-mcp-server executable when run.\n`);
}
export function missingServerExecutableText(command) {
    return (`Local server command is unavailable: borg-mcp-server was not found.\n` +
        `Next: install a verified borgmcp-server release, then rerun borg server ${command}.\n` +
        `No checkout fallback is attempted.\n`);
}
export function serverCommandStartupFailureText(command) {
    return (`Local server command could not be started.\n` +
        `Next: check local permissions and system resources, then rerun borg server ${inertCommand(command)}.\n` +
        `No server command was started.\n`);
}
function isMissingServerExecutable(error) {
    return error.code === 'ENOENT';
}
export function runServerFacadeProcess(input, deps = defaultProcessDeps) {
    const command = input.command.split(' ');
    const child = deps.spawn('borg-mcp-server', [...command, ...input.args], { shell: false, stdio: 'inherit' });
    return new Promise((resolve) => {
        let settled = false;
        const forwarders = new Map();
        const cleanup = () => {
            for (const [signal, listener] of forwarders) {
                deps.removeSignalListener(signal, listener);
            }
            forwarders.clear();
        };
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const forwardSigint = () => {
            // An interactive terminal has already sent SIGINT to this foreground
            // group, including the server. Forwarding again kills its cleanup path.
            // Node exposes no signal origin, so parent-only SIGINT while attached to
            // a TTY is intentionally treated as terminal delivery and is not forwarded.
            if (!deps.isInteractiveTerminal())
                child.kill('SIGINT');
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
function processResultExitCode(result) {
    if (result.kind === 'exited')
        return result.code;
    if (result.kind === 'spawn-error')
        return isMissingServerExecutable(result.error) ? 127 : 1;
    return 128 + (constants.signals[result.signal] ?? 1);
}
/** Routes every facade outcome before client initialization or network work. */
export async function runEarlyServerFacade(argv, deps = defaultProcessDeps, output = defaultOutputDeps, client = defaultClientDeps) {
    if (argv[2] !== 'server')
        return null;
    const parsed = parseServerFacadeArgs(argv.slice(3));
    if (parsed.kind === 'help') {
        output.writeStdout(serverHelpText());
        return 0;
    }
    if (parsed.kind === 'service-help') {
        output.writeStdout(serverServiceHelpText());
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
    if (parsed.kind === 'cube-init')
        return client.cubeInit(parsed.args);
    const result = await runServerFacadeProcess(parsed, deps);
    if (result.kind === 'spawn-error') {
        output.writeStderr(isMissingServerExecutable(result.error)
            ? missingServerExecutableText(parsed.command)
            : serverCommandStartupFailureText(parsed.command));
    }
    return processResultExitCode(result);
}
//# sourceMappingURL=server-facade.js.map