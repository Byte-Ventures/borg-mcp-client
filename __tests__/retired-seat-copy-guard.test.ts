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

// Item 7 (release-integrity copy control): shipped operator surfaces must describe
// the PUBLISHED `borgmcp-shared@<pin>` v2 release — never the stale 0.3.0 / `server
// #N` / WIP-preview RELEASE attribution, and never the retired re-attach "retry
// tuple" ROTATION claim (the client bearer is the sole correlator, REUSED not
// rotated). Precise: the accurate publish-timing "preview-only" statement and the
// accurate enrollment/cube-creation `retry_key` line are NOT flagged.
describe('release-status + reattach copy contract (item 7)', () => {
  // The pinned shared version, read from package.json so the guard auto-tracks it.
  const pinnedShared: string = (() => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const v = manifest.dependencies?.['borgmcp-shared'];
    if (typeof v !== 'string') throw new Error('borgmcp-shared pin missing from package.json');
    return v;
  })();

  // STALE RELEASE framing (never in accurate copy). `server #N` = a numbered
  // pre-release server attribution; `\bWIP\b` = work-in-progress release framing.
  const STALE_RELEASE_FRAMING: RegExp[] = [
    /server #\d+/i,
    /\bWIP\b/,
  ];
  // RETIRED re-attach ROTATION claim — scoped so it never matches the accurate
  // enrollment/cube-creation `retry_key`/retry-tuple line (which never says
  // "rotate", and never sits "retry tuple" beside "reattach").
  const REATTACH_ROTATION: RegExp[] = [
    /\brotat\w*\b[^.\n]{0,40}\bretry\b/i,
    /reattach\w*[^.\n]{0,60}retry tuple/i,
  ];

  function surfaces(): Array<[string, string]> {
    const out: Array<[string, string]> = [
      ['topLevelHelpText', topLevelHelpText('9.9.9')],
      ['assimilateHelpText', assimilateHelpText('9.9.9')],
      ['resetLocalSeatHelpText', resetLocalSeatHelpText('9.9.9')],
      ['setupHelpText', setupHelpText('9.9.9')],
    ];
    for (const file of [path.join(ROOT, 'README.md'), ...listFiles(path.join(ROOT, 'docs'), '.md')]) {
      out.push([path.relative(ROOT, file), readFileSync(file, 'utf8')]);
    }
    return out;
  }

  it('every shipped `borgmcp-shared@X.Y.Z` reference equals the pinned version', () => {
    for (const [name, text] of surfaces()) {
      for (const m of text.matchAll(/borgmcp-shared@(\d+\.\d+\.\d+)/g)) {
        expect(m[1], `${name} references borgmcp-shared@${m[1]} (pinned is ${pinnedShared})`).toBe(pinnedShared);
      }
    }
  });

  it('no shipped surface carries stale `server #N` / WIP release framing', () => {
    for (const [name, text] of surfaces()) {
      for (const term of STALE_RELEASE_FRAMING) {
        expect(term.test(text), `${name} contains stale release framing ${term}`).toBe(false);
      }
    }
  });

  it('no shipped surface reintroduces the retired re-attach retry-tuple ROTATION claim', () => {
    for (const [name, text] of surfaces()) {
      for (const term of REATTACH_ROTATION) {
        expect(term.test(text), `${name} contains the retired reattach-rotation claim ${term}`).toBe(false);
      }
    }
  });

  it('the guard does NOT flag the accurate publish-timing "preview" / enrollment retry_key copy', () => {
    // Positive control: accurate phrases that MUST remain allowed.
    for (const term of [...STALE_RELEASE_FRAMING, ...REATTACH_ROTATION]) {
      expect(term.test('the self-hosted path remains preview-only, and the client publish is deferred')).toBe(false);
      expect(term.test('the client generates a 256-bit credential and UUID retry key and persists the exact tuple')).toBe(false);
      expect(term.test('the `retry_key` idempotency key applies to enrollment and cube-creation only')).toBe(false);
    }
    // And the accurate pinned version reference is allowed.
    expect(new RegExp(`borgmcp-shared@${pinnedShared.replace(/\./g, '\\.')}`).test(
      `consumes the published borgmcp-shared@${pinnedShared} v2 registry release`,
    )).toBe(true);
  });

  it('negative control: the guard DOES fire on the stale framing it must catch', () => {
    // server #N / WIP framing.
    expect(STALE_RELEASE_FRAMING.some((r) => r.test('The matching server #5 owner-enrollment'))).toBe(true);
    expect(STALE_RELEASE_FRAMING.some((r) => r.test('This WIP consumes the audited release'))).toBe(true);
    // The retired re-attach ROTATION claim.
    expect(REATTACH_ROTATION.some((r) => r.test('only an authoritative eviction rotates the retry tuple'))).toBe(true);
    expect(REATTACH_ROTATION.some((r) => r.test('reattaches with its durable retry tuple instead of'))).toBe(true);
    // A stale shared-version reference is != pin.
    const stale = '0.3.0';
    expect(stale).not.toBe(pinnedShared);
    expect([...'consumes borgmcp-shared@0.3.0'.matchAll(/borgmcp-shared@(\d+\.\d+\.\d+)/g)][0][1]).toBe(stale);
  });
});
