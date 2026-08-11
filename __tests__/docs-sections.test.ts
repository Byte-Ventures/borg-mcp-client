import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NEW_CUBE_TEMPLATE_PRESENTATIONS } from 'borgmcp-shared/templates';
import { reattachFailureMessage, reattachOnlyRefusal } from '../src/assimilate-guard.js';
import { DOCS_SECTIONS, matchDocsSections, formatDocsIndex } from '../src/docs-sections';
import { formatSeatReattachRefusal } from '../src/seat-reattach-guard.js';
import { TOOL_MANIFEST } from '../src/tool-manifest';

describe('gh#docs-site B — DOCS_SECTIONS + borg_docs', () => {
  it('keeps the documented cube-init template option independent of shared vocabulary', () => {
    const docs = readFileSync(new URL('../docs/LOCAL_SERVER.md', import.meta.url), 'utf8');
    const match = docs.match(/Relevant options include:\n\n```text\n([\s\S]*?)```/);
    expect(match?.[1]).toContain('--template <name>');
    for (const { name } of NEW_CUBE_TEMPLATE_PRESENTATIONS) {
      expect(match?.[1]).not.toContain(`--template ${name}`);
    }
  });

  it('every section is well-formed and routes to a public documentation URL', () => {
    expect(DOCS_SECTIONS.length).toBeGreaterThan(0);
    for (const s of DOCS_SECTIONS) {
      expect(s.slug).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.summary.trim().length).toBeGreaterThan(0);
      expect(s.url).toMatch(/^https:\/\/(?:borgmcp\.ai|github\.com\/Byte-Ventures\/borg-mcp-client)/);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses distinct content surfaces and grounds the repository-hosted enrollment route', () => {
    expect(new Set(DOCS_SECTIONS.map(({ url }) => url)).size).toBe(DOCS_SECTIONS.length);

    const enroll = DOCS_SECTIONS.find(({ slug }) => slug === 'enroll');
    const enrollmentGuide = readFileSync(new URL('../docs/LOCAL_SERVER.md', import.meta.url), 'utf8');
    expect(enroll?.url).toBe('https://github.com/Byte-Ventures/borg-mcp-client/blob/main/docs/LOCAL_SERVER.md');
    expect(enrollmentGuide).toContain('borg assimilate --host <server> --enroll');
    expect(enrollmentGuide).toContain('grant that enrolled client');

    for (const section of DOCS_SECTIONS.filter(({ slug }) => !['enroll', 'seat-lifecycle'].includes(slug))) {
      expect(new URL(section.url).hostname).toBe('borgmcp.ai');
    }
  });

  it('matchDocsSections routes common topics to the right section', () => {
    expect(matchDocsSections('pricing')[0]?.slug).toBe('faq');
    expect(matchDocsSections('cost free').map((s) => s.slug)).toContain('faq');
    expect(matchDocsSections('license licensing')[0]?.slug).toBe('license');
    expect(matchDocsSections('dashboard monitoring observability')[0]?.slug).toBe('self-hosting');
    expect(matchDocsSections('add agent teammate invite')[0]?.slug).toBe('enroll');
    expect(matchDocsSections('install borgmcp')[0]?.slug).toBe('install');
    expect(matchDocsSections('opencode install').map((s) => s.slug)).toContain('install');
    expect(matchDocsSections('worktree')[0]?.slug).toBe('cli');
    expect(matchDocsSections('worktree cleanup')[0]?.slug).toBe('cli');
    // 'setup assimilate' routed nowhere while the server pages were skeletons;
    // with run-server/enroll live it now routes to the self-hosted flow.
    expect(matchDocsSections('setup assimilate').map((s) => s.slug)).toContain('enroll');
    expect(matchDocsSections('billing cancel subscription')).toEqual([]);
    expect(matchDocsSections('what is a cube').map((s) => s.slug)).toContain('concepts');
    expect(matchDocsSections('codex').map((s) => s.slug)).toContain('faq');
    expect(matchDocsSections('zzzznotarealtopic')).toEqual([]);
    expect(matchDocsSections('')).toEqual([]);
  });

  it('routes self-hosted server topics to run-server / self-hosting / enroll', () => {
    expect(matchDocsSections('run a local server')[0]?.slug).toBe('run-server');
    expect(matchDocsSections('borgmcp-server setup').map((s) => s.slug)).toContain('run-server');
    expect(matchDocsSections('self-hosting backup')[0]?.slug).toBe('self-hosting');
    expect(matchDocsSections('rotate revoke credentials').map((s) => s.slug)).toContain('self-hosting');
    expect(matchDocsSections('enroll invitation')[0]?.slug).toBe('enroll');
    expect(matchDocsSections('assimilate host enroll').map((s) => s.slug)).toContain('enroll');
    expect(matchDocsSections('private LAN TLS').map((s) => s.slug)).toContain('run-server');
  });

  it('does not route topics the served pages do not cover', () => {
    expect(matchDocsSections('endpoint listen port 7091').map((s) => s.slug)).not.toContain('run-server');
    expect(matchDocsSections('sync sync-roles').map((s) => s.slug)).not.toContain('cli');
    expect(matchDocsSections('docs maturity documentation maturity').map((s) => s.slug)).not.toContain('faq');
  });

  it('routes saved-seat lifecycle and recovery topics to the dedicated guide', () => {
    expect(matchDocsSections('seat reattach recovery')[0]?.slug).toBe('seat-lifecycle');
    expect(matchDocsSections('reset-local-connection').map((s) => s.slug)).toContain('seat-lifecycle');
    expect(matchDocsSections('duplicate inbox monitor').map((s) => s.slug)).toContain('seat-lifecycle');
    expect(matchDocsSections('evicted seat').map((s) => s.slug)).toContain('seat-lifecycle');
  });

  it('keeps the seat-lifecycle recovery copy aligned with the shipped formatters', () => {
    const docs = readFileSync(new URL('../docs/SEAT_LIFECYCLE.md', import.meta.url), 'utf8');
    const monitorRefusal = formatSeatReattachRefusal(
      { pid: 123, heartbeat: 'fresh' },
      'borg assimilate --here --force',
    ).replace('123', '<pid>').trim();
    expect(docs).toContain(monitorRefusal);
    expect(docs).toContain(reattachOnlyRefusal({ kind: 'no-identity' }, '<cube>'));
    expect(docs).toContain(reattachOnlyRefusal(
      { kind: 'different-cube', activeCubeName: '<active-cube>' },
      '<requested-cube>',
    ));
    expect(docs).toContain(reattachFailureMessage({ message: '<server-error>' }));
  });

  it('server keywords do not hijack established topics (CR 8b474dc2 reciprocal-substring pins)', () => {
    expect(matchDocsSections('prune')[0]?.slug).toBe('cli');
    expect(matchDocsSections('prune').map((s) => s.slug)).not.toContain('run-server');
    expect(matchDocsSections('reporting')[0]?.slug).toBe('faq');
    expect(matchDocsSections('reporting').map((s) => s.slug)).not.toContain('run-server');
    expect(matchDocsSections('plan the sprint').map((s) => s.slug)).not.toContain('run-server');
  });

  it('borg_docs is registered with the optional topic param', () => {
    const tool = TOOL_MANIFEST.find((t) => t.name === 'borg_docs');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('topic');
    expect(tool!.inputSchema.required ?? []).not.toContain('topic');
  });

  it('formatDocsIndex renders title + summary + url for every section', () => {
    const out = formatDocsIndex(DOCS_SECTIONS);
    for (const s of DOCS_SECTIONS) {
      expect(out).toContain(s.title);
      expect(out).toContain(s.url);
    }
  });
});
