import { chmod, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
for (const target of Object.values(manifest.bin)) {
  await chmod(new URL(String(target).replace(/^\.\//, ''), root), 0o755);
}
