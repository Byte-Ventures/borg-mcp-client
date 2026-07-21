import { spawn as spawnChild } from 'node:child_process';
import { constants } from 'node:os';
import { serverHelpText } from './cli-help.js';
export const SERVER_LIFECYCLE_COMMANDS = ['setup', 'start', 'status', 'update'];
export function parseServerFacadeArgs(args) {
    const [command, ...rest] = args;
    if (command === undefined || command === '--help' || command === '-h') {
        return { kind: 'help' };
    }
    if (!SERVER_LIFECYCLE_COMMANDS.includes(command)) {
        return { kind: 'error', reason: 'unknown-command', command };
    }
    return {
        kind: 'command',
        command: command,
        args: rest,
    };
}
const defaultProcessDeps = {
    spawn: (command, args, options) => spawnChild(command, [...args], options),
    addSignalListener: (signal, listener) => process.on(signal, listener),
    removeSignalListener: (signal, listener) => process.off(signal, listener),
};
const defaultOutputDeps = {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
};
function inertCommand(command) {
    return JSON.stringify(command).slice(1, -1);
}
export function unknownServerCommandText(command) {
    return (`Unknown server command: ${inertCommand(command)}.\n` +
        `Available commands: setup, start, status, update.\n` +
        `Next: run borg server --help.\n`);
}
export function missingServerExecutableText(command) {
    return (`Local server command is unavailable: borg-mcp-server was not found.\n` +
        `Next: install a verified borgmcp-server release, then rerun borg server ${command}.\n` +
        `No checkout fallback is attempted.\n`);
}
export function runServerFacadeProcess(input, deps = defaultProcessDeps) {
    const child = deps.spawn('borg-mcp-server', [input.command, ...input.args], { shell: false, stdio: 'inherit' });
    const signals = ['SIGINT', 'SIGTERM'];
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
function processResultExitCode(result) {
    if (result.kind === 'exited')
        return result.code;
    if (result.kind === 'spawn-error')
        return 127;
    return 128 + (constants.signals[result.signal] ?? 1);
}
/** Routes every facade outcome before client initialization or network work. */
export async function runEarlyServerFacade(argv, deps = defaultProcessDeps, output = defaultOutputDeps) {
    if (argv[2] !== 'server')
        return null;
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
//# sourceMappingURL=server-facade.js.map