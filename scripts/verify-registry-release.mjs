import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_NAME = 'borgmcp';
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

async function requestRegistry(path) {
  return fetch(`${REGISTRY}/${path}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
}

async function responseJson(response, description) {
  if (!response.ok) throw new Error(`${description} returned HTTP ${response.status}.`);
  return response.json();
}

export function verifyArtifactReport(report, expectedVersion) {
  if (report?.name !== PACKAGE_NAME) {
    throw new Error(`Release candidate package must be ${PACKAGE_NAME}.`);
  }
  if (typeof report.version !== 'string' || report.version !== expectedVersion) {
    throw new Error(`Release candidate version must be exactly ${expectedVersion}.`);
  }
  if (!INTEGRITY_RE.test(report.integrity ?? '') ||
      Buffer.from(report.integrity.slice('sha512-'.length), 'base64').byteLength !== 64) {
    throw new Error('Release candidate must have a full SHA-512 integrity.');
  }
  return { name: report.name, version: report.version, integrity: report.integrity };
}

export function verifyOwner(packument, expectedOwner) {
  if (!expectedOwner) throw new Error('NPM_EXPECTED_OWNER must be configured in the protected environment.');
  const maintainers = (packument?.maintainers ?? []).map((maintainer) => maintainer.name).sort();
  if (maintainers.length !== 1 || maintainers[0] !== expectedOwner) {
    throw new Error(`Package ownership differs from the reviewed owner; registry maintainers: ${maintainers.join(', ')}`);
  }
}

export async function verifyPrepublish(
  report,
  {
    expectedVersion = report?.version,
    expectedOwner,
    request = requestRegistry,
  } = {},
) {
  const artifact = verifyArtifactReport(report, expectedVersion);
  const versionResponse = await request(
    `${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`,
  );
  if (versionResponse.status !== 404) {
    if (versionResponse.ok) throw new Error(`${artifact.name}@${artifact.version} already exists and is immutable.`);
    throw new Error(`Version availability check returned HTTP ${versionResponse.status}.`);
  }
  const packageResponse = await request(encodeURIComponent(artifact.name));
  if (packageResponse.status === 404) {
    throw new Error(`${artifact.name} is unexpectedly unclaimed; do not bootstrap package ownership from this workflow.`);
  }
  verifyOwner(await responseJson(packageResponse, 'Package ownership check'), expectedOwner);
  return { name: artifact.name, version: artifact.version, registryState: 'owned' };
}

export async function verifyPostpublish(
  report,
  {
    expectedVersion = report?.version,
    request = requestRegistry,
    wait = delay,
    attempts = 12,
    intervalMs = 5_000,
  } = {},
) {
  const artifact = verifyArtifactReport(report, expectedVersion);
  if (!Number.isSafeInteger(attempts) || attempts < 1 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new Error('Registry visibility retry bounds are invalid.');
  }
  let versionResponse;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    versionResponse = await request(
      `${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`,
    );
    if (versionResponse.ok) break;
    if (versionResponse.status !== 404 || attempt === attempts) {
      throw new Error(`Published version verification returned HTTP ${versionResponse.status}.`);
    }
    await wait(intervalMs);
  }
  const published = await responseJson(versionResponse, 'Published version verification');
  if (published.dist?.integrity !== artifact.integrity) {
    throw new Error(`Registry integrity mismatch: expected ${artifact.integrity}, received ${published.dist?.integrity}.`);
  }
  return {
    name: artifact.name,
    version: artifact.version,
    integrity: artifact.integrity,
    registryState: 'verified',
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [mode, reportPath] = process.argv.slice(2);
  if (!['prepublish', 'postpublish'].includes(mode) || !reportPath) {
    throw new Error('Usage: node scripts/verify-registry-release.mjs <prepublish|postpublish> <artifact-report.json>');
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const expectedVersion = process.env.EXPECTED_VERSION;
  if (!expectedVersion) throw new Error('EXPECTED_VERSION is required.');
  const result = mode === 'prepublish'
    ? await verifyPrepublish(report, {
        expectedVersion,
        expectedOwner: process.env.NPM_EXPECTED_OWNER,
      })
    : await verifyPostpublish(report, { expectedVersion });
  console.log(JSON.stringify(result, null, 2));
}
