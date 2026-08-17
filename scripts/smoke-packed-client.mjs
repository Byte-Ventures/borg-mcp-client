import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { cubeInitHelpText } = await import(new URL('../dist/cli-help.js', import.meta.url));

/** Build the disposable environment used by every packed-client child. */
export function isolatedClientEnv(homeRoot, baseEnv = process.env) {
  return {
    ...baseEnv,
    HOME: homeRoot,
    BORG_STATE_ROOT: homeRoot,
    CODEX_HOME: join(homeRoot, '.codex'),
    XDG_CONFIG_HOME: join(homeRoot, '.config'),
  };
}

async function runImportSmoke(packageRoot, exportTarget, timeoutMs, env) {
  const entryUrl = pathToFileURL(resolve(packageRoot, exportTarget)).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(entryUrl)})`,
  ], {
    cwd: packageRoot,
    env: { ...env, CI: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  await new Promise((resolveRun, rejectRun) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`Packed package import timed out. stderr: ${stderr.slice(0, 1000)}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) rejectRun(new Error(`Packed package import failed with code ${code}. stderr: ${stderr.slice(0, 1000)}`));
      else if (stdout.length > 0) rejectRun(new Error(`Packed package import wrote unexpected stdout: ${stdout.slice(0, 200)}`));
      else resolveRun();
    });
  });
}

async function runServerFacadeSmoke(generatedBin, timeoutMs, version, env) {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-server-facade-smoke-'));
  const fakeServer = join(directory, 'borg-mcp-server');
  const expected = 'status\0--json';
  const expectedInvite = 'invite\0--server-owned';
  const expectedServiceInstall = 'service\0install\0--server-owned';
  const expectedServiceUninstall = 'service\0uninstall\0--json';
  await writeFile(fakeServer, `#!/usr/bin/env node
const args = process.argv.slice(2).join('\\0');
process.stdout.write(args);
process.exit(args === ${JSON.stringify(expected)} ? 37 : args === ${JSON.stringify(expectedInvite)} ? 41 : args === ${JSON.stringify(expectedServiceInstall)} ? 43 : args === ${JSON.stringify(expectedServiceUninstall)} ? 44 : 96);
`);
  await chmod(fakeServer, 0o755);

  try {
    const updateHelp = spawnSync(generatedBin, ['update', '--help'], {
      env: { ...env, CI: '1', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (
      updateHelp.error ||
      updateHelp.status !== 0 ||
      !updateHelp.stdout.includes('borg update') ||
      !updateHelp.stdout.includes('matching exact borgmcp-shared pins') ||
      updateHelp.stderr !== ''
    ) {
      throw new Error(
        `Packed update help failed: status=${updateHelp.status}, stdout=${JSON.stringify(updateHelp.stdout)}, stderr=${JSON.stringify(updateHelp.stderr)}, error=${updateHelp.error?.message ?? ''}`,
      );
    }

    const child = spawn(generatedBin, ['server', 'status', '--json'], {
      env: {
        ...env,
        PATH: `${directory}${delimiter}${env.PATH ?? ''}`,
        CI: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const code = await new Promise((resolveRun, rejectRun) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        rejectRun(new Error(`Packed server facade timed out. stderr: ${stderr.slice(0, 1000)}`));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectRun(error);
      });
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolveRun(exitCode);
      });
    });
    if (code !== 37 || stdout !== expected || stderr !== '') {
      throw new Error(
        `Packed server facade failed: code=${code}, stdout=${JSON.stringify(stdout)}, stderr=${stderr.slice(0, 1000)}`,
      );
    }

    const cubeInitHelp = spawnSync(generatedBin, ['server', 'cube', 'init', '--help'], {
      env: { ...env, CI: '1', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (
      cubeInitHelp.error ||
      cubeInitHelp.status !== 0 ||
      cubeInitHelp.stdout !== cubeInitHelpText(version) ||
      cubeInitHelp.stderr !== ''
    ) {
      throw new Error(
        `Packed cube-init help failed: status=${cubeInitHelp.status}, stdout=${JSON.stringify(cubeInitHelp.stdout)}, stderr=${JSON.stringify(cubeInitHelp.stderr)}, error=${cubeInitHelp.error?.message ?? ''}`,
      );
    }

    const invite = spawnSync(generatedBin, ['server', 'invite', '--server-owned'], {
      env: {
        ...env,
        PATH: `${directory}${delimiter}${env.PATH ?? ''}`,
        CI: '1',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (invite.error || invite.status !== 41 || invite.stdout !== expectedInvite || invite.stderr !== '') {
      throw new Error(
        `Packed invite facade failed: status=${invite.status}, stdout=${JSON.stringify(invite.stdout)}, stderr=${JSON.stringify(invite.stderr)}, error=${invite.error?.message ?? ''}`,
      );
    }

    const serviceInstall = spawnSync(generatedBin, ['server', 'service', 'install', '--server-owned'], {
      env: {
        ...env,
        PATH: `${directory}${delimiter}${env.PATH ?? ''}`,
        CI: '1',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (
      serviceInstall.error ||
      serviceInstall.status !== 43 ||
      serviceInstall.stdout !== expectedServiceInstall ||
      serviceInstall.stderr !== ''
    ) {
      throw new Error(
        `Packed service-install facade failed: status=${serviceInstall.status}, stdout=${JSON.stringify(serviceInstall.stdout)}, stderr=${JSON.stringify(serviceInstall.stderr)}, error=${serviceInstall.error?.message ?? ''}`,
      );
    }

    const serviceUninstall = spawnSync(generatedBin, ['server', 'service', 'uninstall', '--json'], {
      env: {
        ...env,
        PATH: `${directory}${delimiter}${env.PATH ?? ''}`,
        CI: '1',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (
      serviceUninstall.error ||
      serviceUninstall.status !== 44 ||
      serviceUninstall.stdout !== expectedServiceUninstall ||
      serviceUninstall.stderr !== ''
    ) {
      throw new Error(
        `Packed service-uninstall facade failed: status=${serviceUninstall.status}, stdout=${JSON.stringify(serviceUninstall.stdout)}, stderr=${JSON.stringify(serviceUninstall.stderr)}, error=${serviceUninstall.error?.message ?? ''}`,
      );
    }

    const stop = spawnSync(generatedBin, ['server', 'stop', '--server-owned'], {
      env: {
        ...env,
        PATH: `${directory}${delimiter}${env.PATH ?? ''}`,
        CI: '1',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const expectedStopError =
      `Unknown server command: stop.\n` +
      `Available commands: setup, start, service install, service uninstall, status, update, invite, cert-reissue, client-list, client-grant, dashboard, cube init.\n` +
      `Next: run borg server --help.\n`;
    if (stop.error || stop.status !== 1 || stop.stdout !== '' || stop.stderr !== expectedStopError) {
      throw new Error(
        `Packed removed-stop rejection failed: status=${stop.status}, stdout=${JSON.stringify(stop.stdout)}, stderr=${JSON.stringify(stop.stderr)}, error=${stop.error?.message ?? ''}`,
      );
    }

    await chmod(fakeServer, 0o644);
    const unavailable = spawnSync(process.execPath, [generatedBin, 'server', 'update'], {
      env: { ...env, PATH: directory, CI: '1', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const expectedUnavailable =
      `Local server command could not be started.\n` +
      `Next: check local permissions and system resources, then rerun borg server update.\n` +
      `No server command was started.\n`;
    if (unavailable.error || unavailable.status !== 1 || unavailable.stdout !== '' || unavailable.stderr !== expectedUnavailable) {
      throw new Error(
        `Packed unavailable-server facade failed: status=${unavailable.status}, stdout=${JSON.stringify(unavailable.stdout)}, stderr=${JSON.stringify(unavailable.stderr)}, error=${unavailable.error?.message ?? ''}`,
      );
    }

    await rm(fakeServer);
    const missing = spawnSync(process.execPath, [generatedBin, 'server', 'update'], {
      env: { ...env, PATH: directory, CI: '1', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const expectedMissing =
      `Local server command is unavailable: borg-mcp-server was not found.\n` +
      `Next: install a verified borgmcp-server release, then rerun borg server update.\n` +
      `No checkout fallback is attempted.\n`;
    if (missing.error || missing.status !== 127 || missing.stdout !== '' || missing.stderr !== expectedMissing) {
      throw new Error(
        `Packed missing-server facade failed: status=${missing.status}, stdout=${JSON.stringify(missing.stdout)}, stderr=${JSON.stringify(missing.stderr)}, error=${missing.error?.message ?? ''}`,
      );
    }
    return {
      serverFacadeExitCode: code,
      serverFacadeInviteExitCode: invite.status,
      serverFacadeServiceInstallExitCode: serviceInstall.status,
      serverFacadeServiceUninstallExitCode: serviceUninstall.status,
      serverFacadeRemovedStopExitCode: stop.status,
      serverFacadeStartupFailureExitCode: unavailable.status,
      serverFacadeMissingExitCode: missing.status,
      updateHelpExitCode: updateHelp.status,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function smokePackedClient(packageRoot, options = {}) {
  const root = resolve(packageRoot);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const binTarget = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['borg-mcp'];
  if (!binTarget) throw new Error('Installed package does not expose the borg-mcp bin.');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const exportTarget = typeof manifest.exports?.['.'] === 'string'
    ? manifest.exports['.']
    : manifest.exports?.['.']?.import;
  if (!exportTarget) throw new Error('Installed package does not expose a root import.');
  const isolatedHome = await realpath(await mkdtemp(join(tmpdir(), 'borgmcp-packed-client-home-')));
  const env = isolatedClientEnv(isolatedHome, options.env ?? process.env);
  try {
    await runImportSmoke(root, exportTarget, timeoutMs, env);
    const generatedBin = resolve(options.binPath ?? resolve(root, '..', '..', '..', 'bin', 'borg-mcp'));
    const child = spawn(generatedBin, [], {
      cwd: options.cwd ?? root,
      env: {
        ...env,
        BORG_SESSION: '1',
        BORG_AGENT_KIND: 'claude',
        // A launcher-pinned kind must override stale legacy markers inherited
        // from a parent agent session.
        BORG_OPENCODE: '1',
        CI: '1',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let initialized = false;
    let settled = false;

    let result;
    try {
      result = await new Promise((resolveResult, rejectResult) => {
        const settle = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) rejectResult(error);
          else resolveResult(value);
        };
        const timer = setTimeout(() => {
          settle(new Error(`Packed MCP client timed out. stderr: ${stderr.slice(0, 1000)}`));
        }, timeoutMs);

        const consume = () => {
          while (stdout.includes('\n')) {
            const newline = stdout.indexOf('\n');
            const line = stdout.slice(0, newline).trim();
            stdout = stdout.slice(newline + 1);
            if (!line) continue;
            let message;
            try {
              message = JSON.parse(line);
            } catch {
              settle(new Error(`Packed MCP client wrote non-JSON data to stdout: ${line.slice(0, 200)}`));
              return;
            }
            if (message.id === 1) {
              if (message.error || typeof message.result?.protocolVersion !== 'string') {
                settle(new Error(`Packed MCP initialize failed: ${line}`));
                return;
              }
              if (!initialized) {
                initialized = true;
                child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
                child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
              }
            } else if (message.id === 2) {
              if (message.error || !Array.isArray(message.result?.tools) || message.result.tools.length === 0) {
                settle(new Error(`Packed MCP tool discovery failed: ${line}`));
                return;
              }
              const ackStatus = message.result.tools.find((tool) => tool.name === 'borg_ack-status');
              if (
                ackStatus?.inputSchema?.properties?.entry_id?.format !== 'uuid' ||
                ackStatus.inputSchema?.required?.length !== 1 ||
                ackStatus.inputSchema.required[0] !== 'entry_id'
              ) {
                settle(new Error('Packed MCP tool discovery omitted the strict borg_ack-status schema.'));
                return;
              }
              const readEntry = message.result.tools.find((tool) => tool.name === 'borg_read-entry');
              const log = message.result.tools.find((tool) => tool.name === 'borg_log');
              if (
                readEntry?.inputSchema?.required?.[0] !== 'entry_id' ||
                !readEntry.inputSchema?.properties?.entry_id?.pattern ||
                !log?.inputSchema?.required?.includes('to') ||
                log.inputSchema?.properties?.visibility !== undefined ||
                log.inputSchema?.properties?.to?.oneOf?.[0]?.enum?.[0] !== 'broadcast' ||
                log.inputSchema?.properties?.to?.oneOf?.[1]?.minItems !== 1
              ) {
                settle(new Error('Packed MCP tool discovery omitted mandatory explicit log addressing or borg_read-entry.'));
                return;
              }
              settle(null, {
                name: manifest.name,
                version: manifest.version,
                toolCount: message.result.tools.length,
              });
            }
          }
        };

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
          if (stdout.length > 1024 * 1024) {
            settle(new Error('Packed MCP client exceeded the stdout smoke-test limit.'));
            return;
          }
          consume();
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
          if (stderr.length > 1024 * 1024) settle(new Error('Packed MCP client exceeded the stderr smoke-test limit.'));
        });
        child.on('error', (error) => settle(error));
        child.on('exit', (code) => {
          if (!settled) settle(new Error(`Packed MCP client exited before tool discovery with code ${code}. stderr: ${stderr.slice(0, 1000)}`));
        });

        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'borgmcp-release-smoke', version: '1.0.0' },
          },
        })}\n`);
      });
    } finally {
      child.kill('SIGTERM');
    }
    const borgBin = resolve(options.borgBinPath ?? join(dirname(generatedBin), 'borg'));
    return { ...result, ...await runServerFacadeSmoke(borgBin, timeoutMs, manifest.version, env) };
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-packed-client.mjs <installed-package-root> [generated-bin]');
  console.log(JSON.stringify(await smokePackedClient(process.argv[2], { binPath: process.argv[3] }), null, 2));
}
