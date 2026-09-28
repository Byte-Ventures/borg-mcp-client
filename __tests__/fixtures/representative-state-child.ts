/**
 * A separate OS process acting on the representative state under $HOME, for
 * the cross-process controls. Modes:
 *   bind <worktree> <boundAt>      save one prepared binding (first use creates the state)
 *   kill-at <hook>                 first use, SIGKILL itself at that publish hook
 *   reset                          `borg representative reset-state`, prints its output
 *   reset-kill-at <hook>           reset, SIGKILL itself at that publish hook
 *   stress <n> <go-file>           wait for <go-file>, then n read-modify-write increments
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
} else {
  throw new Error(`unknown mode ${mode}`);
}
