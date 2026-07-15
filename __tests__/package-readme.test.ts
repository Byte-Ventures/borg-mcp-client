import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const retiredRoleNames = [
  'QA Tester',
  'Documentation Expert',
  'UX Expert',
  'UI Designer',
  'Product Manager',
  'Visionary',
];

function readTarEntry(tarball: string, entryName: string): string {
  const archive = gunzipSync(readFileSync(tarball));

  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0',
      8,
    );
    const bodyOffset = offset + 512;

    if (path === entryName) {
      return archive.subarray(bodyOffset, bodyOffset + size).toString('utf8');
    }

    offset = bodyOffset + Math.ceil(size / 512) * 512;
  }

  throw new Error(`${entryName} is missing from ${tarball}`);
}

describe('published package artifact', () => {
  it('contains no retired role names (gh#1044)', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'borgmcp-pack-readme-'));

    try {
      const packResult = JSON.parse(
        execFileSync(
          process.platform === 'win32' ? 'npm.cmd' : 'npm',
          ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
          { cwd: clientRoot, encoding: 'utf8' },
        ),
      ) as Array<{ filename: string }>;
      const tarball = join(packDir, packResult[0].filename);
      const packedReadme = readTarEntry(tarball, 'package/README.md');
      const staleRoleNames = retiredRoleNames.filter((roleName) =>
        packedReadme.includes(roleName),
      );

      expect(
        staleRoleNames,
        `Packed README contains retired role name(s): ${staleRoleNames.join(', ')}`,
      ).toEqual([]);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it('advertises every supported coding agent in packed metadata', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'borgmcp-pack-metadata-'));

    try {
      const packResult = JSON.parse(
        execFileSync(
          process.platform === 'win32' ? 'npm.cmd' : 'npm',
          ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
          { cwd: clientRoot, encoding: 'utf8' },
        ),
      ) as Array<{ filename: string }>;
      const tarball = join(packDir, packResult[0].filename);
      const packedManifest = JSON.parse(
        readTarEntry(tarball, 'package/package.json'),
      ) as { description?: string };

      expect(packedManifest.description).toContain('Claude Code');
      expect(packedManifest.description).toContain('Codex');
      expect(packedManifest.description).toContain('OpenCode');
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
