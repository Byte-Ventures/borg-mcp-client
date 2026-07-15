import { describe, it, expect } from 'vitest';
import { DOCS_SECTIONS, matchDocsSections, formatDocsIndex } from '../src/docs-sections';
import { TOOL_MANIFEST } from '../src/tool-manifest';

describe('gh#docs-site B — DOCS_SECTIONS + borg_docs', () => {
  it('every section is well-formed (slug/title/url/summary/keywords; url under borgmcp.ai/docs)', () => {
    expect(DOCS_SECTIONS.length).toBeGreaterThan(0);
    for (const s of DOCS_SECTIONS) {
      expect(s.slug).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.summary.trim().length).toBeGreaterThan(0);
      expect(s.url).toMatch(/^https:\/\/borgmcp\.ai\/docs/);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });

  it('each URL matches its page file (index → /docs, X → /docs/X)', () => {
    for (const s of DOCS_SECTIONS) {
      const expected =
        s.page === 'index' ? 'https://borgmcp.ai/docs' : `https://borgmcp.ai/docs/${s.page}`;
      expect(s.url).toBe(expected);
    }
  });

  it('matchDocsSections routes common topics to the right section', () => {
    expect(matchDocsSections('pricing')).toEqual([]);
    expect(matchDocsSections('install borgmcp')[0]?.slug).toBe('install');
    expect(matchDocsSections('opencode install').map((s) => s.slug)).toContain('install');
    expect(matchDocsSections('worktree')[0]?.slug).toBe('cli');
    expect(matchDocsSections('worktree cleanup')[0]?.slug).toBe('cli');
    expect(matchDocsSections('setup assimilate')).toEqual([]);
    expect(matchDocsSections('billing cancel subscription')).toEqual([]);
    expect(matchDocsSections('what is a cube').map((s) => s.slug)).toContain('concepts');
    expect(matchDocsSections('codex').map((s) => s.slug)).toContain('faq');
    expect(matchDocsSections('zzzznotarealtopic')).toEqual([]);
    expect(matchDocsSections('')).toEqual([]);
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
