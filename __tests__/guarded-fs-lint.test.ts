/**
 * Lint control for the I/O-layer isolation rule: outside src/guarded-fs.ts,
 * src may import only READ-only names from the fs modules, never an fs
 * namespace, default or `promises` object, never require/dynamic-import fs,
 * and never construct a SQLite database directly. Every mutation therefore
 * goes through assertTestWritable.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const READ_ONLY = new Set([
  'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync', 'realpathSync', 'accessSync', 'fstatSync',
  'readSync', 'closeSync', 'fsyncSync', 'constants',
  // Descriptor-only operations: the descriptor itself came from a guarded open.
  'writeSync', 'fchmodSync', 'ftruncateSync',
  'readFile', 'readdir', 'lstat', 'stat', 'realpath', 'access',
  'type Stats', 'type Dirent', 'type PathLike', 'type FileHandle', 'type Stats as FsStats',
]);
const FS_MODULE = /^(node:)?fs(\/promises)?$/;

export function fsViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const importRe = /import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gs;
  for (const match of source.matchAll(importRe)) {
    if (!FS_MODULE.test(match[2])) continue;
    const clause = match[1].trim();
    if (/^type\s*\{/.test(clause)) continue; // type-only imports carry no runtime function
    const named = /^\{([^}]*)\}$/s.exec(clause);
    if (!named) { violations.push(`${file}: fs namespace or default import "${clause}"`); continue; }
    for (const raw of named[1].split(',').map((name) => name.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
      if (!READ_ONLY.has(raw)) violations.push(`${file}: imports ${raw} from ${match[2]}`);
    }
  }
  if (/require\(\s*['"](node:)?fs(\/promises)?['"]\s*\)/.test(source)) violations.push(`${file}: require of fs`);
  if (/import\(\s*['"](node:)?fs(\/promises)?['"]\s*\)/.test(source)) violations.push(`${file}: dynamic import of fs`);
  if (/new\s+DatabaseSync\s*\(/.test(source)) violations.push(`${file}: constructs DatabaseSync directly (use openSqlite)`);
  return violations;
}

describe('every filesystem mutation in src goes through guarded-fs', () => {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && name !== 'guarded-fs.ts');

  it('finds no fs mutation import, fs namespace, fs require or direct SQLite open outside guarded-fs', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((name) => fsViolations(name, readFileSync(join('src', name), 'utf8')))).toEqual([]);
  });

  it.each([
    ["import { writeFileSync } from 'node:fs';", 'imports writeFileSync'],
    ["import { readFile, rename } from 'node:fs/promises';", 'imports rename'],
    ["import fs from 'fs';", 'namespace or default import'],
    ["import * as fs from 'node:fs';", 'namespace or default import'],
    ["import { promises as fs } from 'node:fs';", 'imports promises as fs'],
    ["import {\n  createWriteStream,\n  readFileSync,\n} from 'node:fs';", 'imports createWriteStream'],
    ["const fs = require('fs');", 'require of fs'],
    ["const fs = await import('node:fs/promises');", 'dynamic import of fs'],
    ['const db = new DatabaseSync(path);', 'constructs DatabaseSync directly'],
  ])('flags %j', (source, expected) => {
    expect(fsViolations('probe.ts', source).join('\n')).toContain(expected);
  });

  it('accepts read-only fs imports', () => {
    expect(fsViolations('probe.ts', "import { readFileSync, lstatSync, type Stats } from 'node:fs';")).toEqual([]);
  });
});
