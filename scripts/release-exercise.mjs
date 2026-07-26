import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const ALT_SCREEN_ENTER = '\u001b[?1049h';
const ALT_SCREEN_EXIT = '\u001b[?1049l';
const CURSOR_RESTORE = '\u001b[?25h';
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const PYTHON_PTY_SOURCE = String.raw`
import errno, fcntl, os, pty, select, struct, sys, termios
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvpe(argv[0], argv, os.environ)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
status = None
while True:
    readable, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.1)
    if sys.stdin.buffer in readable:
        data = os.read(sys.stdin.fileno(), 4096)
        if data:
            os.write(master, data)
    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b''
        if data:
            os.write(sys.stdout.fileno(), data)
    waited, child_status = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = child_status
        break
sys.exit(os.waitstatus_to_exitcode(status))
`;

const PTY_RUNNER_SOURCE = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [reportPath, target, ...args] = process.argv.slice(1);
const report = { stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true };
process.on('SIGINT', () => {});
const child = spawn(target, args, { env: process.env, stdio: 'inherit' });
child.once('error', (error) => {
  writeFileSync(reportPath, JSON.stringify({ ...report, spawnError: error.message }));
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  writeFileSync(reportPath, JSON.stringify({ ...report, code, signal }));
  process.exitCode = code ?? 1;
});
`;

function runNpm(args, options = {}) {
  return process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
    : execFileSync('npm', args, options);
}

export function parseReleaseExerciseArgs(args) {
  let server;
  let serverIntegrity;
  let clientTarball;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--server') server = args[++index];
    else if (arg === '--server-integrity') serverIntegrity = args[++index];
    else if (arg === '--client-tarball') clientTarball = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!server || !serverIntegrity) {
    throw new Error(
      'Usage: npm run release:exercise -- --server <tarball-or-package-spec> --server-integrity <sha512-SRI> [--client-tarball <tarball>]',
    );
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(serverIntegrity)) {
    throw new Error('--server-integrity must be a SHA-512 SRI');
  }
  return { server, serverIntegrity, clientTarball };
}

export function ptyCommand(platform, argv) {
  if (platform === 'darwin' || platform === 'linux') {
    return { command: 'python3', args: ['-c', PYTHON_PTY_SOURCE, ...argv] };
  }
  throw new Error(`release:exercise requires a POSIX PTY; unsupported platform ${platform}`);
}

export function assertJourneyTranscript(transcript, expectedFooter, report) {
  assert.equal(report.stdinTTY, true, 'PTY precondition failed: stdin is not a TTY');
  assert.equal(report.stdoutTTY, true, 'PTY precondition failed: stdout is not a TTY');
  assert.equal(report.spawnError, undefined, `journey failed to start: ${report.spawnError}`);
  assert.equal(report.signal, null, `journey exited from signal ${report.signal}`);
  assert.match(transcript, new RegExp(expectedFooter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(transcript.includes(ALT_SCREEN_ENTER), 'journey did not enter the alternate screen');
  assert.ok(transcript.includes(CURSOR_RESTORE), 'journey did not restore the cursor');
  assert.ok(transcript.includes(ALT_SCREEN_EXIT), 'journey did not exit the alternate screen');
  assert.equal(report.code, 0, `journey exited with code ${report.code}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}

async function waitFor(predicate, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function processArgv(pid) {
  if (process.platform === 'linux') {
    return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  }
  return await new Promise((resolveArgv, rejectArgv) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }, (error, stdout) => {
      if (error) rejectArgv(error);
      else resolveArgv(stdout.trim().split(/\s+/u));
    });
  });
}

export function assertServerProcessArgv(argv, nodePath, serverEntry) {
  assert.equal(argv[0], nodePath, `server process does not use the declared Node path: ${argv.join(' ')}`);
  assert.equal(argv[1], serverEntry, `server process does not use the declared server entry: ${argv.join(' ')}`);
}

export function assertArtifactIdentity(actual, expected) {
  assert.equal(actual.path, expected.path, 'resolved artifact path does not match its declared role');
  assert.equal(actual.integrity, expected.integrity, 'resolved artifact integrity does not match its declared role');
}

async function readTrace(tracePath, command) {
  const text = await readFile(tracePath, 'utf8').catch(() => '');
  for (const line of text.trim().split('\n').reverse()) {
    if (!line) continue;
    const [pid, ...args] = line.split('\t');
    if (args[0] === command) return { pid: Number(pid), args };
  }
  return null;
}

async function createServerShim(directory, tracePath, nodePath, serverEntry) {
  const shim = join(directory, 'borg-mcp-server');
  const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  const quotedTrace = shellQuote(tracePath);
  const quotedNode = shellQuote(nodePath);
  const quotedEntry = shellQuote(serverEntry);
  await writeFile(shim, `#!/bin/sh\nprintf '%s' "$$" >> ${quotedTrace}\nprintf '\\t%s' "$@" >> ${quotedTrace}\nprintf '\\n' >> ${quotedTrace}\nexec ${quotedNode} ${quotedEntry} "$@"\n`);
  await chmod(shim, 0o755);
  return shim;
}

async function sha512(path) {
  const hash = createHash('sha512');
  hash.update(await readFile(path));
  return `sha512-${hash.digest('base64')}`;
}

async function packageTarball(packDirectory, clientTarball) {
  if (clientTarball) return realpath(resolve(clientTarball));
  const [result] = JSON.parse(runNpm([
    'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory,
  ], { cwd: root, encoding: 'utf8' }));
  return join(packDirectory, result.filename);
}

async function installCandidates(temporary, clientTarball, serverSpec, expectedServerIntegrity) {
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"name":"borg-release-exercise","private":true}\n');
  runNpm([
    'install', '--ignore-scripts', '--package-lock=true', '--save-exact',
    clientTarball, serverSpec,
  ], { cwd: consumer, stdio: 'pipe' });

  const clientRoot = await realpath(join(consumer, 'node_modules', 'borgmcp'));
  const serverRoot = await realpath(join(consumer, 'node_modules', 'borgmcp-server'));
  const clientManifest = JSON.parse(await readFile(join(clientRoot, 'package.json'), 'utf8'));
  const serverManifest = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8'));
  const clientBinTarget = typeof clientManifest.bin === 'string' ? clientManifest.bin : clientManifest.bin?.borg;
  const serverBinTarget = typeof serverManifest.bin === 'string'
    ? serverManifest.bin
    : serverManifest.bin?.['borg-mcp-server'];
  assert.ok(clientBinTarget, 'installed candidate client does not expose the borg binary');
  assert.ok(serverBinTarget, 'installed server artifact does not expose the borg-mcp-server binary');

  const clientBin = await realpath(join(consumer, 'node_modules', '.bin', 'borg'));
  const serverEntry = await realpath(join(serverRoot, serverBinTarget));
  assert.equal(clientBin, await realpath(join(clientRoot, clientBinTarget)));
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  const packedClientIntegrity = await sha512(clientTarball);
  const clientIntegrity = lock.packages?.['node_modules/borgmcp']?.integrity ?? packedClientIntegrity;
  assert.equal(clientIntegrity, packedClientIntegrity, 'installed client integrity does not match its packed candidate');
  const serverIntegrity = lock.packages?.['node_modules/borgmcp-server']?.integrity;
  assert.ok(serverIntegrity, 'npm did not record the installed server artifact integrity');
  assertArtifactIdentity(
    { path: serverEntry, integrity: serverIntegrity },
    { path: serverEntry, integrity: expectedServerIntegrity },
  );
  const localServerTarball = await realpath(resolve(serverSpec)).catch(() => null);
  if (localServerTarball) {
    assert.equal(
      serverIntegrity,
      await sha512(localServerTarball),
      'installed server integrity does not match its declared tarball',
    );
  }
  return {
    consumer,
    clientBin,
    clientIntegrity,
    clientVersion: clientManifest.version,
    serverEntry,
    serverIntegrity,
    serverRoot,
    serverVersion: serverManifest.version,
  };
}

async function bootstrapServerData(serverRoot, dataDirectory) {
  const bootstrapPath = join(serverRoot, 'dist', 'bootstrap.js');
  const { bootstrapServer } = await import(pathToFileURL(bootstrapPath).href);
  assert.equal(typeof bootstrapServer, 'function', 'installed server does not expose bootstrapServer');
  await bootstrapServer(dataDirectory);
}

async function assertRuntimeListener(dataDirectory, nodePath, serverEntry) {
  const lock = JSON.parse(await readFile(join(dataDirectory, 'runtime.lock'), 'utf8'));
  assert.ok(Number.isSafeInteger(lock.pid) && lock.pid > 0, 'runtime.lock does not identify a listening process');
  assertServerProcessArgv(await processArgv(lock.pid), nodePath, serverEntry);
  return lock.pid;
}

async function healthResponse(origin, dataDirectory) {
  const ca = await readFile(join(dataDirectory, 'ca.crt'));
  const url = new URL('/healthz', origin);
  return await new Promise((resolveResponse, rejectResponse) => {
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      ca,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolveResponse({
        body: Buffer.concat(chunks),
        status: response.statusCode,
      }));
    });
    request.once('error', rejectResponse);
    request.end();
  });
}

async function waitForHealth(origin, dataDirectory) {
  return waitFor(async () => {
    const response = await healthResponse(origin, dataDirectory);
    if (response.status !== 204) return false;
    assert.equal(response.body.length, 0, 'GET /healthz returned a body');
    return response;
  }, `healthy declared server artifact at ${origin}`);
}

async function assertHealthUnavailable(origin, dataDirectory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await healthResponse(origin, dataDirectory);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.fail(`server remained healthy after foreground start exited: ${origin}`);
}

async function runPtyJourney({
  args,
  clientBin,
  dataDirectory,
  expectedFooter,
  expectedServerCommand,
  beforeInterrupt,
  serverEntry,
  shimDirectory,
  tracePath,
  temporary,
}) {
  const reportPath = join(temporary, `${expectedServerCommand}-pty-report.json`);
  const runnerArgv = [
    process.execPath,
    '--input-type=module',
    '--eval',
    PTY_RUNNER_SOURCE,
    reportPath,
    clientBin,
    ...args,
  ];
  const pty = ptyCommand(process.platform, runnerArgv);
  const child = spawn(pty.command, pty.args, {
    cwd: temporary,
    env: {
      ...process.env,
      BORG_SERVER_DATA_DIR: dataDirectory,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      NO_COLOR: '1',
      PATH: `${shimDirectory}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let transcript = '';
  let ptyError;
  let interrupted = false;
  const append = (chunk) => {
    transcript += chunk.toString('utf8');
    if (Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES) child.kill('SIGTERM');
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', (error) => { ptyError = error; });

  try {
    const ready = await waitFor(async () => {
      if (ptyError) return { error: ptyError };
      if (Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES) {
        return { error: new Error(`PTY transcript exceeded ${MAX_TRANSCRIPT_BYTES} bytes`) };
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        return {
          error: new Error(`PTY exited before a frame rendered (code=${child.exitCode}, signal=${child.signalCode})`),
        };
      }
      const trace = await readTrace(tracePath, expectedServerCommand);
      if (!trace || !transcript.includes(expectedFooter) || !transcript.includes(ALT_SCREEN_ENTER)) return false;
      return trace;
    }, `${expectedServerCommand} declared server process and rendered frame`);
    if ('error' in ready) throw ready.error;
    const trace = ready;
    const argv = await processArgv(trace.pid);
    assertServerProcessArgv(argv, process.execPath, serverEntry);
    await beforeInterrupt?.(trace);
    interrupted = true;
    child.stdin.write('\u0003');
  } catch (error) {
    child.kill('SIGTERM');
    const trace = await readFile(tracePath, 'utf8').catch(() => '<no trace>');
    throw new Error(
      `${error.message}; trace=${JSON.stringify(trace)}; transcript=${JSON.stringify(transcript.slice(-4000))}`,
    );
  }
  assert.equal(interrupted, true);

  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        rejectExit(new Error(`${expectedServerCommand} PTY did not exit after Ctrl-C`));
      }, DEFAULT_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timer);
        rejectExit(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assertJourneyTranscript(transcript, expectedFooter, report);
  return { report, transcript };
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export async function exerciseRelease(options) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error(`release:exercise requires macOS or Linux, found ${process.platform}`);
  }
  const npmVersion = runNpm(['--version'], { cwd: root, encoding: 'utf8' }).trim();
  if (npmVersion !== '11.18.0') throw new Error(`release:exercise requires npm 11.18.0, found ${npmVersion}`);

  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'borgmcp-release-exercise-')));
  let directServer;
  try {
    const packDirectory = join(temporary, 'pack');
    const shimDirectory = join(temporary, 'controlled-bin');
    await mkdir(packDirectory);
    await mkdir(shimDirectory);
    const clientTarball = await packageTarball(packDirectory, options.clientTarball);
    const installed = await installCandidates(
      temporary,
      clientTarball,
      options.server,
      options.serverIntegrity,
    );
    const tracePath = join(temporary, 'server-invocations.tsv');
    const shim = await createServerShim(
      shimDirectory,
      tracePath,
      process.execPath,
      installed.serverEntry,
    );
    await realpath(shim);

    const dashboardData = join(temporary, 'dashboard-data');
    await mkdir(dashboardData, { mode: 0o700 });
    await bootstrapServerData(installed.serverRoot, dashboardData);
    const dashboardPort = await freePort();
    directServer = spawn(process.execPath, [installed.serverEntry, 'start', '--port', String(dashboardPort)], {
      env: { ...process.env, BORG_SERVER_DATA_DIR: dashboardData, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let directStdout = '';
    let directStderr = '';
    directServer.stdout.on('data', (chunk) => { directStdout += chunk.toString('utf8'); });
    directServer.stderr.on('data', (chunk) => { directStderr += chunk.toString('utf8'); });
    const dashboardOrigin = `https://127.0.0.1:${dashboardPort}`;
    await waitForHealth(dashboardOrigin, dashboardData).catch((error) => {
      throw new Error(
        `${error.message}; server stdout: ${directStdout.slice(0, 1000)}; stderr: ${directStderr.slice(0, 2000)}`,
      );
    });
    assertServerProcessArgv(await processArgv(directServer.pid), process.execPath, installed.serverEntry);
    assert.equal(
      await assertRuntimeListener(dashboardData, process.execPath, installed.serverEntry),
      directServer.pid,
      'dashboard listener PID does not match the directly started server process',
    );

    const dashboard = await runPtyJourney({
      args: ['server', 'dashboard', '--ascii'],
      clientBin: installed.clientBin,
      dataDirectory: dashboardData,
      expectedFooter: '^C close viewer',
      expectedServerCommand: 'dashboard',
      serverEntry: installed.serverEntry,
      shimDirectory,
      tracePath,
      temporary,
    });
    await waitForHealth(dashboardOrigin, dashboardData);
    assert.equal(directServer.exitCode, null, 'dashboard journey stopped the declared server artifact');
    await stopProcess(directServer);
    directServer = undefined;

    const startData = join(temporary, 'start-data');
    await mkdir(startData, { mode: 0o700 });
    await bootstrapServerData(installed.serverRoot, startData);
    const startPort = await freePort();
    const start = await runPtyJourney({
      args: ['server', 'start', '--port', String(startPort)],
      clientBin: installed.clientBin,
      dataDirectory: startData,
      expectedFooter: '^C stop server',
      expectedServerCommand: 'start',
      beforeInterrupt: async (trace) => {
        await waitForHealth(`https://127.0.0.1:${startPort}`, startData);
        assert.equal(
          await assertRuntimeListener(startData, process.execPath, installed.serverEntry),
          trace.pid,
          'foreground listener PID does not match the client-spawned server process',
        );
      },
      serverEntry: installed.serverEntry,
      shimDirectory,
      tracePath,
      temporary,
    });
    await assertHealthUnavailable(`https://127.0.0.1:${startPort}`, startData);

    return {
      roles: {
        client: {
          version: installed.clientVersion,
          integrity: installed.clientIntegrity,
          path: installed.clientBin,
        },
        dashboardListener: {
          version: installed.serverVersion,
          integrity: installed.serverIntegrity,
          path: installed.serverEntry,
        },
        dashboardViewer: {
          version: installed.serverVersion,
          integrity: installed.serverIntegrity,
          path: installed.serverEntry,
        },
        foregroundStartListenerAndViewer: {
          version: installed.serverVersion,
          integrity: installed.serverIntegrity,
          path: installed.serverEntry,
        },
      },
      journeys: {
        dashboard: { exitCode: dashboard.report.code, serverHealthyAfterExit: true },
        start: { exitCode: start.report.code, serverStoppedAfterExit: true },
      },
    };
  } finally {
    if (directServer) await stopProcess(directServer);
    await rm(temporary, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseReleaseExerciseArgs(process.argv.slice(2));
  console.log(JSON.stringify(await exerciseRelease(options), null, 2));
}
