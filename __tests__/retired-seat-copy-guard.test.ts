/**
 * Copy-contract guard — the client migrated OFF the OS keychain / `cubes.json`
 * seat model onto a LOCAL 0600-permission seat store. This test fails if any
 * OPERATOR-FACING surface (rendered CLI help, shipped `README.md`/`docs/**.md`,
 * or a user-facing CLI error string) reintroduces the retired keychain/cubes.json
 * recovery model, or the retired live-unsafe stop→invite→restart enrollment route.
 *
 * Precision note: internal `src/**.ts` COMMENTS still legitimately name the
 * retired machinery (`withServerKeychainLock`, "keychain loss", the historical
 * `cubes.json` project file) to describe how the code works. This guard therefore
 * targets:
 *   - docs + rendered help: ZERO `keychain` / `cubes.json` (pure operator prose);
 *   - src strings: only IMPERATIVE keychain-management ADVICE and the retired
 *     "cubes.json binding" phrasing — patterns that never appear in the accurate
 *     internal comments, so they do not false-positive.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  topLevelHelpText,
  assimilateHelpText,
  resetLocalSeatHelpText,
  setupHelpText,
} from '../src/cli-help.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

// Operator-facing prose (help + docs): NO retired seat vocabulary at all.
const RETIRED_PROSE_TERMS: RegExp[] = [
  /\bkeychain\b/i,
  /\bcubes\.json\b/i,
];

// The retired live-unsafe route: stop/restart a RUNNING server merely to mint an
// enrollment invitation. The ratified route keeps the server running. Legitimate
// "start or restart an UNREACHABLE server" and "stop+restart an intentionally
// re-initialized server" stay allowed — those bullets never sit an invitation
// within the window below.
const STOP_INVITE_RESTART: RegExp[] = [
  /\b(?:stop|restart)\b[^.\n]{0,160}\binvit(?:e|ation)\b/i,
  /\binvit(?:e|ation)\b[^.\n]{0,160}\b(?:stop|restart) the server\b/i,
];

// Imperative keychain-management ADVICE / retired binding phrasing in any shipped
// source string. These forms appear ONLY in user-facing copy, never in the
// accurate internal comments.
const RETIRED_SRC_ADVICE: RegExp[] = [
  // Keychain-management advice / retired binding phrasing.
  /unlock (?:or (?:enable|restore) )?the [^.\n]*keychain/i,
  /restore the [^.\n]*keychain/i,
  /(?:access|enable) the OS keychain/i,
  /OS keychain is busy/i,
  /cubes\.json binding/i,
  /keychain session credential/i,
  // Retired cubes.json seat-file directives (seats now live in the seat store,
  // not cubes.json). These imperative phrasings appear only in operator copy,
  // never in the accurate historical comments that still name the old file.
  /found in cubes\.json/i,
  /cubes in cubes\.json/i,
  /\b(?:remove|clear|delete|edit)\b[^\n]{0,60}\bcubes\.json/i,
  /cubes\.json entry has malformed/i,
  /\bno cubes\.json seat\b/i,
];

describe('retired keychain / cubes.json copy contract', () => {
  it('rendered CLI help exposes no retired keychain / cubes.json seat vocabulary', () => {
    const helps: Array<[string, string]> = [
      ['topLevelHelpText', topLevelHelpText('9.9.9')],
      ['assimilateHelpText', assimilateHelpText('9.9.9')],
      ['resetLocalSeatHelpText', resetLocalSeatHelpText('9.9.9')],
      ['setupHelpText', setupHelpText('9.9.9')],
    ];
    for (const [name, text] of helps) {
      for (const term of RETIRED_PROSE_TERMS) {
        expect(term.test(text), `${name} contains retired term ${term}`).toBe(false);
      }
    }
  });

  it('shipped operator docs contain no retired keychain / cubes.json guidance', () => {
    const docs = [path.join(ROOT, 'README.md'), ...listFiles(path.join(ROOT, 'docs'), '.md')];
    for (const file of docs) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      for (const term of RETIRED_PROSE_TERMS) {
        expect(term.test(text), `${rel} contains retired term ${term}`).toBe(false);
      }
    }
  });

  it('shipped operator docs never route enrollment through a stop/restart of a running server', () => {
    const docs = [path.join(ROOT, 'README.md'), ...listFiles(path.join(ROOT, 'docs'), '.md')];
    for (const file of docs) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      for (const term of STOP_INVITE_RESTART) {
        expect(term.test(text), `${rel} contains the retired stop→invite→restart route ${term}`).toBe(false);
      }
    }
  });

  it('no shipped source string advises keychain management or the retired cubes.json binding', () => {
    for (const file of listFiles(path.join(ROOT, 'src'), '.ts')) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      for (const term of RETIRED_SRC_ADVICE) {
        expect(term.test(text), `${rel} contains retired user-facing advice ${term}`).toBe(false);
      }
    }
  });
});
