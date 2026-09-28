// A state control that fails after spawning a child that waits for a go-file
// it will never get. The run must still end promptly with no child left.
import { it } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnStateChild } from '../state-children.js';

it('fails before writing the go-file', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stall-run-')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
  const child = spawnStateChild(['stress', '1', join(root, 'go-never-written')], { ...env, HOME: root, BORG_STATE_ROOT: root });
  writeFileSync(process.env.STALL_FIXTURE_PID_FILE!, String(child.pid));
  throw new Error('forced failure before the go-file');
});
