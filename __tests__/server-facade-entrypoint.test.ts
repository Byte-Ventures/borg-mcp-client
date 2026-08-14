import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('built borg server facade', () => {
  it.each([
    ['client-list', []],
    ['client-grant', ['client-handle', 'cube-id', 'manage']],
    ['service', ['install', '--json']],
    ['service', ['uninstall', '--json']],
  ] as const)('forwards %s through the production entrypoint', async (command, args) => {
    const directory = await mkdtemp(join(tmpdir(), 'borg-server-grant-facade-'));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, 'bin');
    await mkdir(binDirectory);
    const trace = join(directory, 'trace.json');
    const server = join(binDirectory, 'borg-mcp-server');
    await writeFile(server, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.BORG_SERVER_FACADE_TRACE, JSON.stringify(process.argv.slice(2)));
`);
    await chmod(server, 0o755);

    const result = await execFileAsync(
      process.execPath,
      [join(ROOT, 'dist', 'claude.js'), 'server', command, ...args],
      {
        env: {
          ...process.env,
          BORG_SERVER_FACADE_TRACE: trace,
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    await expect(readFile(trace, 'utf8')).resolves.toBe(JSON.stringify([command, ...args]));
  });
});
