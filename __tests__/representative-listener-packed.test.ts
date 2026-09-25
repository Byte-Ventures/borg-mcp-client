/** Packed CLI refusal/help routing; transport journeys run separately with the same packed modules. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const exec = promisify(execFile);
let root: string, cli: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'listener-packed-')));
  env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_'))), HOME: root, XDG_CONFIG_HOME: join(root, '.config') };
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { env });
  const name = JSON.parse(packed.stdout)[0].filename;
  await exec('tar', ['-xzf', join(root, name), '-C', root]);
  await symlink(dirname(dirname(createRequire(import.meta.url).resolve('vitest/package.json'))), join(root, 'package', 'node_modules'));
  cli = join(root, 'package', 'dist', 'claude.js');
}, 30000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it('ships the printed listener commands and routes their flags through the packed CLI', async () => {
  const guide = await readFile(join(root, 'package', 'docs', 'HUMAN_REPRESENTATIVE.md'), 'utf8');
  const printed = guide.match(/^borg representative listen .*$/gm) ?? [];
  expect(printed).toHaveLength(2);
  for (const command of printed) {
    const args = command.replace('<path>', root).replace('<entry_id>', '55555555-5555-4555-8555-555555555555').split(' ').slice(1);
    const result = await exec(process.execPath, [cli, ...args], { env, cwd: root }).catch(error => error);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ event: 'refused', code: 'NOT_PREPARED', exit_code: 2 });
  }
  const help = await exec(process.execPath, [cli, 'representative', 'listen', '--help'], { env, cwd: root });
  expect(help.stdout).toContain('listen --worktree <path> [--replay-after <entry_id>]');
  expect(help.stdout).toContain('body-free JSON wake hints');
});
it('reserves stdout for a typed usage refusal', async () => {
  const result = await exec(process.execPath, [cli, 'representative', 'listen', '--replay-after', 'bad'], { env, cwd: root }).catch(error => error);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({ event: 'refused', code: 'INVALID_INPUT', exit_code: 2 });
});
