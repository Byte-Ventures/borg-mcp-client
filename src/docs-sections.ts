/**
 * The single source for the in-product docs index.
 *
 * `borg_docs` (index.ts) returns these sections so an agent can route a "how
 * does borgmcp work / setup / concept / tool" question to the right
 * public documentation page, then WebFetch the URL for the content. Pure data +
 * a lazy keyword match — NO server-side fetch, NO RAG/embeddings.
 *
 * Most topics route to borgmcp.ai; repository-resident operator detail routes
 * to the public source repository.
 */

const SITE_URL = "https://borgmcp.ai";
const REPOSITORY_URL = "https://github.com/Byte-Ventures/borg-mcp-client";
const SEAT_LIFECYCLE_URL = `${REPOSITORY_URL}/blob/main/docs/SEAT_LIFECYCLE.md`;

export interface DocsSection {
  /** logical topic key */
  slug: string;
  title: string;
  /** public documentation URL the agent should WebFetch */
  url: string;
  summary: string;
  /** extra match terms for the topic lookup */
  keywords: string[];
}

export const DOCS_SECTIONS: DocsSection[] = [
  {
    slug: "overview",
    title: "Overview",
    url: `${SITE_URL}/docs/`,
    summary: "What Borg MCP is + the cube / drone / role / log mental model.",
    keywords: ["overview", "what is", "intro", "mental model", "how it works", "start"],
  },
  {
    slug: "concepts",
    title: "Core concepts",
    url: `${SITE_URL}/docs/concepts/`,
    summary: "Cubes, drones, roles, the activity log + signals, claims, decisions.",
    keywords: ["cube", "drone", "role", "log", "signal", "claim", "decision", "coordinate", "coordination"],
  },
  {
    slug: "install",
    title: "Install client",
    url: `${SITE_URL}/get-started/`,
    summary: "Install the published Borg MCP client and verify the borg CLI.",
    keywords: ["install", "installation", "npm", "client", "borgmcp", "borg help", "claude code", "codex", "opencode"],
  },
  {
    slug: "run-server",
    title: "Run server",
    url: `${SITE_URL}/docs/run-server/`,
    summary: "Run a self-hosted borgmcp-server: setup, start, endpoint, network configuration.",
    keywords: ["server", "self-hosted", "borgmcp-server", "borg-mcp-server", "setup", "start", "listen port", "7091", "local server", "--lan", "tls"],
  },
  {
    slug: "enroll",
    title: "Enroll",
    url: `${SITE_URL}/docs/security/`,
    summary: "Connect a client to a self-hosted server: invitations, assimilate --host --enroll, credentials.",
    keywords: ["enroll", "enrollment", "invitation", "invite", "assimilate", "--host", "credential", "credentials", "owner", "join server", "add agent", "teammate"],
  },
  {
    slug: "seat-lifecycle",
    title: "Seat lifecycle and recovery",
    url: SEAT_LIFECYCLE_URL,
    summary: "Saved-seat states, re-attach and reset recovery, duplicate-session guards, and deterministic multi-seat selection.",
    keywords: ["seat", "lifecycle", "reattach", "re-attach", "reset-local-connection", "evicted", "revoked", "superseded", "inbox monitor", "multiple seats", "silent deafness"],
  },
  {
    slug: "self-hosting",
    title: "Self-hosting operations",
    url: `${SITE_URL}/docs/self-hosting/`,
    summary: "Operate a self-hosted server: data directory, credential rotation and grants, capacity, backup, upgrades.",
    keywords: ["self-hosting", "operations", "operate", "backup", "restore", "upgrade", "rotate", "revoke", "grant", "capacity", "data directory", "dashboard", "monitoring", "observability"],
  },
  {
    slug: "cli",
    title: "CLI commands",
    url: `${SITE_URL}/docs/cli/`,
    summary: "Client launch, sync, cleanup, worktree maintenance, and launch-all reference.",
    keywords: ["cli", "command", "sync", "cleanup", "worktree", "launch", "launch-all", "terminal", "maintenance", "prune"],
  },
  {
    slug: "tools",
    title: "Tool reference",
    url: `${SITE_URL}/docs/tools/`,
    summary: "Every borg_* tool — name, description, params.",
    keywords: ["tool", "tools", "api", "reference", "param", "borg_"],
  },
  {
    slug: "faq",
    title: "FAQ",
    url: `${SITE_URL}/docs/faq/`,
    summary: "Common questions — agents, coordination, worktrees, docs maturity, security.",
    keywords: ["faq", "question", "agent", "claude", "codex", "opencode", "coordination", "worktree", "security", "reporting", "second agent", "pricing", "cost", "free"],
  },
  {
    slug: "license",
    title: "License",
    url: `${SITE_URL}/docs/license/`,
    summary: "Licenses for the client, shared contracts, and self-hosted server.",
    keywords: ["license", "licensing", "apache", "fsl", "source available"],
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
