import { readFileSync } from 'node:fs';

const VERSION_PATTERN = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
const MINIMUM_PATTERN = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/;

function parseVersion(value, pattern = VERSION_PATTERN) {
  if (typeof value !== 'string') return null;
  const match = pattern.exec(value);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function satisfiesNodeRequirement(version, requirement) {
  const actual = parseVersion(version);
  const minimum = parseVersion(requirement, MINIMUM_PATTERN);
  if (!actual || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const requirement = manifest?.engines?.node;
const actual = process.versions.node;

if (!satisfiesNodeRequirement(actual, requirement)) {
  if (!parseVersion(requirement, MINIMUM_PATTERN)) {
    console.error(
      `Cannot verify Node.js version: package.json engines.node must be a >=major.minor.patch requirement (received ${JSON.stringify(requirement)}).`,
    );
  } else {
    console.error(`borgmcp requires Node.js ${requirement}; found Node.js ${actual}.`);
  }
  process.exitCode = 1;
}
