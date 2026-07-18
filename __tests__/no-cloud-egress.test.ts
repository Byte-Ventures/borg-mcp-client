/**
 * Egress guard — proves the Borg CLOUD surface is unreachable by construction
 * from the shipped runtime (blocker-2 severance).
 *
 * Scans every shipped `src/**\/*.ts` file (tests excluded) and asserts that no
 * hosted-URL literal, OAuth/device-flow import, subscription/dashboard/checkout
 * reference, health-beat wiring, or deleted-module import survives. If any of
 * these reappear, the cloud path has been re-linked and this test fails.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function listSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSrcFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SRC_FILES = listSrcFiles(SRC_DIR);
const readAll = () => SRC_FILES.map((f) => ({ file: path.relative(SRC_DIR, f), text: readFileSync(f, 'utf8') }));

/** Strip block + line comments so scans target actual code, not documentation. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const readCode = () =>
  SRC_FILES.map((f) => ({ file: path.relative(SRC_DIR, f), text: stripComments(readFileSync(f, 'utf8')) }));

describe('no-cloud-egress guard (blocker-2)', () => {
  it('has source files to scan', () => {
    expect(SRC_FILES.length).toBeGreaterThan(20);
  });

  it('the hosted API literal api.borgmcp.ai appears in ZERO shipped src files', () => {
    const offenders = readAll().filter(({ text }) => text.includes('api.borgmcp.ai'));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it('no dashboard / subscription / checkout / Stripe reference on a runtime path', () => {
    const forbidden = [
      'borgmcp.ai/dashboard',
      '/api/subscribe',
      '/api/subscription',
      'checkout_url',
      'portal_url',
      'stripe',
      'Stripe',
    ];
    const offenders: string[] = [];
    for (const { file, text } of readCode()) {
      for (const needle of forbidden) {
        if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Google OAuth endpoint or deleted OAuth symbol on a runtime path', () => {
    // Precise runtime signals (comment-stripped so docs/redaction regexes are
    // not false-flagged). These are the actual reachable-cloud identifiers.
    const forbidden = [
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
    ];
    const offenders: string[] = [];
    for (const { file, text } of readCode()) {
      for (const needle of forbidden) {
        if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no import of a deleted cloud-only module remains in src', () => {
    const deletedModules = [
      './auth.js',
      './device-auth.js',
      './health-beat.js',
      './setup-authority.js',
      './setup-action.js',
      './subscription-retry.js',
      './token-crypto.js',
      './authority.js',
    ];
    const offenders: string[] = [];
    for (const { file, text } of readAll()) {
      for (const mod of deletedModules) {
        // Match `from './auth.js'` / `import('./auth.js')` style references.
        if (text.includes(`'${mod}'`) || text.includes(`"${mod}"`)) {
          offenders.push(`${file}: ${mod}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the MCP tool manifest contains no cloud tool', () => {
    const manifest = readFileSync(path.join(SRC_DIR, 'tool-manifest.ts'), 'utf8');
    for (const tool of ['borg_subscribe', 'borg_upgrade-subscription', 'borg_upgrade', 'borg_subscription_status', 'borg_open_dashboard']) {
      expect(manifest).not.toContain(tool);
    }
  });

  it('remote-client.ts exports no cloud auth / subscription surface', () => {
    const remoteClient = readFileSync(path.join(SRC_DIR, 'remote-client.ts'), 'utf8');
    for (const symbol of [
      'export const API_URL',
      'export async function getValidToken',
      'export async function probeSession',
      'export async function createSubscription',
      'export async function checkSubscriptionStatus',
      'export async function createBillingPortalSession',
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
});
