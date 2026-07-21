import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function runImportSmoke(packageRoot, exportTarget, timeoutMs) {
  const entryUrl = pathToFileURL(resolve(packageRoot, exportTarget)).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(entryUrl)})`,
  ], {
    cwd: packageRoot,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
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

async function runServerFacadeSmoke(generatedBin, timeoutMs) {
  const directory = await mkdtemp(join(tmpdir(), 'borgmcp-server-facade-smoke-'));
  const fakeServer = join(directory, 'borg-mcp-server');
  const expected = 'status\0--json';
  await writeFile(fakeServer, `#!/usr/bin/env node
const args = process.argv.slice(2).join('\\0');
process.stdout.write(args);
process.exit(args === ${JSON.stringify(expected)} ? 37 : 96);
`);
  await chmod(fakeServer, 0o755);

  try {
    const child = spawn(generatedBin, ['server', 'status', '--json'], {
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
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

    await rm(fakeServer);
    const missing = spawnSync(process.execPath, [generatedBin, 'server', 'update'], {
      env: { ...process.env, PATH: directory, CI: '1', NO_COLOR: '1' },
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
    return { serverFacadeExitCode: code, serverFacadeMissingExitCode: missing.status };
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
  await runImportSmoke(root, exportTarget, timeoutMs);
  const generatedBin = resolve(options.binPath ?? resolve(root, '..', '..', '..', 'bin', 'borg-mcp'));
  const child = spawn(generatedBin, [], {
    cwd: options.cwd ?? root,
    env: {
      ...process.env,
      BORG_SESSION: '1',
      BORG_AGENT_KIND: 'claude',
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
  return { ...result, ...await runServerFacadeSmoke(borgBin, timeoutMs) };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-packed-client.mjs <installed-package-root> [generated-bin]');
  console.log(JSON.stringify(await smokePackedClient(process.argv[2], { binPath: process.argv[3] }), null, 2));
}
