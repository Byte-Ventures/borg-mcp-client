import { describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isMcpReadinessProbe,
  MCP_READINESS_PROBE_ENV,
  readinessProbeEnv,
} from '../src/readiness-probe';
import { runMcpStartupServices, type McpStartupServices } from '../src/startup-services';

describe('MCP readiness probe mode', () => {
  it('marks the short-lived child without dropping its launch environment', () => {
    const env = readinessProbeEnv({ PATH: '/usr/bin', HOME: '/tmp/home' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      [MCP_READINESS_PROBE_ENV]: '1',
    });
    expect(isMcpReadinessProbe(env)).toBe(true);
  });

  it('does not classify ordinary MCP children as probes', () => {
    expect(isMcpReadinessProbe({})).toBe(false);
    expect(isMcpReadinessProbe({ [MCP_READINESS_PROBE_ENV]: '0' })).toBe(false);
  });

  it('skips lease/SSE/background tasks in probe mode', async () => {
    const calls: string[] = [];
    let streamLockCreated = false;
    let sseFetchCount = 0;
    const services: McpStartupServices = {
      sessionStartHook: () => { calls.push('session-hook'); },
      auditHook: () => { calls.push('audit-hook'); },
      sseStream: () => {
        calls.push('sse-stream');
        streamLockCreated = true;
        sseFetchCount += 1;
      },
      openCode: () => { calls.push('opencode'); },
    };
    await runMcpStartupServices(true, services);
    expect(calls).toEqual([]);
    expect(streamLockCreated).toBe(false);
    expect(sseFetchCount).toBe(0);
  });

  it('completes the real MCP initialize probe without creating a stream-lock directory', async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'borg-readiness-probe-'));
    const home = path.join(fixture, 'home');
    const bin = path.join(fixture, 'bin');
    const configDir = path.join(home, '.config', 'borgmcp');
    mkdirSync(bin, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const cubeId = '11111111-1111-4111-8111-111111111111';
    const droneId = '22222222-2222-4222-8222-222222222222';
    writeFileSync(path.join(configDir, 'cubes.json'), JSON.stringify({
      projects: {
        [process.cwd()]: {
          cubeId,
          droneId,
          name: 'probe-cube',
          sessionToken: 'probe-token',
          droneLabel: 'probe-drone',
          apiUrl: 'https://example.invalid',
        },
      },
    }));

    // Minimal MCP server shim that responds to the initialize probe.
    // gh#client#18: probeMcpReady() now uses resolveMcpBinaryPath() (absolute
    // path from import.meta.url) instead of PATH-resolved 'borg-mcp', so a
    // shim placed on PATH is no longer picked up. Mock the resolver to return
    // the shim path instead.
    const shim = path.join(bin, 'mcp-probe-shim');
    writeFileSync(
      shim,
      `#!/usr/bin/env node
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (const line of buf.split('\\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'probe-shim', version: '0.0.0' },
          },
        }) + '\\n');
        process.exit(0);
      }
    } catch { /* ignore partial lines */ }
  }
});
`
    );
    chmodSync(shim, 0o755);

    vi.doMock('../src/self-path.js', () => ({
      resolveMcpBinaryPath: () => shim,
      resolveRegenPath: () => shim,
      resolveInboxMonitorPath: () => shim,
      resolveClearRewakePath: () => shim,
      resolveLogAuditPath: () => shim,
      __esModule: true,
    }));

    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    try {
      const { buildDefaultAssimilateDeps } = await import('../src/assimilate-deps.js');
      await expect(buildDefaultAssimilateDeps().probeMcpReady()).resolves.toBe(true);
      expect(existsSync(path.join(configDir, 'stream-locks'))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      vi.doUnmock('../src/self-path.js');
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 10_000);

  it('starts SSE and the other background services for a normal MCP child', async () => {
    const calls: string[] = [];
    await runMcpStartupServices(false, {
      sessionStartHook: () => { calls.push('session-hook'); },
      auditHook: () => { calls.push('audit-hook'); },
      sseStream: () => { calls.push('sse-stream'); },
      openCode: () => { calls.push('opencode'); },
    });
    expect(calls).toEqual([
      'session-hook',
      'audit-hook',
      'sse-stream',
      'opencode',
    ]);
  });

  it('isolates task failures so normal startup still reaches the SSE task', async () => {
    const calls: string[] = [];
    await runMcpStartupServices(false, {
      sessionStartHook: () => { throw new Error('hook failed'); },
      auditHook: () => { calls.push('audit-hook'); },
      sseStream: () => { calls.push('sse-stream'); },
      openCode: () => { calls.push('opencode'); },
    });
    expect(calls).toEqual(['audit-hook', 'sse-stream', 'opencode']);
  });
});
