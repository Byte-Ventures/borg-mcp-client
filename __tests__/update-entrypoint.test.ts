import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRYPOINT = join(ROOT, 'dist', 'claude.js');
const ENV = { ...process.env, CI: '1', NO_COLOR: '1' };

function run(command: 'update' | 'upgrade', arg: '--help' | '--force') {
  return spawnSync(process.execPath, [ENTRYPOINT, command, arg], {
    env: ENV,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('built update entrypoint alias', () => {
  it('renders byte-identical command help', () => {
    const update = run('update', '--help');
    const upgrade = run('upgrade', '--help');

    expect(update.error).toBeUndefined();
    expect(upgrade.error).toBeUndefined();
    expect(update.status).toBe(0);
    expect(upgrade.status).toBe(update.status);
    expect(upgrade.stdout).toBe(update.stdout);
    expect(update.stdout).toContain('borg update');
    expect(upgrade.stderr).toBe(update.stderr);
    expect(update.stderr).toBe('');
  });

  it('rejects unsupported arguments with byte-identical canonical diagnostics', () => {
    const update = run('update', '--force');
    const upgrade = run('upgrade', '--force');

    expect(update.error).toBeUndefined();
    expect(upgrade.error).toBeUndefined();
    expect(update.status).toBe(1);
    expect(upgrade.status).toBe(update.status);
    expect(upgrade.stdout).toBe(update.stdout);
    expect(update.stdout).toBe('');
    expect(upgrade.stderr).toBe(update.stderr);
    expect(update.stderr).toBe('unknown option: --force\nRun `borg update --help` for usage.\n');
  });
});
