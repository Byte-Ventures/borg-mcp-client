import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyReleaseTrigger({ eventName, refType, refName, version }) {
  if (eventName !== 'push') throw new Error('Release candidates require a tag push event.');
  if (refType !== 'tag') throw new Error('Release candidates require a tag ref.');
  if (!/^v\d+\.\d+\.\d+$/.test(refName ?? '')) {
    throw new Error('Release candidate tag must be v<major>.<minor>.<patch>.');
  }
  if (refName !== `v${version}`) {
    throw new Error(`Release candidate tag must exactly match package version ${version}.`);
  }
  return { tag: refName, version };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const result = verifyReleaseTrigger({
    eventName: process.env.GITHUB_EVENT_NAME,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    version: manifest.version,
  });
  console.log(JSON.stringify(result));
}
