/**
 * Lint control for the I/O-layer isolation rule, syntax-aware (TypeScript
 * parser, so spacing and aliases do not matter): outside src/guarded-fs.ts,
 * src may import only READ-only names from the fs modules, never an fs
 * namespace, default or `promises` object, never require/dynamic-import or
 * re-export fs, never import node:sqlite values, and never construct a SQLite
 * database directly (whatever the constructor is called). Every mutation
 * therefore goes through assertTestWritable.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const READ_ONLY = new Set([
  'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'existsSync', 'realpathSync', 'readlinkSync', 'accessSync',
  'fstatSync', 'readSync', 'closeSync', 'fsyncSync', 'constants',
  // Descriptor-only operations: the descriptor itself came from a guarded write-mode open.
  'writeSync', 'fchmodSync', 'ftruncateSync',
  'readFile', 'readdir', 'lstat', 'stat', 'realpath', 'readlink', 'access',
]);
const FS_MODULE = /^(node:)?fs(\/promises)?$/;
const SQLITE_MODULE = /^(node:)?sqlite$/;

export function fsViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const sqliteConstructors = new Set(['DatabaseSync']);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const moduleText = (node: ts.Expression | undefined) => (node && ts.isStringLiteral(node) ? node.text : '');

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const from = moduleText(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly && (FS_MODULE.test(from) || SQLITE_MODULE.test(from))) {
        if (clause.name) violations.push(`${file}: default import ${clause.name.text} from ${from}`);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) violations.push(`${file}: namespace import ${bindings.name.text} from ${from}`);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            const imported = (element.propertyName ?? element.name).text;
            if (SQLITE_MODULE.test(from)) {
              violations.push(`${file}: imports ${imported} from ${from}`);
              if (imported === 'DatabaseSync') sqliteConstructors.add(element.name.text);
            } else if (!READ_ONLY.has(imported)) {
              violations.push(`${file}: imports ${imported} from ${from}`);
            }
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && FS_MODULE.test(moduleText(node.moduleSpecifier))) {
      violations.push(`${file}: re-exports from ${moduleText(node.moduleSpecifier)}`);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        FS_MODULE.test(moduleText(node.moduleReference.expression))) {
      violations.push(`${file}: import = require of fs`);
    }
    if (ts.isCallExpression(node)) {
      const target = moduleText(node.arguments[0]);
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isImport) && FS_MODULE.test(target)) violations.push(`${file}: ${isRequire ? 'require' : 'dynamic import'} of fs`);
      if (isRequire && SQLITE_MODULE.test(target)) violations.push(`${file}: require of sqlite`);
    }
    // `const { DatabaseSync: Alias } = ...` makes Alias a SQLite constructor.
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const property = node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text;
      if (property === 'DatabaseSync') sqliteConstructors.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const constructs = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && sqliteConstructors.has(callee.text)) ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === 'DatabaseSync') ||
          (ts.isElementAccessExpression(callee) && moduleText(callee.argumentExpression) === 'DatabaseSync')) {
        violations.push(`${file}: constructs DatabaseSync directly (use openSqlite)`);
      }
    }
    ts.forEachChild(node, constructs);
  };
  constructs(sf);
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
    ["import{writeFileSync}from'node:fs';writeFileSync(p,'x');", 'imports writeFileSync'],
    ["import { readFile, rename } from 'node:fs/promises';", 'imports rename'],
    ["import { lutimesSync as touch } from 'fs';", 'imports lutimesSync'],
    ["import fs from 'fs';", 'default import fs'],
    ["import * as fs from 'node:fs';", 'namespace import fs'],
    ["import { promises as fs } from 'node:fs';", 'imports promises'],
    ["import {\n  createWriteStream,\n  readFileSync,\n} from 'node:fs';", 'imports createWriteStream'],
    ["export { writeFileSync } from 'node:fs';", 're-exports from node:fs'],
    ["const fs = require('fs');", 'require of fs'],
    ["import fs = require('fs');", 'import = require of fs'],
    ["const fs = await import('node:fs/promises');", 'dynamic import of fs'],
    ['const db = new DatabaseSync(path);', 'constructs DatabaseSync directly'],
    ["import { DatabaseSync as DB } from 'node:sqlite'; const db = new DB(path);", 'constructs DatabaseSync directly'],
    ["import { DatabaseSync as DB } from 'node:sqlite';", 'imports DatabaseSync from node:sqlite'],
    ['const { DatabaseSync: D } = await loadSqlite(); const db = new D(path);', 'constructs DatabaseSync directly'],
    ['const sqlite = await loadSqlite(); const db = new sqlite.DatabaseSync(path);', 'constructs DatabaseSync directly'],
    ["const db = new sqlite['DatabaseSync'](path);", 'constructs DatabaseSync directly'],
  ])('flags %j', (source, expected) => {
    expect(fsViolations('probe.ts', source).join('\n')).toContain(expected);
  });

  it('accepts read-only and type-only imports, and the guarded SQLite open', () => {
    expect(fsViolations('probe.ts', [
      "import { readFileSync, lstatSync, type Stats } from 'node:fs';",
      "import type { DatabaseSync } from 'node:sqlite';",
      "import type { Stats as S } from 'fs';",
      'const { DatabaseSync } = await loadSqlite(); const db = openSqlite(DatabaseSync, path);',
    ].join('\n'))).toEqual([]);
  });
});
