/**
 * The controlled mock cube served over loopback HTTP, so a listener child
 * process reads the same log the test writes. POST {method, args} calls the
 * cube's backend method; errors come back typed ({message, status, code}).
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { MockCube } from './representative-mock-backend.js';
import type { RepresentativeBackend } from '../../src/representative-core.js';

export async function serveBackend(cube: MockCube): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', async () => {
      const { method, args } = JSON.parse(raw) as { method: keyof RepresentativeBackend; args: unknown[] };
      try {
        const backend = cube.backend() as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
        response.end(JSON.stringify({ result: await backend[method](...args) }));
      } catch (error) {
        const { message, status, code } = error as { message: string; status?: number; code?: string };
        response.end(JSON.stringify({ error: { message, status, code } }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export function proxyBackend(url: string): RepresentativeBackend {
  const call = async (method: string, args: unknown[]) => {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ method, args }) });
    const body = await response.json() as { result?: unknown; error?: { message: string; status?: number; code?: string } };
    if (body.error) throw Object.assign(new Error(body.error.message), body.error);
    return body.result;
  };
  return Object.fromEntries(['whoami', 'roster', 'append', 'readAfter', 'readEntry', 'ack']
    .map((method) => [method, (...args: unknown[]) => call(method, args)])) as unknown as RepresentativeBackend;
}
