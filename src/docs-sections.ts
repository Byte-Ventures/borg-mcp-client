/**
 * gh#docs-site phase B — the single source for the in-product docs index.
 *
 * `borg_docs` (index.ts) returns these sections so an agent can route a "how
 * does borgmcp work / pricing / setup" question to the right page, then WebFetch
 * the URL for the content. Pure data + a lazy keyword match — NO server-side
 * fetch, NO RAG/embeddings.
 *
 * `page` is the public documentation slug each section maps to.
 */

export const DOCS_BASE_URL = "https://borgmcp.ai/docs";

export interface DocsSection {
  /** logical topic key */
  slug: string;
  title: string;
  /** public page URL the agent should WebFetch */
  url: string;
  /** the docs/<page>.astro file this section maps to (anti-drift anchor) */
  page: string;
  summary: string;
  /** extra match terms for the topic lookup */
  keywords: string[];
}

export const DOCS_SECTIONS: DocsSection[] = [
  {
    slug: "overview",
    title: "Overview",
    url: `${DOCS_BASE_URL}`,
    page: "index",
    summary: "What Borg MCP is + the cube / drone / role / log mental model.",
    keywords: ["overview", "what is", "intro", "mental model", "how it works", "start"],
  },
  {
    slug: "concepts",
    title: "Core concepts",
    url: `${DOCS_BASE_URL}/concepts`,
    page: "concepts",
    summary: "Cubes, drones, roles, the activity log + signals, claims, decisions.",
    keywords: ["cube", "drone", "role", "log", "signal", "claim", "decision", "coordinate", "coordination"],
  },
  {
    slug: "install",
    title: "Install client",
    url: `${DOCS_BASE_URL}/install-client`,
    page: "install-client",
    summary: "Install the published Borg MCP client and verify the borg CLI.",
    keywords: ["install", "installation", "npm", "client", "borgmcp", "borg help", "claude code", "codex", "opencode"],
  },
  {
    slug: "cli",
    title: "CLI commands",
    url: `${DOCS_BASE_URL}/cli`,
    page: "cli",
    summary: "Client launch, sync, cleanup, worktree maintenance, and launch-all reference.",
    keywords: ["cli", "command", "sync", "cleanup", "worktree", "launch", "launch-all", "terminal", "maintenance", "prune"],
  },
  {
    slug: "tools",
    title: "Tool reference",
    url: `${DOCS_BASE_URL}/tools`,
    page: "tools",
    summary: "Every borg_* tool — name, description, params (auto-generated).",
    keywords: ["tool", "tools", "api", "reference", "param", "borg_"],
  },
  {
    slug: "faq",
    title: "FAQ",
    url: `${DOCS_BASE_URL}/faq`,
    page: "faq",
    summary: "Common questions — agents, coordination, worktrees, docs maturity, security.",
    keywords: ["faq", "question", "agent", "claude", "codex", "opencode", "coordination", "worktree", "security", "reporting", "second agent"],
  },
];

/**
 * Lazy topic match: a section matches when the topic shares a whitespace token
 * with the section's slug / title / summary / keywords (case-insensitive,
 * substring both ways so "price"↔"pricing"). Returns matches ranked by hit
 * count; empty when nothing matches (the caller then shows the full index).
 */
export function matchDocsSections(topic: string): DocsSection[] {
  const tokens = topic.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const scored = DOCS_SECTIONS.map((s) => {
    const haystack = [s.slug, s.title, s.summary, ...s.keywords].join(" ").toLowerCase();
    const hits = tokens.filter((t) => haystack.includes(t) || s.keywords.some((k) => t.includes(k))).length;
    return { s, hits };
  }).filter((x) => x.hits > 0);
  scored.sort((a, b) => b.hits - a.hits);
  return scored.map((x) => x.s);
}

/** Render sections as a plain-text index (title — summary — URL per line). */
export function formatDocsIndex(sections: DocsSection[]): string {
  return sections.map((s) => `- ${s.title} — ${s.summary}\n  ${s.url}`).join("\n");
}
