import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokePackedClient } from './smoke-packed-client.mjs';
import { verifyPackedArtifact } from './verify-packed-artifact.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'borgmcp-local-release-'));
const runNpm = (args, options = {}) => process.env.npm_execpath
  ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
  : execFileSync('npm', args, options);
const npmVersion = runNpm(['--version'], { cwd: root, encoding: 'utf8' }).trim();
if (npmVersion !== '11.18.0') throw new Error(`Package verification requires npm 11.18.0, found ${npmVersion}.`);
try {
  const packDirectory = join(temporary, 'pack');
  const consumer = join(temporary, 'consumer');
  await mkdir(packDirectory);
  const [packResult] = JSON.parse(runNpm([
    'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory,
  ], { cwd: root, encoding: 'utf8' }));
  const tarball = join(packDirectory, packResult.filename);
  const artifact = await verifyPackedArtifact(tarball, { repositoryRoot: root });
  runNpm([
    'install', '--global', '--prefix', consumer, '--ignore-scripts', '--no-save',
    '--package-lock=false', tarball,
  ], { cwd: root, stdio: 'pipe' });
  runNpm([
    'ls', '--global', '--prefix', consumer, '--omit=dev', '--all', '--package-lock=false',
  ], { cwd: root, stdio: 'pipe' });
  const smoke = await smokePackedClient(join(consumer, 'lib', 'node_modules', 'borgmcp'), {
    binPath: join(consumer, 'bin', 'borg-mcp'),
  });
  console.log(JSON.stringify({ artifact, smoke }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
