import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const [sourceArgument, outputArgument = 'provenance/extraction-map.json'] = process.argv.slice(2);
if (!sourceArgument) throw new Error('Usage: node scripts/generate-extraction-map.mjs <source-client-root> [output]');
const sourceRoot = resolve(sourceArgument);
const destinationRoot = resolve('.');
const output = resolve(outputArgument);
const sourceSha = '17ff8ce14e12122a8cc9089f6b94174c02fa2a04';
const replacedByShared = new Set(['src/templates.ts', 'src/role-section.ts', 'src/drone-address.ts']);
const excluded = new Set([
  '.env.example',
  '.gitignore',
  'LICENSE',
  'package-lock.json',
  'scripts/minify-dist.js',
  'vitest.integration.config.ts',
]);

async function files(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(relative(root, path).split('\\').join('/'));
  }
  return result;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

const entries = [];
for (const sourcePath of (await files(sourceRoot)).sort()) {
  let destinationPath = sourcePath;
  let status = 'excluded-private-integration';
  if (replacedByShared.has(sourcePath)) {
    status = 'replaced-by-borgmcp-shared';
    destinationPath = null;
  } else if (excluded.has(sourcePath)) {
    status = 'excluded-standalone-boundary';
    destinationPath = null;
  } else if (sourcePath.startsWith('__tests__/integration/')) {
    destinationPath = null;
  } else {
    const destination = join(destinationRoot, destinationPath);
    try {
      const destinationMetadata = await stat(destination);
      if (!destinationMetadata.isFile()) throw new Error('not a file');
      status = await sha256(join(sourceRoot, sourcePath)) === await sha256(destination)
        ? 'copied-byte-identical'
        : 'transformed-for-standalone-boundary';
    } catch {
      status = 'missing';
    }
  }
  entries.push({
    source: `client/${sourcePath}`,
    destination: destinationPath,
    status,
    source_sha256: await sha256(join(sourceRoot, sourcePath)),
    destination_sha256: destinationPath && status !== 'missing'
      ? await sha256(join(destinationRoot, destinationPath))
      : null,
  });
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  source_repository: 'Byte-Ventures/borg-mcp',
  source_commit: sourceSha,
  destination_repository: 'Byte-Ventures/borg-mcp-client',
  imported_history: false,
  entries,
}, null, 2)}\n`);
