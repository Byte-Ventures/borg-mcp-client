/**
 * Egress guard — proves the Borg CLOUD surface is unreachable by construction
 * from the shipped artifact (blocker-2 severance).
 *
 * Scans the shipped SOURCE (`src/**\/*.ts`), the shipped DOCS/METADATA
 * (`README.md`, `docs/**\/*.md`, `package.json`), and — when a build is present
 * — the built `dist/`, asserting that no hosted-URL literal, OAuth/device-flow
 * import, subscription/dashboard/checkout reference, health-beat wiring, report
 * tool, or deleted-module import/mirror survives. Content is scanned RAW (no
 * comment stripping): stale Cloud/OAuth prose in comments is a finding too.
 *
 * The authoritative scan of the actually-packed tarball lives in
 * scripts/verify-packed-artifact.mjs (post-build/pack); this unit test covers
 * everything available without a build.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const DOCS_DIR = path.join(ROOT, 'docs');
const DIST_DIR = path.join(ROOT, 'dist');

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const SRC_FILES = listFiles(SRC_DIR, ['.ts']);
const readAll = (files: string[], base: string) =>
  files.map((f) => ({ file: path.relative(base, f), text: readFileSync(f, 'utf8') }));

// Deleted cloud-only modules — must have NO import and NO dist mirror.
const DELETED_MODULES = [
  'auth',
  'auth-recovery',
  'authority',
  'device-auth',
  'health-beat',
  'setup-authority',
  'setup-action',
  'subscription-retry',
  'token-crypto',
  'stale-version-check',
  'get-started',
];

// The hosted product URLs a local-only client must never link to or construct.
const HOSTED_URL_NEEDLES = [
  'api.borgmcp.ai',
  'borgmcp.ai/dashboard',
  'borgmcp.ai/get-started',
  'borgmcp.ai/pricing',
  'borgmcp.ai/account',
  'borgmcp.ai/upgrade',
  'borgmcp.ai/subscribe',
];

// Reachable-cloud identifiers (OAuth / billing / dashboard / reports).
const CLOUD_SYMBOL_NEEDLES = [
  'googleapis.com',
  'accounts.google.com',
  'authenticateWithGoogle',
  'refreshIdToken',
  'getValidToken',
  'storeIdToken',
  'storeRefreshToken',
  'google-id-token',
  'google-refresh-token',
  'device_grant',
  '/api/subscribe',
  '/api/subscription',
  'checkout_url',
  'portal_url',
  'stripe',
  'Stripe',
  'borg_subscribe',
  'borg_upgrade',
  'borg_subscription_status',
  'borg_open_dashboard',
  'borg_report-friction',
  'borg_reports',
  'submitReport',
  'fetchReports',
  // No hosted dashboard, and no automatic npm-registry runtime egress.
  'dashboard',
  'registry.npmjs.org',
  'fetchLatestBorgmcpVersion',
];

function scan(entries: { file: string; text: string }[], needles: string[]): string[] {
  const offenders: string[] = [];
  for (const { file, text } of entries) {
    for (const needle of needles) {
      if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
  }
  return offenders;
}

describe('no-cloud-egress guard (blocker-2, packed-artifact scope)', () => {
  it('has source files to scan', () => {
    expect(SRC_FILES.length).toBeGreaterThan(20);
  });

  it('no hosted product URL appears in shipped src', () => {
    expect(scan(readAll(SRC_FILES, SRC_DIR), HOSTED_URL_NEEDLES)).toEqual([]);
  });

  it('no OAuth / subscription / dashboard / report identifier appears in shipped src (raw, comments included)', () => {
    expect(scan(readAll(SRC_FILES, SRC_DIR), CLOUD_SYMBOL_NEEDLES)).toEqual([]);
  });

  it('no import or reference to a deleted cloud-only module remains in src', () => {
    const offenders: string[] = [];
    for (const { file, text } of readAll(SRC_FILES, SRC_DIR)) {
      for (const mod of DELETED_MODULES) {
        if (text.includes(`'./${mod}.js'`) || text.includes(`"./${mod}.js"`)) {
          offenders.push(`${file}: ./${mod}.js`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shipped docs + package metadata carry no hosted product URL or Cloud journey', () => {
    const docFiles = [
      path.join(ROOT, 'README.md'),
      path.join(ROOT, 'package.json'),
      ...listFiles(DOCS_DIR, ['.md']),
    ].filter(existsSync);
    // borgmcp.ai product links are forbidden; the GitHub repo is allowed. Assert
    // no bare `//borgmcp.ai` host (the marketing/product/API site) survives.
    const offenders: string[] = [];
    for (const f of docFiles) {
      const text = readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      if (/\/\/borgmcp\.ai/.test(text) || /\/\/api\.borgmcp\.ai/.test(text)) {
        offenders.push(`${rel}: borgmcp.ai host link`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('remote-client.ts exports no cloud auth / subscription / report surface', () => {
    const remoteClient = readFileSync(path.join(SRC_DIR, 'remote-client.ts'), 'utf8');
    for (const symbol of [
      'export const API_URL',
      'export async function getValidToken',
      'export async function probeSession',
      'export async function createSubscription',
      'export async function checkSubscriptionStatus',
      'export async function createBillingPortalSession',
      'export async function submitReport',
      'export async function fetchReports',
    ]) {
      expect(remoteClient).not.toContain(symbol);
    }
  });

  it('no health-beat tick wiring survives in startup or index', () => {
    for (const file of ['startup-services.ts', 'index.ts']) {
      const text = readFileSync(path.join(SRC_DIR, file), 'utf8');
      expect(text).not.toContain('startHealthBeatTick');
      expect(text).not.toContain('healthBeat');
    }
  });

  // dist/ is a build artifact; scanned only when a build is present (always in
  // release:check / CI, which build before this runs). The verify-packed-artifact
  // script performs the authoritative post-pack scan regardless.
  const distJs = listFiles(DIST_DIR, ['.js', '.d.ts']);
  it.runIf(distJs.length > 0)('built dist carries no deleted-module mirror', () => {
    const mirrors = DELETED_MODULES.flatMap((m) => ['js', 'd.ts'].map((e) => `${m}.${e}`))
      .filter((name) => existsSync(path.join(DIST_DIR, name)));
    expect(mirrors).toEqual([]);
  });

  it.runIf(distJs.length > 0)('built dist carries no hosted URL, OAuth, subscription, dashboard, or report residue', () => {
    const entries = readAll(distJs, DIST_DIR);
    expect(scan(entries, [...HOSTED_URL_NEEDLES, ...CLOUD_SYMBOL_NEEDLES])).toEqual([]);
  });
});
