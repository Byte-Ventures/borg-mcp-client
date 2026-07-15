import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const cli = fileURLToPath(new URL('dist/claude.js', root));
const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 10_000 });
const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10_000 });
const assimilateHelp = execFileSync(process.execPath, [cli, 'assimilate', '--help'], {
  encoding: 'utf8',
  timeout: 10_000,
});
if (!version.includes(manifest.version)) throw new Error('borg --version did not report the package version.');
if (!help.includes('assimilate') || !assimilateHelp.includes('--host')) {
  throw new Error('borg --help is missing standalone onboarding guidance.');
}
