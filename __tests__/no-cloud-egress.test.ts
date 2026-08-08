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

type DashboardOccurrence = { file: string; line: string };

const DASHBOARD_ALLOWLIST = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts', 'local-dashboard-occurrences.json'), 'utf8'),
) as DashboardOccurrence[];
const dashboardOccurrenceKey = ({ file, line }: DashboardOccurrence) =>
  JSON.stringify([file, line]);
const DASHBOARD_ALLOWLIST_KEYS = new Set(DASHBOARD_ALLOWLIST.map(dashboardOccurrenceKey));

if (DASHBOARD_ALLOWLIST_KEYS.size !== DASHBOARD_ALLOWLIST.length) {
  throw new Error('Local dashboard occurrence allowlist contains duplicate entries.');
}

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
  // Hosted dashboard identifiers are covered above without banning the local
  // operator dashboard command. Explicit npm-registry egress is checked
  // separately and is allowed only in the operator-selected update command.
  'fetchLatestBorgmcpVersion',
];

const LEGACY_AUTHORITY_ROUTE = /\/api\/(?:drone(?:\/|[?'"`])|drones\/|roles\/|templates(?:\/|[?'"`])|assimilate(?:[?'"`]))/;
const LEGACY_AUTHORIZATION_COPY = /\bowner-scoped\b|\bcube ownership\b|\bRLS\b|\bcubes? owned by\b|USER\/OWNER|NON-OWNER|OWNER's|caller owns|owner level/i;

function scan(entries: { file: string; text: string }[], needles: string[]): string[] {
  const offenders: string[] = [];
  for (const { file, text } of entries) {
    for (const needle of needles) {
      if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
    }
  }
  return offenders;
}

function scanExplicitNpmRegistry(entries: { file: string; text: string }[]): string[] {
  const allowed = new Set(['update-cmd.ts', 'update-cmd.js']);
  const offenders: string[] = [];
  for (const { file, text } of entries) {
    const count = text.split('registry.npmjs.org').length - 1;
    if (count === 0) continue;
    if (!allowed.has(file) || count !== 1) offenders.push(`${file}: ${count}`);
  }
  return offenders;
}

function scanDashboardOccurrences(entries: { file: string; text: string }[]) {
  const offenders: string[] = [];
  const approved = new Set<string>();
  for (const { file, text } of entries) {
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
      if (!rawLine.includes('dashboard')) continue;
      const occurrence = { file, line: rawLine.trim() };
      const key = dashboardOccurrenceKey(occurrence);
      if (DASHBOARD_ALLOWLIST_KEYS.has(key)) approved.add(key);
      else offenders.push(`${file}:${index + 1}: dashboard`);
    }
  }
  return { approved, offenders };
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

  it('allows canonical npm egress only in the explicit update command', () => {
    const entries = readAll(SRC_FILES, SRC_DIR);
    expect(scanExplicitNpmRegistry(entries)).toEqual([]);
    expect(entries.find(({ file }) => file === 'update-cmd.ts')?.text)
      .toContain('https://registry.npmjs.org/');
  });

  it('permits only the exact local dashboard source occurrences', () => {
    const result = scanDashboardOccurrences(readAll(SRC_FILES, ROOT));
    const expected = DASHBOARD_ALLOWLIST
      .filter(({ file }) => file.startsWith('src/'))
      .map(dashboardOccurrenceKey);
    expect(result.offenders).toEqual([]);
    expect([...result.approved].sort()).toEqual(expected.sort());
  });

  it('rejects a hosted dashboard subdomain through the bare-token guard', () => {
    const result = scanDashboardOccurrences([{
      file: 'src/review-control.ts',
      text: '// review-control: https://dashboard.borgmcp.ai\n',
    }]);
    expect(result.offenders).toEqual(['src/review-control.ts:1: dashboard']);
  });

  it('no legacy authority route family appears in shipped src', () => {
    const offenders = readAll(SRC_FILES, SRC_DIR)
      .filter(({ text }) => LEGACY_AUTHORITY_ROUTE.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('agent-visible authorization copy uses live cube grants, not ownership or role labels', () => {
    for (const file of ['tool-manifest.ts', 'tool-scope.ts', 'remote-client.ts']) {
      expect(readFileSync(path.join(SRC_DIR, file), 'utf8')).not.toMatch(LEGACY_AUTHORIZATION_COPY);
    }
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

  it.runIf(distJs.length > 0)('built dist limits canonical npm egress to the explicit update command', () => {
    const entries = readAll(distJs, DIST_DIR);
    expect(scanExplicitNpmRegistry(entries)).toEqual([]);
    expect(entries.find(({ file }) => file === 'update-cmd.js')?.text)
      .toContain('https://registry.npmjs.org/');
  });

  it.runIf(distJs.length > 0)('built dist permits only the exact local dashboard occurrences', () => {
    const result = scanDashboardOccurrences(readAll(distJs, ROOT));
    const expected = DASHBOARD_ALLOWLIST
      .filter(({ file }) => file.startsWith('dist/'))
      .map(dashboardOccurrenceKey);
    expect(result.offenders).toEqual([]);
    expect([...result.approved].sort()).toEqual(expected.sort());
  });

  it.runIf(distJs.length > 0)('built dist carries no legacy authority route family', () => {
    const offenders = readAll(distJs, DIST_DIR)
      .filter(({ text }) => LEGACY_AUTHORITY_ROUTE.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
