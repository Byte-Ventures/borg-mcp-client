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
export declare const DOCS_BASE_URL = "https://github.com/Byte-Ventures/borg-mcp-client";
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
export declare const DOCS_SECTIONS: DocsSection[];
/**
 * Lazy topic match: a section matches when the topic shares a whitespace token
 * with the section's slug / title / summary / keywords (case-insensitive,
 * substring both ways so "price"↔"pricing"). Returns matches ranked by hit
 * count; empty when nothing matches (the caller then shows the full index).
 */
export declare function matchDocsSections(topic: string): DocsSection[];
/** Render sections as a plain-text index (title — summary — URL per line). */
export declare function formatDocsIndex(sections: DocsSection[]): string;
//# sourceMappingURL=docs-sections.d.ts.map