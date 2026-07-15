import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('canonical hosted authority boundary', () => {
  it.each([
    'https://127.0.0.1:7091',
    'https://borg.internal.example:9443',
  ])('does not let BORG_API_URL=%s authorize explicit REST or SSE sessions', (endpoint) => {
    const home = mkdtempSync(join(tmpdir(), 'borg-hosted-authority-'));
    fixtures.push(home);
    const project = join(home, 'project');
    const configDir = join(home, '.config', 'borgmcp');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'cubes.json'), JSON.stringify({
      projects: {
        [project]: {
          cubeId: '11111111-1111-4111-8111-111111111111',
          droneId: '22222222-2222-4222-8222-222222222222',
          sessionToken: 'legacy-local-session',
          apiUrl: endpoint,
          // Deliberately removed: serverTrustIdentity.
        },
      },
    }));

    const root = process.cwd();
    const moduleUrl = (file: string) => pathToFileURL(join(root, 'dist', file)).href;
    const script = `
      const endpoint = process.env.TEST_ENDPOINT;
      let oauthReads = 0;
      let fetchCalls = 0;
      let rejected = 0;
      const config = await import(${JSON.stringify(moduleUrl('config.js'))});
      config.__setBackendForTest({
        name: 'keychain',
        get: async (account) => {
          if (account === 'google-id-token' || account === 'google-refresh-token') oauthReads++;
          if (account === 'google-id-token') return 'cloud-token-proof';
          if (account === 'token-expiry') return String(Date.now() + 60 * 60 * 1000);
          return null;
        },
        set: async () => {},
        delete: async () => {},
      });
      globalThis.fetch = async () => {
        fetchCalls++;
        return new Response('{}', { status: 200 });
      };
      const remote = await import(${JSON.stringify(moduleUrl('remote-client.js'))});
      const stream = await import(${JSON.stringify(moduleUrl('log-stream.js'))});
      const health = await import(${JSON.stringify(moduleUrl('health-beat.js'))});
      for (const trust of [undefined, 'malformed-trust']) {
        try {
          await remote.getRoster('legacy-local-session', endpoint, undefined, trust);
        } catch {
          rejected++;
        }
      }
      for (const trust of [undefined, 'malformed-trust']) {
        try {
          await stream.streamOnce({
            cubeId: '11111111-1111-4111-8111-111111111111',
            droneId: '22222222-2222-4222-8222-222222222222',
            sessionToken: 'legacy-local-session',
            apiUrl: endpoint,
            ...(trust === undefined ? {} : { serverTrustIdentity: trust }),
          }, null, () => {});
        } catch {
          rejected++;
        }
      }
      for (const trust of [undefined, 'malformed-trust']) {
        await health.postHealthBeat({
          cubeId: '11111111-1111-4111-8111-111111111111',
          droneId: '22222222-2222-4222-8222-222222222222',
          sessionToken: 'legacy-local-session',
          apiUrl: endpoint,
          ...(trust === undefined ? {} : { serverTrustIdentity: trust }),
        }, {
          sse_connected: false,
          inbox_monitor_armed: true,
          wake_armed: true,
          agent_kind: 'codex',
          hostname: 'host-a',
          version: '1.1.15',
          last_event_at: null,
        }, {
          fetchImpl: globalThis.fetch,
          getToken: async () => {
            oauthReads++;
            return 'cloud-token-proof';
          },
        });
      }
      process.stdout.write(JSON.stringify({ oauthReads, fetchCalls, rejected }));
    `;

    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        BORG_API_URL: endpoint,
        TEST_ENDPOINT: endpoint,
      },
    }));

    expect(result).toEqual({ oauthReads: 0, fetchCalls: 0, rejected: 4 });
  });
});
