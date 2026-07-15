import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startCallbackServer } from '../src/auth.js';

type CallbackServer = Awaited<ReturnType<typeof startCallbackServer>>;
const servers: CallbackServer[] = [];

function callbackRequest(server: CallbackServer, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: server.host,
      port: server.port,
      path,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(state = 's'.repeat(43)): Promise<CallbackServer> {
  const server = await startCallbackServer(state);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('OAuth browser callback boundary', () => {
  it('refuses callback transactions without 256-bit base64url state', async () => {
    await expect(startCallbackServer('predictable')).rejects.toThrow('256 bits');
  });

  it('binds to an exact IPv4 loopback address', async () => {
    const server = await start();

    expect(server.host).toBe('127.0.0.1');
    expect(server.host).not.toBe('0.0.0.0');
  });

  it('ignores wrong-state races and consumes only the matching callback', async () => {
    const state = 'a'.repeat(43);
    const server = await start(state);
    const result = server.codePromise;

    const rejected = await Promise.all([
      callbackRequest(server, '/callback?state=wrong-1&code=attacker-1'),
      callbackRequest(server, '/callback?state=wrong-2&error=access_denied'),
      callbackRequest(server, `http://attacker.invalid/callback?state=${state}&code=attacker-3`),
    ]);
    expect(rejected.map((response) => response.status)).toEqual([400, 400, 400]);

    const accepted = await callbackRequest(
      server,
      `/callback?state=${encodeURIComponent(state)}&code=legitimate-code`,
    );
    expect(accepted.status).toBe(200);
    await expect(result).resolves.toBe('legitimate-code');
  });

  it('returns static output and errors for attacker-controlled OAuth errors', async () => {
    const state = 'b'.repeat(43);
    const server = await start(state);
    const rejected = expect(server.codePromise).rejects.toThrow('OAuth authorization was rejected');
    const injected = '<script>attack</script>\u001b[31m';

    const response = await callbackRequest(
      server,
      `/callback?state=${encodeURIComponent(state)}&error=${encodeURIComponent(injected)}`,
    );

    expect(response.status).toBe(400);
    expect(response.body).not.toContain('script');
    expect(response.body).not.toContain('\u001b');
    await rejected;
  });

  it('rejects oversized input without consuming the valid transaction', async () => {
    const state = 'c'.repeat(43);
    const server = await start(state);
    const result = server.codePromise;

    const oversized = await callbackRequest(server, `/callback?code=${'x'.repeat(2100)}`);
    expect(oversized.status).toBe(400);

    const accepted = await callbackRequest(
      server,
      `/callback?state=${encodeURIComponent(state)}&code=bounded-code`,
    );
    expect(accepted.status).toBe(200);
    await expect(result).resolves.toBe('bounded-code');
  });
});
