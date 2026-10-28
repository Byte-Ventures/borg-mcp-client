import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { captureChildCompletion } from '../src/child-completion.js';

it('retains an exit that happened while the launch caller awaited admission', async () => {
  const child = new EventEmitter();
  const completion = captureChildCompletion(child as any);
  child.emit('exit', 7, null);
  await Promise.resolve();
  expect(await completion).toEqual({ kind: 'exit', code: 7, signal: null });
  expect(child.listenerCount('error')).toBe(0);
});
it('retains spawn errors as data without an early rejected promise', async () => {
  const child = new EventEmitter(); const error = new Error('Spawn failed');
  const completion = captureChildCompletion(child as any);
  child.emit('error', error);
  await Promise.resolve();
  expect(await completion).toEqual({ kind: 'error', error });
  expect(child.listenerCount('exit')).toBe(0);
});
