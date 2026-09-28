/**
 * A separate OS process acting on the representative state under $HOME, for
 * the cross-process controls. Modes:
 *   bind <worktree> <boundAt>      save one prepared binding (first use creates the state)
 *   kill-at <hook>                 first use, SIGKILL itself at that publish hook
 *   reset                          `borg representative reset-state`, prints its output
 *   reset-kill-at <hook>           reset, SIGKILL itself at that publish hook
 *   stress <n> <go-file>           wait for <go-file>, then n read-modify-write increments
 *   workload <backend-url> <worktree> <iterations> <go-file>
 *                                  real tool calls against a shared backend (the parent's
 *                                  MockCube over HTTP): each iteration sends one request,
 *                                  reads and delivers through the last reply it read
 *   pause <hook> <ready-file> <go-file> <worktree>
 *                                  stall at the first <hook> (beforeOpen, beforeBegin,
 *                                  afterBegin) until <go-file> exists, then save a binding
 * Output is one JSON line on stdout.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createRepresentativeState, readCurrent, representativeStateRoot } from '../../src/representative-db.js';
import { createRepresentativeStore } from '../../src/representative-store.js';
import { runRepresentativeResetState } from '../../src/representative-cmd.js';
import { bindingFor } from './representative-mock-backend.js';

const [mode, a, b, c] = process.argv.slice(2);
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const waitFor = async (file: string) => { while (!existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 2)); };
const kill = () => process.kill(process.pid, 'SIGKILL');

if (mode === 'bind') {
  const store = createRepresentativeStore();
  print({ outcome: await store.saveBinding(bindingFor(a, { boundAt: b }), { rebind: true }), current: readCurrent(representativeStateRoot()) });
  store.state.close();
} else if (mode === 'kill-at') {
  const state = createRepresentativeState({ hooks: { [a]: kill } });
  await state.transact(() => {});
  print({ survived: true });
} else if (mode === 'reset' || mode === 'reset-kill-at') {
  if (mode === 'reset-kill-at') {
    const { resetRepresentativeState } = await import('../../src/representative-db.js');
    const { parseBinding, bindingFingerprint } = await import('../../src/representative-store.js');
    const { seatKey } = await import('../../src/representative-legacy.js');
    await resetRepresentativeState({
      validateBinding: parseBinding, generationOf: bindingFingerprint as never, seatOf: seatKey as never, hooks: { [a]: kill },
    });
    print({ survived: true });
  } else {
    let out = '', err = '';
    const code = await runRepresentativeResetState({ stdout: (text) => { out += text; }, stderr: (text) => { err += text; } });
    print({ code, out, err });
  }
} else if (mode === 'stress') {
  const state = createRepresentativeState({ busyTimeoutMs: 60_000 });
  await state.transact(() => {}); // open the handle before the start line
  await waitFor(b);
  for (let i = 0; i < Number(a); i += 1) {
    await state.transact((db) => {
      const row = db.prepare(`SELECT state FROM wake_state WHERE generation = 'stress'`).get() as { state: string } | undefined;
      const next = Number(row?.state ?? '0') + 1;
      db.prepare(`INSERT INTO wake_state (generation, state) VALUES ('stress', ?)
        ON CONFLICT (generation) DO UPDATE SET state = excluded.state`).run(String(next));
    });
  }
  state.close();
  print({ done: Number(a) });
} else if (mode === 'pause') {
  // The first time <hook> runs, signal <ready> and block (synchronously, as a
  // real stall would) until <go> exists; then finish one prepared-binding save.
  const [hook, ready, go, worktree] = [a, b, c, process.argv[6]];
  const counts: Record<string, number> = { beforeOpen: 0, beforeBegin: 0, afterBegin: 0 };
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let paused = false, armed = false;
  const hooks = Object.fromEntries(Object.keys(counts).map((name) => [name, () => {
    counts[name] += 1;
    if (!armed || name !== hook || paused) return;
    paused = true;
    writeFileSync(ready, 'ready');
    while (!existsSync(go)) Atomics.wait(sleeper, 0, 0, 2);
  }]));
  const state = createRepresentativeState({ busyTimeoutMs: 60_000, hooks });
  if (hook !== 'beforeOpen') await state.transact(() => {}); // an open handle on the generation current now
  for (const name of Object.keys(counts)) counts[name] = 0;
  armed = true;
  const store = createRepresentativeStore({ state });
  try {
    await store.saveBinding(bindingFor(worktree, { boundAt: '2026-03-01T00:00:00.000Z' }), { rebind: true });
    print({ ok: true, current: readCurrent(representativeStateRoot()), counts });
  } catch (error) {
    print({ ok: false, code: (error as { code?: string }).code, message: (error as Error).message, counts });
  }
  state.close();
} else if (mode === 'workload') {
  const { deliverRepresentativeReplies, readRepresentativeReplies, sendRepresentativeMessage } = await import('../../src/representative-core.js');
  const call = async (method: string, args: unknown[]) => {
    const response = await fetch(a, { method: 'POST', body: JSON.stringify({ method, args }) });
    const body = await response.json() as { result?: unknown; error?: { message: string; status?: number; code?: string } };
    if (body.error) throw Object.assign(new Error(body.error.message), body.error);
    return body.result;
  };
  const backend = Object.fromEntries(['whoami', 'roster', 'append', 'readAfter', 'readEntry', 'ack']
    .map((method) => [method, (...args: unknown[]) => call(method, args)])) as never;
  const ctx = { binding: bindingFor(b), backend, store: createRepresentativeStore() };
  await waitFor(process.argv[6]);
  const seen: string[] = [], checkpoints: string[] = [], sent: string[] = [], errors: string[] = [];
  for (let i = 0; i < Number(c); i += 1) {
    try {
      const result = await sendRepresentativeMessage(ctx, { kind: 'request', authorization: 'model_advice', message: `pid ${process.pid} request ${i}` });
      if (result.outcome === 'sent') sent.push(result.request_id); else errors.push(`send ${result.outcome}`);
      const read = await readRepresentativeReplies(ctx, { limit: 5 });
      seen.push(...read.replies.map((reply) => reply.entry_id));
      const last = read.replies.at(-1);
      if (last) {
        const delivered = await deliverRepresentativeReplies(ctx, { through: last.entry_id });
        checkpoints.push(`${delivered.checkpoint.created_at}|${delivered.checkpoint.entry_id}`);
      }
    } catch (error) {
      errors.push(`${(error as { code?: string }).code ?? 'UNTYPED'}: ${(error as Error).message}`);
    }
  }
  ctx.store.state.close();
  print({ seen, checkpoints, sent, errors });
} else {
  throw new Error(`unknown mode ${mode}`);
}
