import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const FACADE_ROOT = process.env.BORG_SERVER_FACADE_CONTROL_ROOT ?? ROOT;
const RESTORE_CURSOR = '\u001b[?25h';
const RESTORE_SCREEN = '\u001b[?1049l';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function runForegroundSignalControl(command: 'dashboard' | 'start'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'borg-server-facade-signal-'));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, 'bin');
  await mkdir(binDirectory);

  const server = join(binDirectory, 'borg-mcp-server');
  await writeFile(server, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
process.stdout.write('SERVER_PGID:' + pgid + '\\nSERVER_READY\\n');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  if (chunk.includes(120)) process.stdout.write('STDIN_RECEIVED\\n');
});
process.on('SIGWINCH', () => process.stdout.write('WINCH_RECEIVED\\n'));
process.on('SIGCONT', () => process.stdout.write('CHILD_CONTINUED\\n'));
process.once('SIGINT', () => {
  setTimeout(() => {
    process.stdout.write('\\u001b[?25h\\u001b[?1049lSERVER_RESTORED\\n');
    process.exit(0);
  }, 100);
});
setInterval(() => {}, 1000);
`);
  await chmod(server, 0o755);

  const runner = join(directory, 'runner.mts');
  const facadeUrl = pathToFileURL(join(FACADE_ROOT, 'src', 'server-facade.ts')).href;
  await writeFile(runner, `
import { ChildProcess, execFileSync } from 'node:child_process';
import { runEarlyServerFacade } from ${JSON.stringify(facadeUrl)};
const originalKill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function (signal) {
  process.stdout.write('PARENT_FORWARDED:' + signal + '\\n');
  return originalKill.call(this, signal);
};
const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
process.stdout.write('PARENT_PGID:' + pgid + '\\n');
const code = await runEarlyServerFacade(['node', 'borg', 'server', ${JSON.stringify(command)}]);
process.stdout.write('PARENT_EXIT:' + code + '\\n');
process.exit(code ?? 1);
`);

  const wrapper = join(directory, 'run-control');
  await writeFile(wrapper, `#!/bin/sh
exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(runner)}
`);
  await chmod(wrapper, 0o755);

  const harness = join(directory, 'pty_control.py');
  await writeFile(harness, `
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, fd = pty.fork()
if pid == 0:
    os.execve(sys.argv[1], [sys.argv[1]], os.environ)

output = bytearray()
stage = 0
deadline = time.monotonic() + 10
status = None
while time.monotonic() < deadline:
    readable, _, _ = select.select([fd], [], [], 0.1)
    if readable:
        try:
            chunk = os.read(fd, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b''
        output.extend(chunk)
    text = output.decode('utf-8', errors='replace')
    if stage == 0 and 'SERVER_READY' in text:
        os.kill(pid, signal.SIGINT)
        time.sleep(0.1)
        os.kill(pid, 0)
        output.extend(b'PARENT_ONLY_TTY_SIGINT_INERT\\n')
        os.write(fd, b'x\\n')
        stage = 1
    if stage == 1 and 'STDIN_RECEIVED' in text:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 60, 0, 0))
        stage = 2
    if stage == 2 and 'WINCH_RECEIVED' in text:
        os.write(fd, b'\\x1a')
        time.sleep(0.1)
        os.killpg(os.getpgid(pid), signal.SIGCONT)
        stage = 3
    if stage == 3 and 'CHILD_CONTINUED' in text:
        os.write(fd, b'\\x03')
        stage = 4
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        break
else:
    os.killpg(os.getpgid(pid), signal.SIGKILL)
    os.waitpid(pid, 0)

sys.stdout.buffer.write(output)
sys.stdout.write('HARNESS_STAGE:' + str(stage) + '\\n')
if status is None or stage != 4:
    sys.exit(1)
sys.exit(os.waitstatus_to_exitcode(status))
`);

  return new Promise((resolveOutput, reject) => {
    const pty = spawn('python3', [harness, wrapper], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      pty.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${command} signal control: ${JSON.stringify(output)}`));
    }, 10_000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
    };
    pty.stdout.on('data', collect);
    pty.stderr.on('data', collect);
    pty.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    pty.once('exit', () => {
      clearTimeout(timeout);
      resolveOutput(output);
    });
  });
}

describe.skipIf(process.platform === 'win32')('server facade foreground process group', () => {
  it.each(['dashboard', 'start'] as const)(
    'lets the %s child finish terminal restoration after PTY Ctrl-C',
    async (command) => {
      const output = await runForegroundSignalControl(command);
      const parentPgid = output.match(/PARENT_PGID:(\d+)/)?.[1];
      const serverPgid = output.match(/SERVER_PGID:(\d+)/)?.[1];

      expect(parentPgid).toBeDefined();
      expect(serverPgid).toBeDefined();
      expect(serverPgid).toBe(parentPgid);
      expect(output).toContain('PARENT_ONLY_TTY_SIGINT_INERT');
      expect(output).toContain('STDIN_RECEIVED');
      expect(output).toContain('WINCH_RECEIVED');
      expect(output).toContain('CHILD_CONTINUED');
      expect(output).not.toContain('PARENT_FORWARDED:SIGINT');
      expect(output).toContain('SERVER_RESTORED');
      expect(output).toContain(RESTORE_CURSOR);
      expect(output).toContain(RESTORE_SCREEN);
      expect(output).toContain('PARENT_EXIT:0');
      expect(output).toContain('HARNESS_STAGE:4');
    },
    15_000,
  );
});
