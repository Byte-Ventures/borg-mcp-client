/**
 * The single source for the in-product docs index.
 *
 * `borg_docs` (index.ts) returns these sections so an agent can route a "how
 * does borgmcp work / setup / concept / tool" question to the right
 * repository-local document, then WebFetch the URL for the content. Pure data +
 * a lazy keyword match — NO server-side fetch, NO RAG/embeddings.
 *
 * This is a local-only client: every URL points at the public source repository
 * (its README + `docs/`), never a hosted product site.
 *
 * `page` is the repository-local file each section maps to (anti-drift anchor).
 */

export const DOCS_BASE_URL = "https://github.com/Byte-Ventures/borg-mcp-client";

const README_URL = `${DOCS_BASE_URL}#readme`;
const LOCAL_SERVER_URL = `${DOCS_BASE_URL}/blob/main/docs/LOCAL_SERVER.md`;

export interface DocsSection {
  /** logical topic key */
  slug: string;
  title: string;
  /** repository-local document URL the agent should WebFetch */
  url: string;
  /** the repository file this section maps to (anti-drift anchor) */
  page: string;
  summary: string;
  /** extra match terms for the topic lookup */
  keywords: string[];
}

export const DOCS_SECTIONS: DocsSection[] = [
  {
    slug: "overview",
    title: "Overview",
    url: README_URL,
    page: "README.md",
    summary: "What Borg MCP is + the cube / drone / role / log mental model.",
    keywords: ["overview", "what is", "intro", "mental model", "how it works", "start"],
  },
  {
    slug: "concepts",
    title: "Core concepts",
    url: README_URL,
    page: "README.md",
    summary: "Cubes, drones, roles, the activity log + signals, claims, decisions.",
    keywords: ["cube", "drone", "role", "log", "signal", "claim", "decision", "coordinate", "coordination"],
  },
  {
    slug: "install",
    title: "Install client",
    url: README_URL,
    page: "README.md",
    summary: "Install the published Borg MCP client and verify the borg CLI.",
    keywords: ["install", "installation", "npm", "client", "borgmcp", "borg help", "claude code", "codex", "opencode"],
  },
  {
    slug: "run-server",
    title: "Run server",
    url: LOCAL_SERVER_URL,
    page: "docs/LOCAL_SERVER.md",
    summary: "Run a self-hosted borgmcp-server: setup, start, endpoint, network configuration.",
    keywords: ["server", "self-hosted", "borgmcp-server", "borg-mcp-server", "setup", "start", "listen port", "7091", "local server", "--lan", "tls"],
  },
  {
    slug: "enroll",
    title: "Enroll",
    url: LOCAL_SERVER_URL,
    page: "docs/LOCAL_SERVER.md",
    summary: "Connect a client to a self-hosted server: invitations, assimilate --host --enroll, credentials.",
    keywords: ["enroll", "enrollment", "invitation", "invite", "assimilate", "--host", "credential", "credentials", "owner", "join server"],
  },
  {
    slug: "self-hosting",
    title: "Self-hosting operations",
    url: LOCAL_SERVER_URL,
    page: "docs/LOCAL_SERVER.md",
    summary: "Operate a self-hosted server: data directory, credential rotation and grants, capacity, backup, upgrades.",
    keywords: ["self-hosting", "operations", "operate", "backup", "restore", "upgrade", "rotate", "revoke", "grant", "capacity", "data directory", "license"],
  },
  {
    slug: "cli",
    title: "CLI commands",
    url: README_URL,
    page: "README.md",
    summary: "Client launch, sync, cleanup, worktree maintenance, and launch-all reference.",
    keywords: ["cli", "command", "sync", "cleanup", "worktree", "launch", "launch-all", "terminal", "maintenance", "prune"],
  },
  {
    slug: "tools",
    title: "Tool reference",
    url: README_URL,
    page: "README.md",
    summary: "Every borg_* tool — name, description, params.",
    keywords: ["tool", "tools", "api", "reference", "param", "borg_"],
  },
  {
    slug: "faq",
    title: "FAQ",
    url: README_URL,
    page: "README.md",
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
