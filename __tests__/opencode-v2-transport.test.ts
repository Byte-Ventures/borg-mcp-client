import { afterEach, expect, it, vi } from 'vitest';
import { createOpenCodeV2Transport } from '../src/opencode-v2-transport.js';
import { callOpenCodeV2Broker } from '../src/opencode-v2-broker.js';

const server = { url: 'http://127.0.0.1:1234', headers: () => ({ Authorization: 'fixture' }) } as any;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fakeTimeouts() {
  vi.useFakeTimers();
  // Node's AbortSignal timers bypass fake setTimeout; put both on one clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Request deadline')), ms);
    return controller.signal;
  });
}

function delayedResponse(delayMs: number) {
  return vi.fn((_input, init) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal as AbortSignal;
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(Response.json([])); }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }));
}

it('allows cold configuration beyond ten seconds, then restores normal request timeouts', async () => {
  const startup = new AbortController();
  let starting = true;
  const transport = await createOpenCodeV2Transport(server, { startupSignal: () => starting ? startup.signal : undefined });
  fakeTimeouts();
  const fetch = delayedResponse(11_000); vi.stubGlobal('fetch', fetch);
  const cold = expect(transport.client.config.get({ location: { directory: '/fixture' } })).resolves.toEqual([]);
  await vi.advanceTimersByTimeAsync(11_000);
  await cold;
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
  starting = false;
  const warm = expect(transport.client.config.get({ location: { directory: '/fixture' } })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10_001);
  await warm;
});

it('uses the remaining shared startup budget rather than restarting it per request', async () => {
  const startup = new AbortController();
  const transport = await createOpenCodeV2Transport(server, { startupSignal: () => startup.signal });
  fakeTimeouts(); vi.stubGlobal('fetch', delayedResponse(11_000));
  setTimeout(() => startup.abort(new Error('Shared startup deadline')), 15_000);
  const first = expect(transport.client.config.get({ location: { directory: '/fixture' } })).resolves.toEqual([]);
  await vi.advanceTimersByTimeAsync(11_000); await first;
  const second = expect(transport.client.config.get({ location: { directory: '/fixture' } })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(4_001); await second;
  expect(startup.signal.aborted).toBe(true);
});

it('honors an explicit shorter request deadline during startup', async () => {
  const startup = new AbortController();
  const request = new AbortController();
  const transport = await createOpenCodeV2Transport(server, { startupSignal: () => startup.signal });
  fakeTimeouts(); vi.stubGlobal('fetch', delayedResponse(11_000));
  const pending = expect(transport.client.config.get({ location: { directory: '/fixture' } }, { signal: request.signal })).rejects.toThrow();
  request.abort(new Error('Request cancelled'));
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(startup.signal.aborted).toBe(false);
});

it('allows a slow inert readiness admission through the broker without extending ordinary wakes', async () => {
  fakeTimeouts(); vi.stubGlobal('fetch', delayedResponse(16_000));
  const descriptor = { url: 'http://127.0.0.1:1234', capability: 'fixture', launch: 'fixture' } as any;
  const startup = new AbortController();
  const readiness = expect(callOpenCodeV2Broker(descriptor, '/wake', { key: 'readiness', resume: false },
    { signal: startup.signal })).resolves.toEqual([]);
  await vi.advanceTimersByTimeAsync(16_000); await readiness;
  const wake = expect(callOpenCodeV2Broker(descriptor, '/wake', { key: 'kickoff' })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(15_001); await wake;
});
